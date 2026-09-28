import { and, eq, isNull } from 'drizzle-orm';
import { db, type DbLike } from '../db/client.js';
import {
  fileCredits,
  notifications,
  projectMembers,
  projectRolePermissions,
  projectRoles,
  projects,
  roles,
  teamMembers,
} from '../db/schema.js';
import type { FileState } from './workflow.js';

/**
 * 个人通知 —— 把「上游做完了」这件事送到**下一环节的人**手上。
 *
 * 需求里那句「全程工作人员确认后的状态，用于统计、筛选与下游通知」，
 * 落到实现上就是这里的 `resolveStageHandlers()`：不问「谁在线」，
 * 而是问「按这台机器上的记录，这一步该谁接」。
 *
 * 与站内公告（`notices`）刻意分成两张表：公告是广播、对所有人都有意义、
 * 已读按人一行；通知是投递、只对一个人有意义。混在一起会让
 * 「未读数」变成两种口径的叠加，谁也不清楚那个数字到底在数什么。
 */

export type NotifyInput = {
  userIds: readonly string[];
  kind: string;
  title: string;
  body?: string;
  teamId?: string | null;
  projectId?: string | null;
  fileId?: string | null;
  actorId?: string | null;
};

/** 投递通知。返回实际写入的条数。**自己操作不通知自己**。 */
export async function notify(input: NotifyInput, tx: DbLike = db): Promise<number> {
  const targets = [...new Set(input.userIds)].filter((id) => id && id !== input.actorId);
  if (targets.length === 0) return 0;

  await tx.insert(notifications).values(
    targets.map((userId) => ({
      userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      teamId: input.teamId ?? null,
      projectId: input.projectId ?? null,
      fileId: input.fileId ?? null,
      actorId: input.actorId ?? null,
    })),
  );

  return targets.length;
}

/** 状态 → 下一个环节「该谁接」所需的作品权限码。 */
const NEXT_STAGE_PERMISSION: Partial<Record<FileState, string>> = {
  translated: 'tra.proofread',
  proofread: 'file.typeset',
  typeset: 'publish.approve',
};

/** 状态 → 该环节在署名台账里的角色名（优先找已经挂在这个角色上的人）。 */
const NEXT_STAGE_CREDIT_ROLE: Partial<Record<FileState, string>> = {
  translated: 'proofreader',
  proofread: 'typesetter',
  typeset: 'supervisor',
};

const STAGE_TEXT: Partial<Record<FileState, { title: string; body: string }>> = {
  translated: { title: '有图片翻译完成，等待校对', body: '翻译已完成，可以开始校对了。' },
  proofread: { title: '有图片校对完成，等待嵌字', body: '校对已通过，可以导出并开始嵌字了。' },
  typeset: { title: '有图片嵌字完成，等待发布', body: '成品已回传，可以准备发布了。' },
};

/**
 * 找出某个文件进入某状态时，**应该被通知的人**。
 *
 * 解析顺序**先具体后宽泛，且命中即止**：
 *   1. 这张图在署名台账里挂着下一环节角色的人 —— 责任已经落到具体人头上了；
 *   2. 作品成员里持有下一环节权限的人 —— 没点名时，由「有权限做这件事的人」接；
 *   3. 团队里会自动成为作品管理员的人 —— 前两层都空时的兜底。
 *
 * 「命中即止」很要紧。第一版把三层的结果**并集**起来，结果是：
 * 作品创建人因为默认拥有全部权限，于是每一张图每一次推进都会给他发一条
 * 通知 —— 而这恰恰是他最不需要的（他要的是「别人卡住了」才被叫）。
 * 一旦某个环节已经点名到人，就该只找那个人。
 *
 * 刻意**不做**「通知全团队」：一条「该嵌字了」发给三十个人，等于没发。
 */
export async function resolveStageHandlers(
  fileId: string,
  projectId: string,
  to: FileState,
  tx: DbLike = db,
): Promise<string[]> {
  const creditRole = NEXT_STAGE_CREDIT_ROLE[to];
  const permission = NEXT_STAGE_PERMISSION[to];
  if (!creditRole && !permission) return [];

  // ① 文件上点名的负责人
  if (creditRole) {
    const credited = await tx
      .select({ userId: fileCredits.userId })
      .from(fileCredits)
      .where(and(eq(fileCredits.fileId, fileId), eq(fileCredits.role, creditRole)));
    const named = credited.map((r) => r.userId).filter((id): id is string => Boolean(id));
    if (named.length > 0) return [...new Set(named)];
  }

  // ② 作品里持有该环节权限的人
  if (permission) {
    const holders = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(projectRoles, eq(projectRoles.id, projectMembers.projectRoleId))
      .innerJoin(projectRolePermissions, eq(projectRolePermissions.projectRoleId, projectRoles.id))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectRolePermissions.permissionCode, permission),
        ),
      );
    const capable = [...new Set(holders.map((r) => r.userId))];
    if (capable.length > 0) return capable;
  }

  // ③ 兜底：作品里没有任何人持有该权限时，退到团队管理员。
  // 没有这一层的话，「该嵌字了」这句话没人听得到 —— 任务静静躺在那里，
  // 而所有人都以为别人看到了。
  const projectRows = await tx
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const teamId = projectRows[0]?.teamId;
  if (!teamId) return [];

  const admins = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(roles, eq(roles.id, teamMembers.roleId))
    .where(and(eq(teamMembers.teamId, teamId), eq(roles.autoProjectAdmin, true)));

  return [...new Set(admins.map((r) => r.userId))];
}

/** 投递「进入下一环节」的通知，文案与收件人都在这里定，调用方只管调用。 */
export async function notifyStageEntered(
  input: {
    fileId: string;
    projectId: string;
    teamId: string;
    projectName: string;
    to: FileState;
    actorId: string;
    actorName: string;
  },
  tx: DbLike = db,
): Promise<number> {
  const template = STAGE_TEXT[input.to];
  if (!template) return 0;

  const userIds = await resolveStageHandlers(input.fileId, input.projectId, input.to, tx);
  if (userIds.length === 0) return 0;

  return notify(
    {
      userIds,
      kind: `stage.entered_${input.to}`,
      title: template.title,
      body: `${input.actorName} 把作品「${input.projectName}」里的一张图推进到了「${input.to}」。${template.body}`,
      teamId: input.teamId,
      projectId: input.projectId,
      fileId: input.fileId,
      actorId: input.actorId,
    },
    tx,
  );
}

/** 未读数（铃铛的红点）。 */
export async function unreadNotificationCount(userId: string, tx: DbLike = db): Promise<number> {
  const rows = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows.length;
}
