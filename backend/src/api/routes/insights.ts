import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { files, opLogs, projects, roles, teamMembers, teams, users } from '../../db/schema.js';
import { requireTeamAccess } from '../../domain/authorize.js';
import { buildProjectCards, queryProjects } from '../../domain/project-stats.js';
import { PROJECT_STAGES, STAGE_LABELS, type ProjectStage } from '../../domain/workflow.js';
import { env } from '../../env.js';
import { badRequest } from '../../lib/errors.js';
import { storage } from '../../storage/index.js';
import { requireAuth, requireSiteAdmin } from '../guards.js';

/**
 * 工作台、团队动态与存储用量。
 *
 * 「团队动态」这一份数据同时承担两个用途：工作台右栏的「最近发生了什么」，
 * 以及第七节里说的「跨环节通知」。这里**不另立事件表** ——
 * 直接由操作日志派生。理由：通知与动态需要的字段（谁、什么时候、
 * 对哪个作品做了什么）操作日志本来就有；再建一张表就要维护两份写入，
 * 而漏写其中一份是迟早的事。
 */

type ActivityKind = 'create' | 'upload' | 'update' | 'delete' | 'member' | 'publish' | 'other';

type ActivityItem = {
  id: number;
  action: string;
  kind: ActivityKind;
  /** 已经渲染成句子的中文描述 */
  text: string;
  targetType: string;
  targetId: string;
  teamId: string | null;
  teamName: string | null;
  actor: { id: string | null; displayName: string } | null;
  createdAt: string;
};

/**
 * 动作 → 人话。
 *
 * 放在后端渲染而不是让前端查表：动作名会随功能增加，
 * 前端查表意味着每加一个动作就要发一次前端版本，而漏加的那条
 * 在界面上会显示成 `project_set.create` 这种原始字符串。
 *
 * ⚠️ **加一个 logOp 调用，就要在这里补一条。** 这条规则没有自动化保证，
 * 唯一的兜底是下面那个 fallback —— 它会尽量把动作名说成人话，
 * 但「对「XX」执行了 target.delete」终究不如「删除了目标语言」清楚。
 * 判据很简单：界面上一旦出现带点号的英文动作名，就是这里漏了。
 */
function describe(action: string, targetName: string, detail: Record<string, unknown>): { text: string; kind: ActivityKind } {
  const name = targetName ? `「${targetName}」` : '';

  const map: Record<string, { text: string; kind: ActivityKind }> = {
    // ── 团队 ──
    'team.create': { text: `创建了团队${name}`, kind: 'create' },
    'team.update': { text: `更新了团队${name}的资料`, kind: 'update' },
    'team.delete': { text: `解散了团队${name}`, kind: 'delete' },
    'team.member.add': { text: `把成员加入了团队${name}`, kind: 'member' },
    'team.member.remove': { text: `把成员移出了团队${name}`, kind: 'member' },
    'team.member.change_role': {
      text: `调整了团队${name}中成员的角色：${String(detail.from ?? '')} → ${String(detail.to ?? '')}`,
      kind: 'member',
    },
    'team.role.create': { text: `在团队${name}里新建了角色`, kind: 'create' },
    'team.role.update': { text: `修改了团队${name}的角色`, kind: 'update' },
    'team.role.delete': { text: `删除了团队${name}的角色`, kind: 'delete' },

    // ── 邀请码 ──
    'invite.create': { text: `为团队${name}生成了邀请码`, kind: 'member' },
    'invite.delete': { text: `删除了团队${name}的一个邀请码`, kind: 'delete' },
    'user.register': { text: `通过邀请码加入了团队${name}`, kind: 'member' },

    // ── 作品集与作品 ──
    'project_set.create': { text: `新建了作品集${name}`, kind: 'create' },
    'project_set.update': { text: `更新了作品集${name}`, kind: 'update' },
    'project_set.delete': { text: `删除了作品集${name}`, kind: 'delete' },
    'project.create': { text: `新建了作品${name}`, kind: 'create' },
    'project.update': { text: `更新了作品${name}的资料`, kind: 'update' },
    'project.archive': { text: `把作品${name}结项归档`, kind: 'update' },
    'project.delete': { text: `删除了作品${name}`, kind: 'delete' },

    // ── 作品成员 ──
    'project.member.add': {
      text: `把成员加入了作品${name}${detail.role ? `（${String(detail.role)}）` : ''}`,
      kind: 'member',
    },
    'project.member.change_role': {
      text: `调整了作品${name}中成员的角色：${String(detail.from ?? '')} → ${String(detail.to ?? '')}`,
      kind: 'member',
    },
    'project.member.remove': { text: `把成员移出了作品${name}`, kind: 'member' },

    // ── 图片 ──
    'file.upload': { text: `向作品${name}上传了 ${Number(detail.count ?? 0)} 张图片`, kind: 'upload' },
    'file.rename': { text: `重命名了作品${name}中的图片`, kind: 'update' },
    'file.delete': { text: `删除了作品${name}中的一张图片`, kind: 'delete' },
    'file.batch_delete': {
      text: `删除了作品${name}中的 ${Number(detail.count ?? 0)} 张图片`,
      kind: 'delete',
    },

    // ── 目标语言 ──
    'target.add': { text: `为作品${name}新增了目标语言`, kind: 'create' },
    'target.change': { text: `修改了作品${name}的目标语言`, kind: 'update' },
    'target.delete': { text: `删除了作品${name}的一个目标语言`, kind: 'delete' },

    // ── 站点后台（一般不带 teamId，不会进团队动态；列在这里是为了不漏网）──
    'admin.settings.update': { text: '更新了站点设置', kind: 'update' },
    'admin.user.create': { text: `创建了用户${name}`, kind: 'create' },
    'admin.user.update': { text: `更新了用户${name}`, kind: 'update' },
    'admin.user.reset_password': { text: `重置了用户${name}的密码`, kind: 'update' },
    'admin.user.deactivate': { text: `注销了用户${name}`, kind: 'delete' },
    'admin.notice.create': { text: `发布了公告${name}`, kind: 'create' },
    'admin.notice.update': { text: `修改了公告${name}`, kind: 'update' },
    'admin.notice.delete': { text: `删除了公告${name}`, kind: 'delete' },
    'user.change_password': { text: '修改了登录密码', kind: 'update' },
  };

  const hit = map[action];
  if (hit) return hit;

  // 兜底：把 `project.foo_bar` 说成「project 的 foo bar」总比原样吐出去强。
  const humanized = action.replace(/[._]/g, ' ');
  return { text: `对${name || '内容'}执行了操作：${humanized}`, kind: 'other' };
}

export async function registerInsightRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 前端需要的服务端参数。
   *
   * 让前端**问服务端**而不是自己写死：图片大小上限这类数字一旦在两边各写一份，
   * 迟早会出现「前端放行、后端拒绝」的不一致 —— 而且那种错误用户看到的是
   * 一个语焉不详的 413，最难排查。
   */
  app.get('/client-config', async (request) => {
    await requireAuth(request);
    return {
      maxImageMb: env.MAX_IMAGE_MB,
      thumbSize: env.THUMB_SIZE,
      previewSize: env.PREVIEW_SIZE,
      storageDriver: storage.id,
    };
  });

  /**
   * 工作台。需求里「登录后基于职务进入工作」的落点：
   * 不靠权限墙，靠**默认只列我参与的团队的作品** + 每张卡给出一个明确的下一步。
   */
  app.get('/workbench', async (request) => {
    const user = await requireAuth(request);

    const query = z
      .object({
        teamId: z.string().uuid().optional(),
        stage: z.enum(PROJECT_STAGES).optional(),
        mine: z.coerce.boolean().optional(),
        keyword: z.string().trim().max(60).optional(),
        status: z.enum(['active', 'archived']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .safeParse(request.query);
    if (!query.success) throw badRequest(query.error.issues[0]?.message ?? '参数不合法');
    const opts = query.data;

    if (opts.teamId) await requireTeamAccess(opts.teamId, user);

    // 我所在的团队。工作台只在这里面找作品 —— 不是「隐藏」，而是
    // 后端根本不返回不属于我的团队的记录（前端过滤永远只是体验层的）。
    const myTeamRows = await db
      .select({ teamId: teamMembers.teamId, teamName: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.userId, user.id));

    const myTeamIds = opts.teamId ? [opts.teamId] : myTeamRows.map((r) => r.teamId);

    if (myTeamIds.length === 0) {
      return {
        projects: [],
        teams: [],
        counts: Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])),
        stages: PROJECT_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
      };
    }

    const rows = await queryProjects({
      teamIds: myTeamIds,
      status: opts.status ?? 'active',
      ...(opts.keyword ? { keyword: opts.keyword } : {}),
      limit: opts.limit,
    });

    let cards = await buildProjectCards(rows, user.id);

    if (opts.mine) {
      // 「我参与的」= 我在作品成员表里，**或者**我的团队角色带 auto_project_admin
      // （团队管理员即便没被显式加进作品，也是在负责这些作品的）。
      const adminRows = await db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .innerJoin(roles, eq(roles.id, teamMembers.roleId))
        .where(and(eq(teamMembers.userId, user.id), eq(roles.autoProjectAdmin, true)));
      const adminTeamIds = new Set(adminRows.map((r) => r.teamId));
      cards = cards.filter((c) => c.myRole !== null || adminTeamIds.has(c.teamId));
    }

    // 计数在**档位过滤之前**统计：点进「校对中」之后，
    // 其他 chips 上的数字若全变成 0，就没法再点回去了。
    const counts = Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])) as Record<ProjectStage, number>;
    for (const card of cards) counts[card.stage] += 1;

    if (opts.stage) cards = cards.filter((c) => c.stage === opts.stage);

    return {
      projects: cards,
      teams: myTeamRows.map((r) => ({ id: r.teamId, name: r.teamName })),
      counts,
      stages: PROJECT_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
    };
  });

  /** 团队动态（`/activity?teamId=`）或我的跨团队动态（不带参数）。 */
  app.get('/activity', async (request) => {
    const user = await requireAuth(request);

    const query = z
      .object({
        teamId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(request.query);
    if (!query.success) throw badRequest(query.error.issues[0]?.message ?? '参数不合法');

    let teamIds: string[];
    let teamNames = new Map<string, string>();

    if (query.data.teamId) {
      const access = await requireTeamAccess(query.data.teamId, user);
      teamIds = [access.team.id];
      teamNames.set(access.team.id, access.team.name);
    } else {
      const rows = await db
        .select({ teamId: teamMembers.teamId, teamName: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(eq(teamMembers.userId, user.id));
      teamIds = rows.map((r) => r.teamId);
      teamNames = new Map(rows.map((r) => [r.teamId, r.teamName]));
    }

    if (teamIds.length === 0) return { activity: [] };

    const rows = await db
      .select({
        id: opLogs.id,
        action: opLogs.action,
        targetType: opLogs.targetType,
        targetId: opLogs.targetId,
        targetName: opLogs.targetName,
        teamId: opLogs.teamId,
        detail: opLogs.detail,
        createdAt: opLogs.createdAt,
        actorId: opLogs.actorId,
        actorName: users.displayName,
      })
      .from(opLogs)
      .leftJoin(users, eq(users.id, opLogs.actorId))
      .where(inArray(opLogs.teamId, teamIds))
      .orderBy(desc(opLogs.id))
      .limit(query.data.limit);

    const activity: ActivityItem[] = rows.map((row) => {
      const detail = (row.detail ?? {}) as Record<string, unknown>;
      const { text, kind } = describe(row.action, row.targetName, detail);
      return {
        id: row.id,
        action: row.action,
        kind,
        text,
        targetType: row.targetType,
        targetId: row.targetId,
        teamId: row.teamId,
        teamName: row.teamId ? (teamNames.get(row.teamId) ?? null) : null,
        actor: row.actorId ? { id: row.actorId, displayName: row.actorName ?? '[已注销]' } : null,
        createdAt: row.createdAt.toISOString(),
      };
    });

    return { activity };
  });

  /**
   * 站点级存储用量。走驱动的真实遍历（含磁盘余量），
   * 与团队用量（走数据库求和）刻意分开：一个是「磁盘还剩多少」，
   * 一个是「我们用了多少」，两个问题口径不同，答案也不该混在一起。
   */
  app.get('/admin/storage-usage', async (request) => {
    await requireSiteAdmin(request);

    const usage = await storage.usage();

    const byTeam = await db
      .select({
        teamId: files.teamId,
        teamName: teams.name,
        fileCount: sql<number>`COUNT(*)`,
        bytes: sql<number>`COALESCE(SUM(${files.size}), 0)`,
      })
      .from(files)
      .innerJoin(teams, eq(teams.id, files.teamId))
      .where(isNull(files.deletedAt))
      .groupBy(files.teamId, teams.name)
      .orderBy(desc(sql`COALESCE(SUM(${files.size}), 0)`));

    const [projectTotals] = await db
      .select({ total: sql<number>`COUNT(*)` })
      .from(projects);

    return {
      driver: storage.id,
      disk: {
        usedBytes: usage.usedBytes,
        totalBytes: usage.totalBytes,
        availableBytes: usage.availableBytes,
        objectCount: usage.objectCount,
        elapsedMs: usage.elapsedMs,
      },
      byTeam: byTeam.map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        fileCount: Number(r.fileCount),
        bytes: Number(r.bytes),
      })),
      projectCount: Number(projectTotals?.total ?? 0),
    };
  });
}
