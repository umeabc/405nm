/**
 * 迁移的通用工具：分批读写 + 稳定指纹。
 *
 * 分批不是为了快，是为了**不炸内存** —— 生产库有几万张图、上百万条标号与译文，
 * 后端容器上限 320MB，一次 `insert ... values (10 万行)` 光是构造语句就没了。
 * 批次取 500：足够摊薄往返，又让单批参数远低于 Postgres 的 65535 上限。
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DbLike } from '../db/client.js';
import type { Report } from './report.js';

export const INSERT_CHUNK = 500;
const SELECT_CHUNK = 5000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/** 逐批执行。回调里自己做 insert —— 目标表与冲突目标各不相同，交给调用点更直白。 */
export async function eachChunk<T, R>(
  items: readonly T[],
  size: number,
  fn: (batch: T[], index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let index = 0;
  for (const batch of chunk(items, size)) out.push(await fn(batch, index++));
  return out;
}

/** 库里已存在的主键。**分批查**：`in (10 万个 id)` 会被 Postgres 直接拒掉。 */
export async function existingIds(
  tx: DbLike,
  table: PgTable,
  column: PgColumn,
  ids: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const batch of chunk(ids, SELECT_CHUNK)) {
    if (!batch.length) continue;
    const rows = (await tx.select({ id: column }).from(table).where(inArray(column, batch))) as Array<{ id: unknown }>;
    for (const row of rows) found.add(String(row.id));
  }
  return found;
}

// ── 幂等写入 ────────────────────────────────────────────────

/**
 * 按主键插入，**先查已存在再插**。
 *
 * 幂等的做法有两种：直接 `onConflictDoNothing` 让库去判，或先查一遍再只插缺的。
 * 大表（标号、译文、图片）上必须用后者：重跑时前者仍要把上百万行发到库上再逐行判冲突，
 * 而重跑恰恰是常态（中断后接着跑）。只查主键的代价远小于重发整表。
 */
export async function insertById<T extends { id?: unknown }>(
  tx: DbLike,
  table: PgTable & { id: PgColumn },
  rows: readonly T[],
  report: Report,
  name: string,
): Promise<number> {
  if (!rows.length) {
    report.count(name, 0, 0, 0);
    return 0;
  }
  // `$inferInsert` 把有默认值的列标成可选，所以断言「必有 id」放在这里，而不是靠类型
  const have = await existingIds(tx, table, table.id, rows.map((r) => String(r.id)));
  const missing = rows.filter((r) => !have.has(String(r.id)));
  await eachChunk(missing, INSERT_CHUNK, async (batch) => {
    await tx.insert(table).values(batch as never).onConflictDoNothing({ target: table.id });
  });
  report.count(name, rows.length, missing.length, rows.length - missing.length);
  return missing.length;
}

/** 复合主键 / 无主键的关联表：冲突目标是那几列的组合，交给库去判最省事。 */
export async function insertRows<T>(
  tx: DbLike,
  table: PgTable,
  rows: readonly T[],
  report: Report,
  name: string,
  /** 冲突目标：复合主键的那几列。不传就让库按任意唯一约束判。 */
  target?: PgColumn | PgColumn[],
): Promise<number> {
  if (!rows.length) {
    report.count(name, 0, 0, 0);
    return 0;
  }
  let inserted = 0;
  await eachChunk(rows, INSERT_CHUNK, async (batch) => {
    const insertedRows = (await tx
      .insert(table)
      .values(batch as never)
      .onConflictDoNothing(target as never)
      .returning()) as unknown[];
    inserted += insertedRows.length;
  });
  report.count(name, rows.length, inserted, rows.length - inserted);
  return inserted;
}

/**
 * 有限并发地跑一遍。用来把「取图 → 处理 → 落盘」的等待叠起来：
 * 串行取几万张图要几小时，而这里的瓶颈是网络与磁盘，不是 CPU
 * （vips 那边另有自己的并发闸门，两层各管各的，不会互相打架）。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ── 稳定表示与指纹 ──────────────────────────────────────────

/**
 * 规范 JSON：对象键排序、Date 转 ISO、undefined 与缺失一律写 null。
 *
 * 迁移与核验各自构造一次同一行（一边是内存里的期望值，一边是 Postgres 读回来的），
 * 两边形状并不完全一样：Postgres 会把 `numeric` 读成字符串、把缺失的可空列读成 null。
 * 先把两边都过成同一种文本，比对才有意义 —— 否则会淹在「'0' vs 0」这种噪声里。
 */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = norm(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 一行内容的指纹：先规范化再取 sha256。字段顺序、undefined/null 的差异都不会影响它。 */
export const rowHash = (row: unknown): string => sha256(canonical(row));

/**
 * 与顺序无关的行集指纹：逐行 sha256 后按位 XOR。
 *
 * 用 XOR 而不是「拼起来再取一次哈希」是因为**读回来的顺序不可控**：
 * 迁移按旧库顺序写，核验按 id 批量查，两边顺序天然不同。
 * XOR 交换律成立，于是「同一批行、任意顺序」得到同一个值 —— 少一次全量排序。
 */
export class Fingerprint {
  private readonly acc = Buffer.alloc(32);

  add(row: unknown): void {
    this.addHash(rowHash(row));
  }

  addHash(hex: string): void {
    const hash = Buffer.from(hex, 'hex');
    for (let i = 0; i < 32; i += 1) this.acc[i] = (this.acc[i] ?? 0) ^ (hash[i] ?? 0);
  }

  get value(): string {
    return this.acc.toString('hex');
  }
}
