import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** 连通性探针：进程活着 + 数据库可达。部署后第一件事就是打这个。 */
  app.get('/health', async () => {
    let databaseOk = false;
    let databaseError: string | undefined;

    try {
      await db.execute(sql`select 1`);
      databaseOk = true;
    } catch (err) {
      databaseError = err instanceof Error ? err.message : String(err);
    }

    return {
      ok: databaseOk,
      service: '405nm-backend',
      version: process.env.npm_package_version ?? '0.1.0',
      database: databaseOk ? 'ok' : 'error',
      ...(databaseError ? { databaseError } : {}),
      time: new Date().toISOString(),
    };
  });
}
