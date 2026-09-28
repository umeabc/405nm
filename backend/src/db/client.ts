import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pgClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  // 建表时的 NOTICE 太多，静音掉；真出问题会在报错里体现。
  onnotice: () => {},
});

export const db = drizzle(pgClient, { schema });

export type Db = typeof db;
/** 事务句柄。把服务层写成接受 DbLike，就能在事务内外复用同一段逻辑。 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbLike = Db | Tx;

export async function closeDb(): Promise<void> {
  await pgClient.end({ timeout: 5 });
}
