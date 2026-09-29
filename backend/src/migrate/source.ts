/**
 * moeflow 导出快照的读取 + 确定性 ID。
 *
 * 快照目录的约定（由 deploy/moeflow-export.sh 产出，全程只读）：
 *   <dir>/manifest.json   { "exportedAt": "...", "collections": { "<集合>": <导出那一刻 Mongo 里的文档数> } }
 *   <dir>/<集合>.json      mongoexport 的 relaxed EJSON，一行一个文档
 * manifest 的计数用来发现**被截断的导出** —— 否则少导一截也会被当成「源数据就这么多」。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export type Doc = Record<string, unknown> & { _id: string };

/** EJSON 包装类型还原：ObjectId → 24 位 hex 串，日期 → Date，各种数字 → number。 */
export function decodeEjson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeEjson);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const v = obj[keys[0]!];
    switch (keys[0]) {
      case '$oid':
        return String(v);
      case '$date':
        if (typeof v === 'string' || typeof v === 'number') return new Date(v);
        return new Date(Number((v as { $numberLong?: string } | null)?.$numberLong));
      case '$numberLong':
      case '$numberInt':
      case '$numberDouble':
      case '$numberDecimal':
        return Number(v);
      default:
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = decodeEjson(obj[k]);
  return out;
}

export type Manifest = { exportedAt?: string; collections: Record<string, number> };

export class MoeflowExport {
  private readonly cache = new Map<string, Doc[]>();

  constructor(readonly dir: string) {}

  async manifest(): Promise<Manifest> {
    const parsed = JSON.parse(await fs.readFile(path.join(this.dir, 'manifest.json'), 'utf8')) as Manifest;
    if (!parsed || typeof parsed.collections !== 'object') throw new Error('manifest.json 缺少 collections');
    return parsed;
  }

  /** 目录里实际存在的集合文件。 */
  async collectionFiles(): Promise<string[]> {
    const names = await fs.readdir(this.dir);
    return names.filter((n) => n.endsWith('.json') && n !== 'manifest.json').map((n) => n.slice(0, -5));
  }

  /** 逐行流式读取（大集合用）。集合文件不存在视为空 —— 缺文件由 manifest 校验兜住。 */
  async *stream(name: string): AsyncGenerator<Doc> {
    const file = path.join(this.dir, `${name}.json`);
    try {
      await fs.access(file);
    } catch {
      return;
    }
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(`${name}.json 第 ${lineNo} 行不是合法 JSON：${(err as Error).message}`);
      }
      const doc = decodeEjson(parsed) as Doc;
      doc._id = String(doc._id);
      yield doc;
    }
  }

  /** 整个读进内存并按 _id 排序（小集合用）。排序让处理顺序与导出顺序无关 —— 重跑结果才稳定。 */
  async all(name: string): Promise<Doc[]> {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const docs: Doc[] = [];
    for await (const doc of this.stream(name)) docs.push(doc);
    docs.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    this.cache.set(name, docs);
    return docs;
  }

  async lineCount(name: string): Promise<number | null> {
    const file = path.join(this.dir, `${name}.json`);
    try {
      await fs.access(file);
    } catch {
      return null;
    }
    let n = 0;
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) n += 1;
    return n;
  }
}

// ── 确定性 ID ────────────────────────────────────────────────

/** 固定命名空间 = uuidv5(DNS, 'migrate.405nm')。**永远不要改** —— 改了重跑就会生成另一套 ID。 */
export const NS_405NM = '08f3146f-c430-593c-b348-8dec45e96465';

export function uuidv5(name: string, namespace: string = NS_405NM): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 某集合某文档在新库里的主键。同一文档永远得到同一个 ID —— 重跑因此天然幂等。 */
export const lid = (collection: string, oid: string): string => uuidv5(`moeflow:${collection}:${oid}`);

/** `legacy_id` 列的值：带集合名，一眼能看出来源。 */
export const legacyRef = (collection: string, oid: string): string => `moeflow:${collection}:${oid}`;

/** ObjectId 前 4 字节是秒级时间戳 —— 没有显式时间字段的文档拿它当创建时间。 */
export function oidTime(oid: string): Date {
  return /^[0-9a-f]{24}$/.test(oid) ? new Date(parseInt(oid.slice(0, 8), 16) * 1000) : new Date(0);
}

export const dateOr = (value: unknown, oid: string): Date =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : oidTime(oid);

export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** 引用字段 → ObjectId 串；不是合法引用就是 null。 */
export const ref = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{24}$/.test(v) ? v : null);
