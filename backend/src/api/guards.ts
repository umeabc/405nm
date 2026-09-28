import type { FastifyRequest } from 'fastify';
import { getCurrentUser } from '../auth/session.js';
import type { User } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';

/**
 * 守卫直接抛 AppError，由 errorHandler 统一转响应 ——
 * 路由里就不用到处写 `if (!user) return reply.code(401).send(...)`，
 * 也避免忘了 return 导致「已经回了 401 还继续跑业务逻辑」。
 */
export async function requireAuth(request: FastifyRequest): Promise<User> {
  const user = await getCurrentUser(request);
  if (!user) throw unauthorized();
  return user;
}

export async function requireSiteAdmin(request: FastifyRequest): Promise<User> {
  const user = await requireAuth(request);
  if (!user.isSiteAdmin) throw forbidden('该操作仅站点管理员可用');
  return user;
}

/** 取客户端真实 IP。开了 trustProxy，反代后的 X-Forwarded-For 会被 Fastify 解析。 */
export function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}
