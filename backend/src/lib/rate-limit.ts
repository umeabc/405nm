import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * 数据库支撑的定长窗口限流。
 *
 * 为什么不放内存：重启就清零，多实例也不共享 —— 后者在「backend 与 worker 同镜像」
 * 的部署形态下是必然会踩到的。表很小，一次 upsert 的成本可以忽略。
 *
 * 单条语句完成「过期就重置、否则自增」，因此天然并发安全，不需要显式事务。
 */

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  /** 被拒时还需等多久（毫秒） */
  retryAfterMs: number;
};

export async function consumeRateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const rows = await db.execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limits (bucket, window_start, count, updated_at)
    values (${bucket}, now(), 1, now())
    on conflict (bucket) do update
      set count = case
            when rate_limits.window_start < now() - ${sql.raw(`interval '${Math.floor(windowMs / 1000)} seconds'`)}
              then 1
            else rate_limits.count + 1
          end,
          window_start = case
            when rate_limits.window_start < now() - ${sql.raw(`interval '${Math.floor(windowMs / 1000)} seconds'`)}
              then now()
            else rate_limits.window_start
          end,
          updated_at = now()
    returning count, window_start
  `);

  const row = rows[0];
  if (!row) {
    // 理论上不会发生；宁可放行也不要因为限流组件自身故障把注册全堵死。
    return { allowed: true, count: 0, limit, retryAfterMs: 0 };
  }

  const count = Number(row.count);
  const allowed = count <= limit;

  return {
    allowed,
    count,
    limit,
    retryAfterMs: allowed ? 0 : Math.max(0, new Date(row.window_start).getTime() + windowMs - Date.now()),
  };
}

/** 限流通过后因为业务原因失败（比如邀请码错），把它吐回去，别让用户白耗配额。 */
export async function resetRateLimit(bucket: string): Promise<void> {
  await db.execute(sql`delete from rate_limits where bucket = ${bucket}`);
}

/**
 * 只读探测，不自增。
 * 登录用它先判「还能不能试」，失败时再 consume —— 这样限的是失败次数，
 * 而不是请求次数（正常用户一天登十次也不该被挡）。
 */
export async function isRateLimited(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const rows = await db.execute<{ count: number; window_start: Date }>(sql`
    select count, window_start from rate_limits where bucket = ${bucket} limit 1
  `);
  const row = rows[0];
  if (!row) return false;
  if (Date.now() - new Date(row.window_start).getTime() >= windowMs) return false;
  return Number(row.count) >= limit;
}
