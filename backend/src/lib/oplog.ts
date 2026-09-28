import { db } from '../db/client.js';
import { opLogs } from '../db/schema.js';

/**
 * 操作日志。写日志失败**不能**影响业务本身 —— 所以这里吞掉异常只打警告，
 * 而不是让它冒泡把一次成功的操作变成 500。
 */
export type OpLogInput = {
  actorId?: string | null;
  teamId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  detail?: unknown;
  ip?: string | null;
};

export async function logOp(input: OpLogInput): Promise<void> {
  try {
    await db.insert(opLogs).values({
      actorId: input.actorId ?? null,
      teamId: input.teamId ?? null,
      action: input.action,
      targetType: input.targetType ?? '',
      targetId: input.targetId ?? '',
      targetName: input.targetName ?? '',
      detail: (input.detail ?? null) as never,
      ip: input.ip ?? null,
    });
  } catch (err) {
    console.warn('[oplog] 写操作日志失败：', err instanceof Error ? err.message : err);
  }
}
