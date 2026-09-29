import { env } from '../env.js';
import { claimImportTasks, MAX_IMPORT_ATTEMPTS } from '../sourcing/queue.js';
import { runImportTask } from '../sourcing/importer.js';
import { claimDueJobs, reclaimExpired, recoverStalled, renewPublishLease } from '../publish/queue.js';
import { runPublishJob } from '../publish/runner.js';
import { checkAllAccounts } from '../publish/accounts.js';

/**
 * worker 容器入口 —— 与 backend 共用同一个镜像，只换 `command`。
 *
 * 长驻任务都归这里：导入任务、发布队列调度、Cookie 巡检、AI 批量、统计重算。
 *
 * **backend 绝不能起这些循环**：两个容器各跑一份，就会出现「同一条链接被导入两遍」
 * 「同一条动态发两次」。真正兜底的是队列的原子认领 + 租约
 * （见 `sourcing/queue.ts` 与 `publish/queue.ts`），但入口隔离是第一道。
 */

const TICK_MS = 3000;
/** Cookie 巡检是慢活，单独排一个低频的计时器，不跟 tick 抢。 */
const COOKIE_CHECK_MS = env.PUBLISH_COOKIE_CHECK_MINUTES * 60_000;

let stopping = false;

async function checkDatabase(): Promise<void> {
  const { db } = await import('../db/client.js');
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`select 1`);
}

function log(message: string, extra?: object): void {
  if (extra) console.log(message, extra);
  else console.log(message);
}

/**
 * 一次 tick：认领若干导入任务与发布任务，串行跑完。
 *
 * **串行跑**而不是并发 —— 抓取那一路本来就有自己的并发闸门
 * （`SOURCING_CONCURRENCY`），发布那一路更不该并发（同一个账号同时发多条
 * 容易被风控，也让「谁先谁后」变得说不清）。一次 tick 跑 1–3 条，够用且可解释。
 */
async function tick(): Promise<boolean> {
  let didWork = false;

  // ── 回收：先处理「上一轮没跑完的」，再认领新的 ──────────────
  //
  // ⚠️ 顺序要紧：`recoverStalled` 会把「可能已经发出去了」的任务标成
  // `needs_review`，必须在 `reclaimExpired` 之前跑 —— 反过来的话，
  // 那些任务会先被当成超时任务放回 `pending`，下一个 tick 就**真的重发了**。
  //
  // 这正是旧实现（380nm）的 bug：它的 `recover()` 把卡在 publishing 的任务
  // 一律改回 pending。这里把两件事拆开，且顺序不可交换。
  try {
    const stalled = await recoverStalled();
    if (stalled.needsReview.length > 0) {
      didWork = true;
      log('[publish] 有任务无法确认是否已发出，已转人工确认', { jobs: stalled.needsReview });
    }
    const reclaimed = await reclaimExpired();
    if (reclaimed > 0) {
      didWork = true;
      log('[publish] 回收了超时未完成的任务', { count: reclaimed });
    }
  } catch (err) {
    console.error('[worker] 回收发布任务失败：', err instanceof Error ? err.message : err);
  }

  const importIds = await claimImportTasks(env.IMPORT_BATCH);
  for (const id of importIds) {
    if (stopping) return true;
    didWork = true;
    try {
      await runImportTask(id, log);
    } catch (err) {
      // 跑到这里说明连「记录失败」都没成功（比如数据库刚断）。
      // 任务本身还持有租约，下一个 tick 会把它回收重试 —— 不需要在这里做别的。
      console.error('[worker] 导入任务异常：', err instanceof Error ? err.message : err);
    }
  }

  const publishJobs = await claimDueJobs();
  for (const job of publishJobs) {
    if (stopping) return true;
    didWork = true;
    try {
      const outcome = await runPublishJob(job, log);
      if (outcome.status !== 'published') {
        log('[publish] 任务未成功', { jobId: job.id, status: outcome.status, reason: outcome.reason });
      }
    } catch (err) {
      // runPublishJob 内部已经把失败落库了；能抛到这里说明是数据库级别的问题。
      // 任务仍是 `publishing`，租约到期后由 reclaimExpired（或 recoverStalled）接管。
      console.error('[worker] 发布任务异常：', err instanceof Error ? err.message : err);
      await renewPublishLease(job.id).catch(() => {});
    }
  }

  return didWork;
}

/** Cookie 巡检：单独一条线，失败不影响 tick。 */
async function cookieLoop(): Promise<void> {
  // 启动后等一会儿再查，避免和启动时的其它初始化撞在一起
  await sleep(8000);
  while (!stopping) {
    try {
      const report = await checkAllAccounts(log);
      if (report.checked > 0) {
        log('[publish] Cookie 巡检完成', report);
      }
    } catch (err) {
      console.error('[worker] Cookie 巡检失败：', err instanceof Error ? err.message : err);
    }
    await sleep(COOKIE_CHECK_MS);
  }
}

async function main(): Promise<void> {
  console.log(`[worker] 启动，环境=${env.NODE_ENV}，存储目录=${env.STORAGE_DIR}`);

  try {
    await checkDatabase();
    console.log('[worker] 数据库连通正常');
  } catch (err) {
    console.error('[worker] 数据库连接失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] 收到 ${signal}，退出`);
      stopping = true;
    });
  }

  console.log(
    `[worker] 开始轮询任务，每 ${TICK_MS}ms 一次；` +
      `每次最多 ${env.IMPORT_BATCH} 条导入、${env.PUBLISH_BATCH} 条发布`,
  );

  // 启动时先把「可能已经发出去了」的任务挑出来 —— 这一步不能等第一个 tick，
  // 因为 tick 里的认领逻辑会把它们当普通任务看待。
  try {
    const stalled = await recoverStalled();
    if (stalled.needsReview.length > 0) {
      log('[publish] 启动检查：有任务无法确认是否已发出，已转人工确认', {
        jobs: stalled.needsReview,
      });
    }
  } catch (err) {
    console.error('[worker] 启动检查失败：', err instanceof Error ? err.message : err);
  }

  void cookieLoop();

  // 空转时慢一点、有活时立刻接上：轮询间隔固定会有「刚提交要等 3 秒」的手感问题，
  // 所以有活的时候不等，直接把下一轮排进去。
  while (!stopping) {
    let didWork = false;
    try {
      didWork = await tick();
    } catch (err) {
      console.error('[worker] tick 失败：', err instanceof Error ? err.message : err);
    }
    if (!didWork) await sleep(TICK_MS);
  }

  console.log('[worker] 已停止');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 供测试与运维排查用：把「认领了几次」「上限多少」暴露出来。 */
export { MAX_IMPORT_ATTEMPTS };

await main();
