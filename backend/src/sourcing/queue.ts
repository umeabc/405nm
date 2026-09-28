import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';

/**
 * 导入任务的认领。
 *
 * 与发布队列同一套做法，理由也一样：**不能靠进程内的标志位**。
 * 380nm 用的是模块级 `_busy`，单进程时够用，一旦多开一个 worker
 * 同一条链接就会被导入两遍 —— 而「重复导入」这种故障不会报错，
 * 只会在作品里多出一整套重名的图。
 *
 * 两道保险：
 *  1. `FOR UPDATE SKIP LOCKED` —— 两个 worker 同时认领时，各自拿到不同的行，
 *     不会互相等待也不会拿到同一条；
 *  2. **租约** —— worker 认领后崩了，`status` 会永远停在 `running`。
 *     租约到期后由下一个 tick 回收，而不是等人去手工改库。
 */

type Row = { id: string };

export async function claimImportTasks(limit = env.IMPORT_BATCH): Promise<string[]> {
  const result = await db.execute(sql`
    UPDATE import_tasks
       SET status = 'running',
           claimed_at = now(),
           lease_expires_at = now() + make_interval(mins => ${env.IMPORT_LEASE_MINUTES}),
           attempts = attempts + 1,
           started_at = COALESCE(started_at, now()),
           updated_at = now()
     WHERE id IN (
       SELECT id
         FROM import_tasks
        WHERE status = 'pending'
           OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `);

  return (result as unknown as Row[]).map((row) => row.id);
}

/**
 * 续租。
 *
 * 一次导入几百张图可能跑十几分钟，比租约还长。不续租的话，
 * 第二个 worker 会在中途把这条任务重新认领走 —— 于是同一条链接被跑两遍。
 * 每张图之后续一次，代价是一条 UPDATE，换来的是「任务不会被抢走」。
 */
export async function renewImportLease(taskId: string): Promise<void> {
  await db.execute(sql`
    UPDATE import_tasks
       SET lease_expires_at = now() + make_interval(mins => ${env.IMPORT_LEASE_MINUTES}),
           updated_at = now()
     WHERE id = ${taskId} AND status = 'running'
  `);
}

/** 一条链接被认领过几次。超过阈值说明它一直在把 worker 搞崩，值得提醒人看一眼。 */
export const MAX_IMPORT_ATTEMPTS = 3;
