import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  destroyAllSessionsForUser,
  destroySession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../../auth/session.js';
import { db } from '../../db/client.js';
import { env } from '../../env.js';
import { users, type User } from '../../db/schema.js';
import {
  consumeInviteCode,
  envInviteCode,
  joinTeamByInvite,
  validateInviteCode,
} from '../../domain/invite.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
} from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { consumeRateLimit, isRateLimited, resetRateLimit } from '../../lib/rate-limit.js';
import { validateDisplayName, validatePassword, validateUsername } from '../../lib/validate.js';
import { clientIp, requireAuth } from '../guards.js';

/** 对外一律不返回密码哈希等敏感字段。 */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarKey: user.avatarKey,
    isSiteAdmin: user.isSiteAdmin,
    createdAt: user.createdAt,
  };
}

const usernameField = z.string({ required_error: '请输入用户名' });
const passwordField = z.string({ required_error: '请输入密码' });

const loginSchema = z.object({
  username: usernameField.min(1, '请输入用户名'),
  password: passwordField.min(1, '请输入密码'),
});

const registerSchema = z.object({
  username: usernameField,
  password: passwordField,
  displayName: z.string().optional(),
  inviteCode: z.string({ required_error: '请输入邀请码' }).min(1, '请输入邀请码'),
});

const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: passwordField,
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 注册开关：前端据此决定要不要显示「注册」入口。
   * 没有 env 邀请码、库里也没有可用邀请码时，注册就是关闭的。
   */
  app.get('/auth/registration-status', async () => {
    const { inviteCodes } = await import('../../db/schema.js');
    const { and, gt, isNull, or, sql } = await import('drizzle-orm');

    const available = await db
      .select({ id: inviteCodes.id })
      .from(inviteCodes)
      .where(
        and(
          eq(inviteCodes.enabled, true),
          or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, new Date())),
          or(isNull(inviteCodes.maxUses), sql`${inviteCodes.usedCount} < ${inviteCodes.maxUses}`),
        ),
      )
      .limit(1);

    return {
      open: Boolean(envInviteCode()) || available.length > 0,
      viaEnv: Boolean(envInviteCode()),
    };
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
    }

    const { username, password } = parsed.data;
    const ip = clientIp(request);
    const failKey = `login:fail:${ip}`;

    // 限的是**失败次数**：正常用户每天登几次不该被挡，只有反复试密码的才会撞上。
    if (await isRateLimited(failKey, env.LOGIN_MAX_FAILS, env.RATE_LIMIT_WINDOW_MS)) {
      throw tooManyRequests('登录失败次数过多，请一小时后再试');
    }

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username.trim()))
      .limit(1);
    const user = rows[0];

    // 用户名不存在与密码错误返回同一个错误，避免账号枚举。
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      await consumeRateLimit(failKey, env.LOGIN_MAX_FAILS, env.RATE_LIMIT_WINDOW_MS);
      throw new AppError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
    }

    // 登录成功就清零，免得「白天输错两次」在晚上还占着额度。
    await resetRateLimit(failKey);

    if (user.status !== 'active') {
      throw forbidden('账号已被停用，请联系站点管理员');
    }

    const { token, expiresAt } = await createSession(user.id, {
      userAgent: request.headers['user-agent'],
      ip,
    });
    setSessionCookie(reply, token, expiresAt);

    return { user: toPublicUser(user) };
  });

  app.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
    }

    const { username, password, displayName, inviteCode } = parsed.data;
    const ip = clientIp(request);

    const usernameError = validateUsername(username);
    if (usernameError) throw badRequest(usernameError, 'INVALID_USERNAME');

    const passwordError = validatePassword(password);
    if (passwordError) throw badRequest(passwordError, 'INVALID_PASSWORD');

    const normalName = (displayName ?? username).trim();
    const nameError = validateDisplayName(normalName);
    if (nameError) throw badRequest(nameError, 'INVALID_DISPLAY_NAME');

    // 先限流再验码：猜码的代价要比注册本身高。
    const perIp = await consumeRateLimit(
      `register:ip:${ip}`,
      env.REGISTER_MAX_PER_IP,
      env.RATE_LIMIT_WINDOW_MS,
    );
    if (!perIp.allowed) {
      reply.header('Retry-After', String(Math.ceil(perIp.retryAfterMs / 1000)));
      throw tooManyRequests('注册尝试过于频繁，请稍后再试');
    }

    const global = await consumeRateLimit(
      'register:global',
      env.REGISTER_MAX_GLOBAL,
      env.RATE_LIMIT_WINDOW_MS,
    );
    if (!global.allowed) {
      reply.header('Retry-After', String(Math.ceil(global.retryAfterMs / 1000)));
      throw tooManyRequests('站点注册量已达上限，请稍后再试');
    }

    // 邀请码无效就把配额还回去 —— 别让打错一次码的人被自己的手误挡住。
    let invite;
    try {
      invite = await validateInviteCode(inviteCode);
    } catch (err) {
      await resetRateLimit(`register:ip:${ip}`);
      throw err;
    }

    const passwordHash = await hashPassword(password);

    const created = await db.transaction(async (tx) => {
      const exists = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (exists.length > 0) {
        throw conflict('该用户名已被占用', 'USERNAME_TAKEN');
      }

      const inserted = await tx
        .insert(users)
        .values({
          username,
          displayName: normalName,
          passwordHash,
        })
        .returning();

      const newUser = inserted[0];
      if (!newUser) throw new Error('创建用户失败');

      if (invite.invite) {
        await consumeInviteCode(tx, invite.invite.id);
        await joinTeamByInvite(tx, invite.invite, newUser.id);
      }

      return newUser;
    });

    await logOp({
      actorId: created.id,
      action: 'user.register',
      targetType: 'user',
      targetId: created.id,
      targetName: created.username,
      detail: { viaEnvInvite: invite.viaEnv, inviteId: invite.invite?.id ?? null },
      ip,
    });

    const { token, expiresAt } = await createSession(created.id, {
      userAgent: request.headers['user-agent'],
      ip,
    });
    setSessionCookie(reply, token, expiresAt);

    return { user: toPublicUser(created) };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const user = await requireAuth(request);
    return { user: toPublicUser(user) };
  });

  /** 改密码后把**所有**会话踢掉，包括当前这条 —— 改密码的语义就是「别人手里的登录都作废」。 */
  app.patch('/auth/password', async (request, reply) => {
    const user = await requireAuth(request);

    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
    }

    const { currentPassword, newPassword } = parsed.data;

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw badRequest('当前密码不正确', 'WRONG_PASSWORD');
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) throw badRequest(passwordError, 'INVALID_PASSWORD');

    if (currentPassword === newPassword) {
      throw badRequest('新密码不能与当前密码相同');
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await destroyAllSessionsForUser(user.id);
    clearSessionCookie(reply);

    await logOp({
      actorId: user.id,
      action: 'user.change_password',
      targetType: 'user',
      targetId: user.id,
      targetName: user.username,
      ip: clientIp(request),
    });

    return { ok: true, message: '密码已修改，请重新登录' };
  });
}
