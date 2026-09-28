import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { sessions, users, type User } from '../db/schema.js';
import { cookieSecure, env } from '../env.js';

/**
 * 不用 `__Host-` 前缀：该前缀要求 Secure，而开发态是 http，浏览器会直接拒收 Cookie。
 * 生产态已经在 Cookie 上开了 Secure。
 */
export const SESSION_COOKIE = 'nm405_session';

/** 库里只存哈希；胡椒来自 SESSION_SECRET，DB 泄漏也无法直接拿来登录。 */
function hashToken(token: string): string {
  return createHash('sha256').update(token + env.SESSION_SECRET).digest('hex');
}

export type SessionMeta = { userAgent?: string | undefined; ip?: string | undefined };

export async function createSession(
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<User | null> {
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.user.status !== 'active') return null;
  return row.user;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** 改密码 / 停用账号 / 移出团队时用它把某人的所有端一次踢下线。 */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // 生产必须 HTTPS —— 否则带 Secure 的 Cookie 根本存不下来，表现为「登录不上」。
    // 内网纯 HTTP 的测试部署可通过 COOKIE_SECURE=false 临时放宽。
    secure: cookieSecure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function getCurrentUser(request: FastifyRequest): Promise<User | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  return resolveSession(token);
}
