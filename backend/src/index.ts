import { buildServer } from './api/server.js';
import { closeDb } from './db/client.js';
import { ensurePermissionCatalog } from './domain/team-roles.js';
import { env } from './env.js';

// 权限码目录是代码定义的词表，启动时同步进库（幂等）。
// 放在 listen 之前：宁可起不来，也不要带着一套过期的权限码对外服务。
await ensurePermissionCatalog();

const app = await buildServer();

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info(`405nm backend 已启动：http://${env.HOST}:${env.PORT}/api/health`);

/**
 * 注意：调度器与抓取任务**只在 worker 进程里跑**（见 src/worker/index.ts）。
 * API 进程绝不能起调度循环，否则两个容器会同时发布，产生重复动态。
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`收到 ${signal}，正在关闭…`);
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, '关闭失败');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
