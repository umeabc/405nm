import { defineConfig } from 'drizzle-kit';

/**
 * 迁移文件是提交进仓库的 SQL（`backend/drizzle/`），便于 review 与手工补写
 * 触发器 / 视图 / 部分唯一索引 —— 这些 Drizzle 的 schema DSL 表达不了。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://405nm:405nm@127.0.0.1:5432/nm405',
  },
  strict: true,
  verbose: true,
});
