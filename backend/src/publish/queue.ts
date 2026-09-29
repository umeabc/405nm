import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { publishAttempts, publishJobs, type PublishJob } from '../db/schema.js';
import { env } from '../env.js';

/**
 * 发布队列的**认领与回收**。
 *
 * 旧实现（380nm）的调度器有三个缺陷，这里逐个修掉 —— 每一条都在源码里
 * 确认过，不是假想的风险：
 *
 *  1. **非原子认领**：`tick()` 先把全部任务读进内存、过滤出到期的，再逐条
 *     `updateJob({status:'publishing'})` —— 读与写之间有窗口，两个进程会
 *     拿到同一条。这里改成 `FOR UPDATE SKIP LOCKED` 的**单条 UPDATE**，
 *     认领与置状态在同一个语句里完成。
 *  2. **进程内 `_busy` 标志位**：只在一个进程内有效，多实例部署形同虚设。
 *     这里用 `claimed_at` + `lease_expires_at`，认领状态在**数据库**里。
 *  3. **`recover()` 把卡住的任务直接改回 `pending`**：那是**静默重发**。
 *     发布接口没有幂等参数，`publishing` 且已有 in-flight 发布尝试的任务
 *     必须交人工（见 `recoverStalled`）。
 */

/**
 * 把卡住的任务放回队列。返回处理了几条。
 *
 * ⚠️ 条件里那句 `NOT EXISTS (... in_flight)` 是**安全阀**：
 * 只回收「没有任何悬空发布尝试」的任务。有 in-flight 发布尝试意味着
 * 「我们可能已经把动态发出去了」，那种任务由 `recoverStalled` 交人工，
 * **绝不能在这里被放回队列** —— 那正是重复动态的来源。
 *
 * （`lease_expires_at < now()` 在 NULL 上求值为 NULL，不会被匹配，
 * 所以「还没被认领过的任务」天然不受影响。）
 */
export async function reclaimExpired(limit = 50): Promise<number> {
  const result = await db.execute(sql`
    UPDATE publish_jobs SET
      status           = 'pending',
      claimed_at       = NULL,
      lease_expires_at = NULL,
      last_error       = '上一个 worker 超时未完成，已回收重新排队',
      updated_at       = now()
    WHERE id IN (
      SELECT id FROM publish_jobs
       WHERE status = 'publishing'
         AND lease_expires_at < now()
         AND NOT EXISTS (
           SELECT 1 FROM publish_attempts a
            WHERE a.job_id = publish_jobs.id
              AND a.phase = 'publish'
              AND a.status = 'in_flight'
         )
       ORDER BY lease_expires_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);

  return toRows<{ id: string }>(result).length;
}

export type StalledReport = { needsReview: string[] };

/**
 * 启动时（以及每次 tick 时）把「可能已经发出去了」的任务挑出来交人工。
 *
 * 判据只有一条：存在 `phase='publish'` 且仍是 `in_flight` 的尝试。
 * 那条记录是在调 `createDynamic` **之前**写的，所以它的存在就等价于
 * 「我们发出过一次，但不知道结果」。
 *
 * **绝不自动重发**：B 站的发布接口没有幂等参数，重试的代价是粉丝看到两条
 * 一模一样的动态 —— 那比让运营点一下「确认」严重得多。
 */
export async function recoverStalled(): Promise<StalledReport> {
  const stuck = await db
    .selectDistinct({ jobId: publishAttempts.jobId })
    .from(publishAttempts)
    .where(and(eq(publishAttempts.phase, 'publish'), eq(publishAttempts.status, 'in_flight')));

  if (stuck.length === 0) return { needsReview: [] };

  const ids = stuck.map((s) => s.jobId);

  // 已经发布成功的不用再问 —— 那是「写库晚了一步」，结果其实是好的
  const rows = await db
    .update(publishJobs)
    .set({
      status: 'needs_review',
      leaseExpiresAt: null,
      lastError:
        '上一次发布请求发出后进程中断，无法确认是否已经发出。请到 B 站确认后再决定是否重发 —— 系统不会自动重发。',
      updatedAt: new Date(),
    })
    // ⚠️ 这里**必须**用 inArray，不能写 `sql\`= ANY(${ids})\``。
    // postgres.js 会把数组绑成**一个**参数，而 `ANY($5)` 拿到一个字符串时
    // 会当成数组字面量去解析，报 `malformed array literal`（22P02）。
    // 它被调用处裹在 try/catch 里，所以症状是**这道安全网从来没生效过**、
    // 只是每 3 秒往日志里刷一条错误 —— 由 m6-verify 抓出来。
    .where(and(inArray(publishJobs.id, ids), sql`${publishJobs.status} <> 'published'`))
    .returning({ id: publishJobs.id });

  return { needsReview: rows.map((r) => r.id) };
}

/**
 * 原子认领一批到期的任务。
 *
 * 整件事在**一条 UPDATE** 里完成：子查询选出 id 并加 `FOR UPDATE SKIP LOCKED`，
 * 外层直接把这批行改成 `publishing` 并写租约。两个 worker 同时跑，
 * 数据库保证同一条只会被一个拿到。
 */
export async function claimDueJobs(limit = env.PUBLISH_BATCH): Promise<PublishJob[]> {
  const result = await db.execute(sql`
    UPDATE publish_jobs SET
      status        = 'publishing',
      claimed_at    = now(),
      lease_expires_at = now() + make_interval(mins => ${env.PUBLISH_LEASE_MINUTES}),
      attempts      = attempts + 1,
      updated_at    = now()
    WHERE id IN (
      SELECT id FROM publish_jobs
       WHERE status = 'pending'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= now()
       ORDER BY scheduled_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return toRows<PublishJob>(result);
}

/** 长任务续租，免得跑到一半被另一个 worker 判为超时回收。 */
export async function renewPublishLease(jobId: string): Promise<void> {
  await db
    .update(publishJobs)
    .set({
      leaseExpiresAt: new Date(Date.now() + env.PUBLISH_LEASE_MINUTES * 60_000),
      updatedAt: new Date(),
    })
    .where(eq(publishJobs.id, jobId));
}

/** 开始一次尝试：**两阶段标记的第一步**。返回这次尝试的行 id。 */
export async function beginAttempt(
  jobId: string,
  phase: 'upload_images' | 'publish',
  attempt: number,
  detail = '',
): Promise<string> {
  const rows = await db
    .insert(publishAttempts)
    .values({ jobId, phase, status: 'in_flight', attempt, detail })
    .returning({ id: publishAttempts.id });
  const id = rows[0]?.id;
  if (!id) throw new Error('写入发布尝试记录失败');
  return id;
}

/** 收尾一次尝试。 */
export async function finishAttempt(
  attemptId: string,
  status: 'succeeded' | 'failed',
  detail = '',
): Promise<void> {
  await db
    .update(publishAttempts)
    .set({ status, detail: detail.slice(0, 1000), finishedAt: new Date() })
    .where(eq(publishAttempts.id, attemptId));
}

/** 有没有悬空的发布尝试（供界面提示与健康检查用）。 */
export async function countInFlight(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(publishAttempts)
    .where(and(eq(publishAttempts.phase, 'publish'), eq(publishAttempts.status, 'in_flight'), isNull(publishAttempts.finishedAt)));
  return Number(row?.total ?? 0);
}

/** drizzle 的 `db.execute` 在不同驱动下返回形状略有差异，统一收成数组。 */
export function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = (result as { rows?: unknown }).rows;
  return Array.isArray(maybe) ? (maybe as T[]) : [];
}
