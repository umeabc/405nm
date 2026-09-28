import { env } from '../env.js';
import { claimImportTasks, MAX_IMPORT_ATTEMPTS } from '../sourcing/queue.js';
import { runImportTask } from '../sourcing/importer.js';

/**
 * worker 容器入口 —— 与 backend 共用同一个镜像，只换 `command`。
 *
 * 长驻任务都归这里：导入任务、发布队列调度、AI 批量、Cookie 巡检、统计重算。
 *
 * **backend 绝不能起这些循环**：两个容器各跑一份，就会出现「同一条链接被导入两遍」
 * 「同一条动态发两次」。真正兜底的是队列的原子认领 + 租约（见 sourcing/queue.ts），
 * 但入口隔离是第一道。
 */

const TICK_MS = 3000;

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
 * 一次 tick：认领若干导入任务并跑完。
 *
 * **串行跑**而不是并发 —— 抓取那一路本来就有自己的并发闸门
 * （`SOURCING_CONCURRENCY`），这里再并发只会让「同时有几个 worker 在干活」
 * 变成一件说不清的事。一次 tick 里跑 1–2 条，够用且可解释。
 */
async function tick(): Promise<boolean> {
  const ids = await claimImportTasks(env.IMPORT_BATCH);
  if (ids.length === 0) return false;

  for (const id of ids) {
    if (stopping) return true;
    try {
      await runImportTask(id, log);
    } catch (err) {
      // 跑到这里说明连「记录失败」都没成功（比如数据库刚断）。
      // 任务本身还持有租约，下一个 tick 会把它回收重试 —— 不需要在这里做别的。
      console.error('[worker] 导入任务异常：', err instanceof Error ? err.message : err);
    }
  }
  return true;
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

  console.log(`[worker] 开始轮询导入任务，每 ${TICK_MS}ms 一次，每次最多 ${env.IMPORT_BATCH} 条`);

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
