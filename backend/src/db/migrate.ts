/**
 * 运行期迁移入口（用 drizzle-orm 自带的 migrator，不依赖 devDependency 的 drizzle-kit）。
 *
 *   docker compose run --rm backend node backend/dist/db/migrate.js
 *
 * 与本地开发用的 `npm run migrate`（drizzle-kit migrate）作用相同：
 * 都是把 backend/drizzle/ 下的 SQL 依序应用一遍，已应用过的会跳过。
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDb, db } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/db/migrate.js → 上溯到 backend/drizzle
const migrationsFolder = path.resolve(here, '../../drizzle');

console.log(`[migrate] 迁移目录：${migrationsFolder}`);

try {
  await migrate(db, { migrationsFolder });
  console.log('[migrate] 完成');
} catch (err) {
  console.error('[migrate] 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
