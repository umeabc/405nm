import { env } from '../env.js';

/**
 * worker 容器入口 —— 与 backend 共用同一个镜像，只换 `command`。
 *
 * 长驻任务都归这里：发布队列调度、图源抓取、AI 批量、Cookie 巡检、统计重算。
 * **M0 阶段刻意是空壳**：只做一次数据库连通性自检然后待命，
 * 免得在队列与幂等机制落地之前就引入一个会重复发布的循环。
 */

async function checkDatabase(): Promise<void> {
  const { db } = await import('../db/client.js');
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`select 1`);
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

  console.log('[worker] M0 空壳：调度器 / 抓取 / AI 批量将在 M5、M3、M6 接入。');

  // 待命而不是退出，好让容器编排把它当成常驻服务。
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        console.log(`[worker] 收到 ${signal}，退出`);
        resolve();
      });
    }
  });
}

await main();
