import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { files, importTaskItems, importTasks, sourcingAccounts } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission } from '../../domain/authorize.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { encryptCredentials, hasCredentials, maskCredentials } from '../../sourcing/credentials.js';
import { isSourcingError } from '../../sourcing/errors.js';
import { maskProxy } from '../../sourcing/http.js';
import { probeAccount } from '../../sourcing/probe.js';
import { detectSource, sourceCatalog } from '../../sourcing/registry.js';
import { parseOrThrow } from '../file-access.js';
import { clientIp, requireAuth, requireSiteAdmin } from '../guards.js';

/**
 * 图源导入的接口。
 *
 * 与上传的权限口径一致：**能往这个作品加图的人才能发起导入**
 * （`file.add`）—— 导入出来的就是文件，没有理由给它另开一扇门。
 *
 * 这里只负责「建任务、看进度、重试」，真正干活的是 worker
 * （见 sourcing/importer.ts）。所以接口都是**快进快出**的：
 * 建完立刻返回，前端靠轮询看进度，而不是把 HTTP 请求挂在那里等几分钟。
 */

const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });
const taskParam = z.object({ taskId: z.string().uuid('任务 ID 不合法') });

/** 一次最多粘多少条链接。多了应该分批，否则一次性给队列塞几百条任务。 */
const MAX_URLS_PER_REQUEST = 20;

const createSchema = z.strictObject({
  urls: z.array(z.string().trim().min(1).max(2000)).min(1, '至少要粘一条链接').max(MAX_URLS_PER_REQUEST),
});

function serializeTask(row: typeof importTasks.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    inputUrl: row.inputUrl,
    source: row.source,
    status: row.status,
    total: row.total,
    done: row.done,
    imported: row.imported,
    duplicated: row.duplicated,
    failed: row.failed,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    notes: Array.isArray(row.notes) ? row.notes : [],
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function registerSourcingRoutes(app: FastifyInstance): Promise<void> {
  /** 图源目录。前端用它渲染「支持哪些链接」的说明。 */
  app.get('/sourcing/sources', async (request) => {
    await requireAuth(request);
    return { sources: sourceCatalog(), maxUrlsPerRequest: MAX_URLS_PER_REQUEST };
  });

  /** 发起导入。一次可以粘多条链接，**每条链接建一个任务**（见 schema 的说明）。 */
  app.post('/projects/:id/imports', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: projectId } = parseOrThrow(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'file.add');

    const body = parseOrThrow(createSchema, request.body);

    // 去掉重复的链接：同一个链接粘两次多半是手滑，建两个任务会去抢同一批图，
    // 后一个全被判成 duplicated，白白跑一遍。
    const urls = [...new Set(body.urls.map((u) => u.trim()).filter((u) => u !== ''))];
    if (urls.length === 0) throw badRequest('至少要粘一条链接', 'NO_URLS');

    const created = await db
      .insert(importTasks)
      .values(
        urls.map((raw) => {
          // 认链接是纯本地判断（不发请求），所以放到这里做 ——
          // 认不出来就当场把任务标成失败，用户不用等一个 worker tick 才看到「这个链接不支持」。
          const base = {
            projectId,
            teamId: access.project.teamId,
            createdBy: user.id,
            inputUrl: raw,
          };
          try {
            const detected = detectSource(raw);
            return { ...base, source: detected.parser.id, status: 'pending' as const };
          } catch (err) {
            return {
              ...base,
              source: '',
              status: 'failed' as const,
              errorCode: isSourcingError(err) ? err.code : 'INVALID_URL',
              errorMessage: isSourcingError(err) ? err.userMessage : '链接无法识别',
              finishedAt: new Date(),
            };
          }
        }),
      )
      .returning();

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'import.create',
      targetType: 'project',
      targetId: projectId,
      targetName: access.project.name,
      detail: { count: created.length, urls: urls.map((u) => u.slice(0, 120)) },
      ip: clientIp(request),
    });

    reply.code(201);
    return { tasks: created.map(serializeTask) };
  });

  /** 这个作品最近的导入记录。前端弹窗打开时先拉一次，之后靠轮询续。 */
  app.get('/projects/:id/imports', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parseOrThrow(projectParam, request.params);
    await requireProjectAccess(projectId, user);

    const rows = await db
      .select()
      .from(importTasks)
      .where(eq(importTasks.projectId, projectId))
      .orderBy(desc(importTasks.createdAt))
      .limit(50);

    return { tasks: rows.map(serializeTask) };
  });

  /**
   * 批量取任务进度。
   *
   * 前端每 1.5s 轮询一次。一次粘 10 条链接就是 10 个任务，
   * 逐个查等于每轮 10 个请求 —— 所以给一个按 id 批量取的入口。
   */
  app.get('/imports', async (request) => {
    const user = await requireAuth(request);
    const query = parseOrThrow(
      z.object({ ids: z.string().min(1).max(2000) }),
      request.query,
    );
    const ids = query.ids.split(',').filter((v) => v !== '').slice(0, 50);

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = ids.filter((id) => uuidRe.test(id));
    if (valid.length === 0) return { tasks: [] };

    const rows = await db.select().from(importTasks).where(inArray(importTasks.id, valid));
    // 越权的一条也不给：任务的可见性跟着作品走。
    const seen = new Set<string>();
    const allowed: typeof rows = [];
    for (const row of rows) {
      if (seen.has(row.projectId)) continue;
      seen.add(row.projectId);
      try {
        await requireProjectAccess(row.projectId, user);
        allowed.push(row);
      } catch {
        // 看不到就不返回，不报错 —— 免得通过「哪条报错」推断出别的作品存在。
      }
    }

    return { tasks: allowed.map(serializeTask) };
  });

  /** 任务详情：逐张的状态与失败原因。 */
  app.get('/imports/:taskId', async (request) => {
    const user = await requireAuth(request);
    const { taskId } = parseOrThrow(taskParam, request.params);

    const rows = await db.select().from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
    const task = rows[0];
    if (!task) throw notFound('任务不存在', 'IMPORT_NOT_FOUND');
    await requireProjectAccess(task.projectId, user);

    const items = await db
      .select({
        id: importTaskItems.id,
        idx: importTaskItems.idx,
        url: importTaskItems.url,
        status: importTaskItems.status,
        fileId: importTaskItems.fileId,
        code: importTaskItems.code,
        reason: importTaskItems.reason,
        fileName: files.name,
      })
      .from(importTaskItems)
      .leftJoin(files, eq(files.id, importTaskItems.fileId))
      .where(eq(importTaskItems.taskId, taskId))
      .orderBy(importTaskItems.idx)
      .limit(1000);

    return { task: serializeTask(task), items };
  });

  /**
   * 重试。
   *
   * 语义是「把失败的那几张重新排进队列」，不是「整条重来」——
   * importer 会复用已有的清单，只跑 `pending` 的那些（见它的「二、把清单落库」）。
   */
  app.post('/imports/:taskId/retry', async (request) => {
    const user = await requireAuth(request);
    const { taskId } = parseOrThrow(taskParam, request.params);

    const rows = await db.select().from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
    const task = rows[0];
    if (!task) throw notFound('任务不存在', 'IMPORT_NOT_FOUND');

    // requireProjectAccess 拿不到权限时会自己抛 403/404，不需要在这里再判一次。
    const access = await requireProjectAccess(task.projectId, user);
    requireProjectPermission(access, 'file.add');

    if (task.status === 'running') {
      throw badRequest('这个任务正在跑，等它结束再重试', 'IMPORT_RUNNING');
    }

    await db
      .update(importTaskItems)
      .set({ status: 'pending', code: '', reason: '', updatedAt: new Date() })
      .where(and(eq(importTaskItems.taskId, taskId), eq(importTaskItems.status, 'failed')));

    const updated = await db
      .update(importTasks)
      .set({
        status: 'pending',
        errorCode: '',
        errorMessage: '',
        failed: 0,
        // 重置认领状态，否则租约还在、下一个 tick 认领不到它
        claimedAt: null,
        leaseExpiresAt: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(importTasks.id, taskId))
      .returning();

    await logOp({
      actorId: user.id,
      teamId: task.teamId,
      action: 'import.retry',
      targetType: 'project',
      targetId: task.projectId,
      detail: { taskId, previousStatus: task.status },
      ip: clientIp(request),
    });

    return { task: serializeTask(updated[0] ?? task) };
  });
}

// ── 图源账号（仅站点管理员）─────────────────────────────────
//
// 这些是**别人的账号凭据**，所以口径与站点设置一致：只有站点管理员能读写。
// 读接口**只回掩码**（`••••后四位`），明文既不出库也不出网 ——
// 一次误操作把凭据回传到前端，就等于把它写进了浏览器缓存与 devtools 记录。

const accountParam = z.object({ accountId: z.string().uuid('账号 ID 不合法') });

const accountSchema = z.strictObject({
  source: z.enum([
    'twitter', 'twitter_user', 'bluesky', 'bluesky_user', 'pixiv', 'pixiv_user', 'external',
  ]),
  label: z.string().trim().min(1, '请填一个名字').max(60),
  /** 凭据是键值对，键名由各解析器自定（如 `authToken` / `phpSessId`）。 */
  credentials: z.record(z.string(), z.string().max(4000)).optional(),
  /** 空串 = 用 SOURCING_PROXY 的默认出口 */
  proxyUrl: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

function serializeAccount(row: typeof sourcingAccounts.$inferSelect) {
  return {
    id: row.id,
    teamId: row.teamId,
    source: row.source,
    label: row.label,
    // 永远不回明文。界面上只需要知道「配了什么键」与「末尾几位」。
    credentials: maskCredentials(row.credentials),
    hasCredentials: hasCredentials(row.credentials),
    // 代理地址可能带用户名密码，同样掩码
    proxyUrl: row.proxyUrl ? maskProxy(row.proxyUrl) : '',
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastMessage: row.lastMessage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 只允许 http/https/socks 的代理地址，且不能是空串以外的垃圾。 */
function normalizeProxy(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest('代理地址格式不对（要带 http:// 或 socks5://）', 'BAD_PROXY');
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw badRequest(`不支持的代理协议：${url.protocol}`, 'BAD_PROXY');
  }
  if (!url.host) throw badRequest('代理地址缺主机名', 'BAD_PROXY');
  return trimmed;
}

export async function registerSourcingAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/sourcing/accounts', async (request) => {
    await requireSiteAdmin(request);
    const rows = await db.select().from(sourcingAccounts).orderBy(asc(sourcingAccounts.source), asc(sourcingAccounts.label));
    return { accounts: rows.map(serializeAccount) };
  });

  app.post('/admin/sourcing/accounts', async (request, reply) => {
    const admin = await requireSiteAdmin(request);
    const body = parseOrThrow(accountSchema, request.body);

    const inserted = await db
      .insert(sourcingAccounts)
      .values({
        source: body.source,
        label: body.label,
        credentials: encryptCredentials(body.credentials ?? {}),
        proxyUrl: normalizeProxy(body.proxyUrl) ?? '',
        enabled: body.enabled ?? true,
        createdBy: admin.id,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw badRequest('创建失败');

    await logOp({
      actorId: admin.id,
      action: 'sourcing.account.create',
      targetType: 'site_setting',
      targetId: row.id,
      targetName: row.label,
      detail: { source: row.source },
      ip: clientIp(request),
    });

    reply.code(201);
    return { account: serializeAccount(row) };
  });

  app.patch('/admin/sourcing/accounts/:accountId', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { accountId } = parseOrThrow(accountParam, request.params);
    const body = parseOrThrow(accountSchema.partial(), request.body);

    const existing = await db.select().from(sourcingAccounts).where(eq(sourcingAccounts.id, accountId)).limit(1);
    if (existing.length === 0) throw notFound('账号不存在', 'ACCOUNT_NOT_FOUND');

    const proxy = normalizeProxy(body.proxyUrl);

    const updated = await db
      .update(sourcingAccounts)
      .set({
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.source === undefined ? {} : { source: body.source }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(proxy === undefined ? {} : { proxyUrl: proxy }),
        // 凭据是**整体替换**：传了就用新的，不传就保持原样。
        // 做成「合并」的话，想删掉某个键就没有办法了（前端也拿不到旧值，
        // 因为它读到的永远是掩码）。
        ...(body.credentials === undefined ? {} : { credentials: encryptCredentials(body.credentials) }),
        updatedAt: new Date(),
      })
      .where(eq(sourcingAccounts.id, accountId))
      .returning();

    const row = updated[0];
    if (!row) throw notFound('账号不存在', 'ACCOUNT_NOT_FOUND');

    await logOp({
      actorId: admin.id,
      action: 'sourcing.account.update',
      targetType: 'site_setting',
      targetId: row.id,
      targetName: row.label,
      detail: { source: row.source, credentialKeys: body.credentials ? Object.keys(body.credentials) : null },
      ip: clientIp(request),
    });

    return { account: serializeAccount(row) };
  });

  app.delete('/admin/sourcing/accounts/:accountId', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { accountId } = parseOrThrow(accountParam, request.params);

    const removed = await db
      .delete(sourcingAccounts)
      .where(eq(sourcingAccounts.id, accountId))
      .returning({ id: sourcingAccounts.id, label: sourcingAccounts.label });

    if (removed.length === 0) throw notFound('账号不存在', 'ACCOUNT_NOT_FOUND');

    await logOp({
      actorId: admin.id,
      action: 'sourcing.account.delete',
      targetType: 'site_setting',
      targetId: accountId,
      targetName: removed[0]?.label ?? '',
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /** 连通性自检：结果写回账号行，后台列表上就能看到最近一次是否可用。 */
  app.post('/admin/sourcing/accounts/:accountId/test', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { accountId } = parseOrThrow(accountParam, request.params);

    const rows = await db.select().from(sourcingAccounts).where(eq(sourcingAccounts.id, accountId)).limit(1);
    const account = rows[0];
    if (!account) throw notFound('账号不存在', 'ACCOUNT_NOT_FOUND');

    const result = await probeAccount(account.source as never, account.proxyUrl || null);

    const updated = await db
      .update(sourcingAccounts)
      .set({
        lastCheckedAt: new Date(),
        lastStatus: result.status,
        lastMessage: result.message,
        updatedAt: new Date(),
      })
      .where(eq(sourcingAccounts.id, accountId))
      .returning();

    await logOp({
      actorId: admin.id,
      action: 'sourcing.account.test',
      targetType: 'site_setting',
      targetId: accountId,
      targetName: account.label,
      detail: { status: result.status },
      ip: clientIp(request),
    });

    return { result, account: serializeAccount(updated[0] ?? account) };
  });
}

/** 供其他模块引用，避免常量散落。 */
export { MAX_URLS_PER_REQUEST };
