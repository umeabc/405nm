import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../../auth/password.js';
import { destroyAllSessionsForUser } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { noticeReads, notices, sessions, siteSettings, teamMembers, users } from '../../db/schema.js';
import { env } from '../../env.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { consumeRateLimit } from '../../lib/rate-limit.js';
import { validateDisplayName, validatePassword, validateUsername } from '../../lib/validate.js';
import { clientIp, requireAuth, requireSiteAdmin } from '../guards.js';

/**
 * 站点设置的键白名单。
 *
 * 与图译空间的一处**刻意分歧**：它的 `PUT /api/settings` 只要登录就能改全站配置
 * （那是扁平权限模型下的取舍）。405nm 是真实分权的系统，站点设置仅站点管理员可写。
 */
const SITE_SETTING_KEYS = [
  'site.name',
  'site.slogan',
  'site.englishName',
  'site.description',
  'site.footer',
] as const;

const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarKey: users.avatarKey,
  isSiteAdmin: users.isSiteAdmin,
  status: users.status,
  createdAt: users.createdAt,
};

const listUsersQuery = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['all', 'active', 'disabled', 'deactivated']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createUserSchema = z.object({
  username: z.string({ required_error: '请输入用户名' }),
  password: z.string({ required_error: '请输入密码' }),
  displayName: z.string().optional(),
  isSiteAdmin: z.boolean().default(false),
});

/**
 * `.strict()` 是刻意的：字段名写错时必须报错，而不是被静默丢弃。
 * 静默丢弃会变成「接口返回 ok，但什么都没改」—— 这类问题比报错难查得多。
 */
const updateUserSchema = z
  .object({
    displayName: z.string().trim().max(32).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const resetPasswordSchema = z.object({
  newPassword: z.string().optional(),
});

const setSiteAdminSchema = z.object({ isSiteAdmin: z.boolean() });

const noticeSchema = z.object({
  title: z.string().trim().max(64).default(''),
  content: z.string().trim().min(1, '请填写公告内容').max(4000, '公告内容过长'),
  enabled: z.boolean().default(true),
});

const markReadSchema = z.object({
  all: z.boolean().optional(),
  ids: z.array(z.string().uuid()).optional(),
});

/** 注销用的脱敏占位。用户名要能看出「这里曾经有人」，但不泄露是谁。 */
const REDACTED = '[Redacted]';

function randomPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── 用户管理 ──────────────────────────────────────────────

  app.get('/admin/users', async (request) => {
    await requireSiteAdmin(request);
    const query = listUsersQuery.parse(request.query);

    const filters = [];
    if (query.status !== 'all') filters.push(eq(users.status, query.status));
    if (query.q) {
      filters.push(
        or(ilike(users.username, `%${query.q}%`), ilike(users.displayName, `%${query.q}%`))!,
      );
    }
    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = await db
      .select(publicUserColumns)
      .from(users)
      .where(where)
      .orderBy(asc(users.username))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const totalRows = await db.select({ total: count() }).from(users).where(where);
    const total = Number(totalRows[0]?.total ?? 0);

    return {
      users: rows,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  });

  app.post('/admin/users', async (request, reply) => {
    const admin = await requireSiteAdmin(request);

    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const { username, password, displayName, isSiteAdmin } = parsed.data;

    const usernameError = validateUsername(username);
    if (usernameError) throw badRequest(usernameError, 'INVALID_USERNAME');
    const passwordError = validatePassword(password);
    if (passwordError) throw badRequest(passwordError, 'INVALID_PASSWORD');

    const normalName = (displayName ?? username).trim();
    const nameError = validateDisplayName(normalName);
    if (nameError) throw badRequest(nameError, 'INVALID_DISPLAY_NAME');

    const exists = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (exists.length > 0) throw conflict('该用户名已被占用', 'USERNAME_TAKEN');

    const inserted = await db
      .insert(users)
      .values({
        username,
        displayName: normalName,
        passwordHash: await hashPassword(password),
        isSiteAdmin,
      })
      .returning(publicUserColumns);

    await logOp({
      actorId: admin.id,
      action: 'admin.user.create',
      targetType: 'user',
      targetId: inserted[0]?.id ?? '',
      targetName: username,
      detail: { isSiteAdmin },
      ip: clientIp(request),
    });

    reply.code(201);
    return { user: inserted[0] };
  });

  app.patch('/admin/users/:id', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const parsed = updateUserSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const user = target[0];
    if (!user) throw notFound('用户不存在', 'USER_NOT_FOUND');

    // 不允许管理员把自己停用 —— 否则站点可能再没人能进来了。
    if (parsed.data.status && parsed.data.status !== 'active' && user.id === admin.id) {
      throw badRequest('不能停用你自己的账号', 'CANNOT_DISABLE_SELF');
    }

    if (parsed.data.displayName) {
      const nameError = validateDisplayName(parsed.data.displayName);
      if (nameError) throw badRequest(nameError, 'INVALID_DISPLAY_NAME');
    }

    await db
      .update(users)
      .set({
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    // 停用要立刻生效：光改状态不清会话，对方还能拿着旧 Cookie 到处走。
    if (parsed.data.status === 'disabled') {
      await destroyAllSessionsForUser(id);
    }

    await logOp({
      actorId: admin.id,
      action: 'admin.user.update',
      targetType: 'user',
      targetId: id,
      targetName: user.username,
      detail: parsed.data,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.patch('/admin/users/:id/password', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const parsed = resetPasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('参数不合法');

    const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const user = target[0];
    if (!user) throw notFound('用户不存在', 'USER_NOT_FOUND');

    const provided = parsed.data.newPassword?.trim();
    const newPassword = provided && provided.length > 0 ? provided : randomPassword();

    const passwordError = validatePassword(newPassword);
    if (passwordError) throw badRequest(passwordError, 'INVALID_PASSWORD');

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, id));

    await destroyAllSessionsForUser(id);

    await logOp({
      actorId: admin.id,
      action: 'admin.user.reset_password',
      targetType: 'user',
      targetId: id,
      targetName: user.username,
      detail: { generated: !provided },
      ip: clientIp(request),
    });

    // 随机生成的密码只在这里返回一次；管理员自己填的就不回显了。
    return { ok: true, ...(provided ? {} : { generatedPassword: newPassword }) };
  });

  app.patch('/admin/users/:id/site-admin', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const parsed = setSiteAdminSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('参数不合法');

    const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const user = target[0];
    if (!user) throw notFound('用户不存在', 'USER_NOT_FOUND');

    if (!parsed.data.isSiteAdmin && user.id === admin.id) {
      throw badRequest('不能收回你自己的站点管理员权限', 'CANNOT_DEMOTE_SELF');
    }

    // 兜底：不允许把最后一个站点管理员降下来，否则没人能进后台了。
    if (!parsed.data.isSiteAdmin) {
      const remaining = await db
        .select({ total: count() })
        .from(users)
        .where(and(eq(users.isSiteAdmin, true), eq(users.status, 'active')));
      if (Number(remaining[0]?.total ?? 0) <= 1) {
        throw badRequest('至少要保留一名站点管理员', 'LAST_SITE_ADMIN');
      }
    }

    await db
      .update(users)
      .set({ isSiteAdmin: parsed.data.isSiteAdmin, updatedAt: new Date() })
      .where(eq(users.id, id));

    await logOp({
      actorId: admin.id,
      action: parsed.data.isSiteAdmin ? 'admin.grant_site_admin' : 'admin.revoke_site_admin',
      targetType: 'user',
      targetId: id,
      targetName: user.username,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /**
   * 注销（脱敏）。保留数据库行，但把身份信息抹掉、踢下线、并从列表隐藏。
   * 不物理删除是因为他的翻译与标号还挂在这些记录上 —— 删了会留下无主内容。
   */
  app.delete('/admin/users/:id', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const user = target[0];
    if (!user) throw notFound('用户不存在', 'USER_NOT_FOUND');
    if (user.id === admin.id) throw badRequest('不能注销你自己的账号', 'CANNOT_DEACTIVATE_SELF');
    if (user.status === 'deactivated') throw conflict('该用户已注销', 'ALREADY_DEACTIVATED');

    if (user.isSiteAdmin) {
      const remaining = await db
        .select({ total: count() })
        .from(users)
        .where(and(eq(users.isSiteAdmin, true), eq(users.status, 'active')));
      if (Number(remaining[0]?.total ?? 0) <= 1) {
        throw badRequest('至少要保留一名站点管理员', 'LAST_SITE_ADMIN');
      }
    }

    await db
      .update(users)
      .set({
        username: `${REDACTED}-${user.id.slice(0, 8)}`,
        displayName: REDACTED,
        avatarKey: null,
        passwordHash: await hashPassword(randomPassword()),
        isSiteAdmin: false,
        status: 'deactivated',
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    await destroyAllSessionsForUser(id);
    // 退出所有团队，避免占着成员位。
    await db.delete(teamMembers).where(eq(teamMembers.userId, id));

    await logOp({
      actorId: admin.id,
      action: 'admin.user.deactivate',
      targetType: 'user',
      targetId: id,
      targetName: user.username,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  // ── 站点设置 ──────────────────────────────────────────────

  app.get('/admin/settings', async (request) => {
    await requireSiteAdmin(request);
    const rows = await db.select().from(siteSettings);
    const map: Record<string, unknown> = {};
    for (const key of SITE_SETTING_KEYS) map[key] = null;
    for (const row of rows) map[row.key] = row.value;
    return { settings: map, allowedKeys: SITE_SETTING_KEYS };
  });

  app.put('/admin/settings', async (request) => {
    const admin = await requireSiteAdmin(request);

    const parsed = z.record(z.string(), z.unknown()).safeParse(request.body);
    if (!parsed.success) throw badRequest('参数不合法');

    const allowed = new Set<string>(SITE_SETTING_KEYS);
    const entries = Object.entries(parsed.data).filter(([key]) => allowed.has(key));
    if (entries.length === 0) throw badRequest('没有可保存的设置项', 'NO_SETTING_TO_SAVE');

    for (const [key, value] of entries) {
      await db
        .insert(siteSettings)
        .values({ key, value: value as never, updatedBy: admin.id })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: value as never, updatedBy: admin.id, updatedAt: new Date() },
        });
    }

    await logOp({
      actorId: admin.id,
      action: 'admin.settings.update',
      targetType: 'site_setting',
      detail: { keys: entries.map(([k]) => k) },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /** 站点设置的公开读取：登录页也要显示站点名。 */
  app.get('/site/settings', async () => {
    const rows = await db
      .select()
      .from(siteSettings)
      .where(inArray(siteSettings.key, [...SITE_SETTING_KEYS]));
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key] = row.value;
    return { settings: map };
  });

  // ── 公告通知 ──────────────────────────────────────────────

  app.get('/admin/notices', async (request) => {
    await requireSiteAdmin(request);

    const rows = await db
      .select({
        notice: notices,
        createdByName: users.displayName,
        createdByUsername: users.username,
      })
      .from(notices)
      .leftJoin(users, eq(users.id, notices.createdBy))
      .orderBy(desc(notices.createdAt));

    const readCounts = await db
      .select({ noticeId: noticeReads.noticeId, total: count() })
      .from(noticeReads)
      .groupBy(noticeReads.noticeId);
    const readByNotice = new Map(readCounts.map((r) => [r.noticeId, Number(r.total)]));

    return {
      notices: rows.map((r) => ({
        id: r.notice.id,
        title: r.notice.title,
        content: r.notice.content,
        enabled: r.notice.enabled,
        createdAt: r.notice.createdAt,
        createdBy: r.createdByName || r.createdByUsername || null,
        readCount: readByNotice.get(r.notice.id) ?? 0,
      })),
    };
  });

  app.post('/admin/notices', async (request, reply) => {
    const admin = await requireSiteAdmin(request);

    const parsed = noticeSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const inserted = await db
      .insert(notices)
      .values({ ...parsed.data, createdBy: admin.id })
      .returning({ id: notices.id });

    await logOp({
      actorId: admin.id,
      action: 'admin.notice.create',
      targetType: 'notice',
      targetId: inserted[0]?.id ?? '',
      targetName: parsed.data.title,
      ip: clientIp(request),
    });

    reply.code(201);
    return { noticeId: inserted[0]?.id };
  });

  app.patch('/admin/notices/:id', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const parsed = noticeSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');

    const rows = await db
      .update(notices)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(notices.id, id))
      .returning({ id: notices.id });
    if (rows.length === 0) throw notFound('公告不存在', 'NOTICE_NOT_FOUND');

    await logOp({
      actorId: admin.id,
      action: 'admin.notice.update',
      targetType: 'notice',
      targetId: id,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/admin/notices/:id', async (request) => {
    const admin = await requireSiteAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const rows = await db.delete(notices).where(eq(notices.id, id)).returning({ id: notices.id });
    if (rows.length === 0) throw notFound('公告不存在', 'NOTICE_NOT_FOUND');

    await logOp({
      actorId: admin.id,
      action: 'admin.notice.delete',
      targetType: 'notice',
      targetId: id,
      ip: clientIp(request),
    });

    return { ok: true };
  });

  /** 用户端：我的未读与历史。 */
  app.get('/notices', async (request) => {
    const user = await requireAuth(request);
    const query = z.object({ scope: z.enum(['all', 'unread']).default('all') }).parse(request.query);

    const rows = await db
      .select({
        notice: notices,
        readAt: noticeReads.readAt,
      })
      .from(notices)
      .leftJoin(
        noticeReads,
        and(eq(noticeReads.noticeId, notices.id), eq(noticeReads.userId, user.id)),
      )
      .where(
        query.scope === 'unread'
          ? and(eq(notices.enabled, true), isNull(noticeReads.readAt))
          : eq(notices.enabled, true),
      )
      .orderBy(desc(notices.createdAt))
      .limit(100);

    const unreadRows = await db
      .select({ total: count() })
      .from(notices)
      .leftJoin(
        noticeReads,
        and(eq(noticeReads.noticeId, notices.id), eq(noticeReads.userId, user.id)),
      )
      .where(and(eq(notices.enabled, true), isNull(noticeReads.readAt)));

    return {
      unread: Number(unreadRows[0]?.total ?? 0),
      notices: rows.map((r) => ({
        id: r.notice.id,
        title: r.notice.title,
        content: r.notice.content,
        createdAt: r.notice.createdAt,
        read: r.readAt !== null,
      })),
    };
  });

  app.post('/notices/read', async (request) => {
    const user = await requireAuth(request);

    const parsed = markReadSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('参数不合法');

    let targets: string[] = [];

    if (parsed.data.all) {
      const rows = await db
        .select({ id: notices.id })
        .from(notices)
        .leftJoin(
          noticeReads,
          and(eq(noticeReads.noticeId, notices.id), eq(noticeReads.userId, user.id)),
        )
        .where(and(eq(notices.enabled, true), isNull(noticeReads.readAt)));
      targets = rows.map((r) => r.id);
    } else if (parsed.data.ids && parsed.data.ids.length > 0) {
      targets = parsed.data.ids;
    } else {
      throw badRequest('没有需要标记的公告', 'NOTHING_TO_MARK');
    }

    if (targets.length > 0) {
      await db
        .insert(noticeReads)
        .values(targets.map((noticeId) => ({ noticeId, userId: user.id })))
        .onConflictDoNothing();
    }

    return { ok: true, marked: targets.length };
  });
}
