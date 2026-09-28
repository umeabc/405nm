import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { fileCredits, files, notifications, teamMembers, users } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission } from '../../domain/authorize.js';
import {
  CREDIT_ROLE_LABELS,
  CREDIT_ROLES,
  creditsForFiles,
  isCreditRole,
  replaceCredits,
  summarizeCredits,
} from '../../domain/credits.js';
import { stateHistory, transitionFile, translationCompleteness } from '../../domain/file-state.js';
import { FILE_STATES, PROJECT_STAGES, STAGE_LABELS, type FileState } from '../../domain/workflow.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { loadAccessibleFile, parseOrThrow } from '../file-access.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 状态流转、署名与个人通知。
 *
 * 这三件事放在一个文件里，是因为它们其实是**同一个动作的三个面**：
 * 有人把一张图推进到「已翻译」→ 署名记下他是翻译 → 通知发给该校对的人。
 * 分成三个文件之后，「推进状态」这个动作就要跨文件调用，
 * 而跨文件的调用链最容易在加新状态时漏掉某一环（比如记了状态忘了通知）。
 */

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });

const transitionSchema = z.object({
  to: z.enum(FILE_STATES),
  note: z.string().trim().max(500).optional(),
});

const creditsSchema = z.object({
  role: z.enum(CREDIT_ROLES),
  entries: z
    .array(
      z.object({
        userId: z.string().uuid().nullish(),
        displayName: z.string().trim().max(40).optional(),
        /** 界面传用户名时用它解析成 userId（比让人肉找 uuid 现实） */
        username: z.string().trim().max(32).optional(),
      }),
    )
    .max(20),
});

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  // ── 状态流转 ──────────────────────────────────────────────

  /**
   * 推进/回退一张图的状态。
   *
   * **显式动作**：哪怕译文已经写满，也不会有人替你把状态推上去 ——
   * 「完成」是判断，不是推断。校验（译文是否齐全、前置条件是否满足）
   * 都在 domain/file-state.ts 里，这里只负责鉴权与审计。
   */
  app.post('/files/:id/state', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user);

    const body = parseOrThrow(transitionSchema, request.body);

    const result = await db.transaction(async (tx) =>
      transitionFile(
        {
          fileId,
          to: body.to as FileState,
          note: body.note ?? '',
          access,
          actorId: user.id,
          actorName: user.displayName,
        },
        tx,
      ),
    );

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.state',
      targetType: 'file',
      targetId: fileId,
      targetName: file.name,
      detail: { from: result.from, to: result.to, backward: result.backward, notified: result.notified },
      ip: clientIp(request),
    });

    return {
      from: result.from,
      to: result.to,
      backward: result.backward,
      notified: result.notified,
      completeness: result.completeness,
    };
  });

  /** 状态流水：谁在什么时候把这张图推到了哪一步。 */
  app.get('/files/:id/state-history', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    await loadAccessibleFile(fileId, user);

    const rows = await stateHistory(fileId);
    const actorIds = rows.map((r) => r.actorId).filter((id): id is string => Boolean(id));

    const actors = actorIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, actorIds))
      : [];
    const nameById = new Map(actors.map((a) => [a.id, a.displayName]));

    return {
      history: rows.map((row) => ({
        from: row.from,
        to: row.to,
        note: row.note,
        actorName: row.actorId ? (nameById.get(row.actorId) ?? '已注销用户') : '系统',
        at: row.createdAt.toISOString(),
      })),
    };
  });

  /** 作品级状态汇总（进度面板与筛选用）。 */
  app.get('/projects/:id/state-summary', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = projectParam.parse(request.params);
    await requireProjectAccess(projectId, user);

    const rows = await db
      .select({ state: files.state, total: sql<number>`COUNT(*)` })
      .from(files)
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt)))
      .groupBy(files.state);

    const byState: Record<string, number> = Object.fromEntries(FILE_STATES.map((s) => [s, 0]));
    for (const row of rows) byState[row.state] = Number(row.total);

    return {
      byState,
      total: Object.values(byState).reduce((sum, n) => sum + n, 0),
      stages: PROJECT_STAGES.map((stage) => ({ key: stage, label: STAGE_LABELS[stage] })),
    };
  });

  // ── 署名 ──────────────────────────────────────────────────

  app.get('/files/:id/credits', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    await loadAccessibleFile(fileId, user);

    const lines = (await creditsForFiles([fileId])).get(fileId) ?? [];
    return {
      credits: lines,
      summary: summarizeCredits(lines),
      roleLabels: CREDIT_ROLE_LABELS,
      completeness: await translationCompleteness(fileId),
    };
  });

  /**
   * 改署名。**整体替换**而不是追加：界面上那一栏就是「翻译：____」，
   * 改完保存的结果就该是它显示的样子。追加语义会让人删不掉人。
   */
  app.put('/files/:id/credits', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user);
    // 署名牵涉「谁被记了一功」，是编辑决策 —— 与挑最终译文同一档权限。
    requireProjectPermission(access, 'tra.check');

    const body = parseOrThrow(creditsSchema, request.body);
    if (!isCreditRole(body.role)) throw badRequest('未知的署名角色', 'INVALID_ROLE');

    // 界面既可以传 userId（从成员列表选），也可以传 username（手工输入）。
    // 两种都支持，是因为「记一个还没进站的译者」是真实存在的场景。
    const entries: Array<{ userId?: string | null; displayName?: string }> = [];
    for (const entry of body.entries) {
      if (entry.username) {
        const found = await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.username, entry.username))
          .limit(1);
        if (found[0]) entries.push({ userId: found[0].id, displayName: found[0].displayName });
        else entries.push({ displayName: entry.username });
        continue;
      }
      if (entry.userId) {
        const found = await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, entry.userId))
          .limit(1);
        if (!found[0]) throw badRequest('指定的用户不存在', 'USER_NOT_FOUND');
        entries.push({ userId: found[0].id, displayName: found[0].displayName });
        continue;
      }
      if (entry.displayName) entries.push({ displayName: entry.displayName });
    }

    await db.transaction(async (tx) => {
      await replaceCredits(fileId, access.project.teamId, body.role, entries, user.id, tx);
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.credit.set',
      targetType: 'file',
      targetId: fileId,
      targetName: file.name,
      detail: { role: body.role, count: entries.length },
      ip: clientIp(request),
    });

    const lines = (await creditsForFiles([fileId])).get(fileId) ?? [];
    return { credits: lines, summary: summarizeCredits(lines) };
  });

  // ── 个人通知 ──────────────────────────────────────────────

  /**
   * 我的通知。
   *
   * 与站点公告分开取（前端把两者合并进铃铛）：公告对所有人都有意义，
   * 通知只对一个人有意义，硬塞进一个列表会让「未读数」变成两种口径的叠加。
   */
  app.get('/notifications', async (request) => {
    const user = await requireAuth(request);
    const query = parseOrThrow(
      z.object({
        unreadOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      request.query,
    );

    const conditions = [eq(notifications.userId, user.id)];
    if (query.unreadOnly) conditions.push(isNull(notifications.readAt));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(query.limit);

    const unreadRows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

    return {
      unread: unreadRows.length,
      notifications: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        teamId: row.teamId,
        projectId: row.projectId,
        fileId: row.fileId,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });

  app.post('/notifications/read', async (request) => {
    const user = await requireAuth(request);
    const body = parseOrThrow(
      z.object({
        all: z.boolean().default(false),
        ids: z.array(z.string().uuid()).max(200).optional(),
      }),
      request.body,
    );

    if (!body.all && (!body.ids || body.ids.length === 0)) {
      throw badRequest('请指定要标记的通知，或使用 all', 'INVALID_ARGUMENT');
    }

    const conditions = [eq(notifications.userId, user.id), isNull(notifications.readAt)];
    if (!body.all && body.ids) conditions.push(inArray(notifications.id, body.ids));

    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...conditions))
      .returning({ id: notifications.id });

    return { ok: true, marked: updated.length };
  });

  /**
   * 我负责的待办：按署名分到我头上、且还停在我这一环节的图片。
   *
   * 工作台的角标用它。判定依据是**署名台账 + 当前状态**，
   * 而不是「谁有权限」—— 有权限的人可能很多，而真正被点名的是少数。
   */
  app.get('/my-todos', async (request) => {
    const user = await requireAuth(request);

    const teamRows = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user.id));

    if (teamRows.length === 0) {
      return { todos: [], byProject: {}, total: 0 };
    }

    const rows = await db
      .select({
        fileId: files.id,
        fileState: files.state,
        projectId: files.projectId,
        role: fileCredits.role,
      })
      .from(fileCredits)
      .innerJoin(files, eq(files.id, fileCredits.fileId))
      .where(and(eq(fileCredits.userId, user.id), isNull(files.deletedAt)));

    const todos = rows.filter((row) => TODO_STATES_BY_ROLE[row.role]?.includes(row.fileState));

    const byProject: Record<string, number> = {};
    for (const todo of todos) {
      byProject[todo.projectId] = (byProject[todo.projectId] ?? 0) + 1;
    }

    return {
      todos: todos.map((t) => ({
        fileId: t.fileId,
        projectId: t.projectId,
        role: t.role,
        state: t.fileState,
      })),
      byProject,
      total: todos.length,
    };
  });
}

/**
 * 各署名角色「还停在这一步」的状态集合。
 *
 * 判定依据是**署名台账 + 当前状态**，而不是「谁有权限」：
 * 有权限的人可能很多，而真正被点名负责的是少数 —— 待办如果按权限发，
 * 每个有校对权的人都会看到全组的图，等于没有待办。
 */
const TODO_STATES_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  translator: ['sourced', 'translating'],
  proofreader: ['translated', 'proofreading'],
  typesetter: ['proofread', 'typesetting'],
};
