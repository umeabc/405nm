/**
 * 第三步：图片字节 → files → file_credits → file_states。
 *
 * 图片是迁移里唯一**搬字节**的地方。几条刻意的做法：
 *  - 字节取不到时照样写一行（尺寸/摘要为空）—— 少一行会让它的标号、译文整片对不上，
 *    而空行至少让人在界面上看见「这张图没了」，并且能重传；
 *  - 有字节但读不出尺寸（损坏或格式不支持）时，**字节照样存下来**，只是宽高为 0；
 *  - 重跑时已有的行不再取图（`size > 0` 即视为已搬完），所以中断后重跑是「接着搬」，
 *    而不是把几万张图重下一遍；上一次因为缺字节而落成空行的，这次会重试。
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fileCredits, fileStates, files } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { digest, processImage } from '../lib/image.js';
import { isAllowedImageExt, newFileKey, variantKey } from '../storage/keys.js';
import { storage } from '../storage/index.js';
import type { Ctx } from './plan.js';
import { creditRows, fileRow, type Derived, type FileFacts } from './rows.js';
import { type Doc, lid, oidTime, str } from './source.js';
import { Report } from './report.js';
import { chunk, eachChunk, insertById, mapPool, INSERT_CHUNK } from './util.js';

const FETCH_CHUNK = 50;
const FETCH_CONCURRENCY = 6;
/** 迁移比上传宽松：旧库里有超过默认 20MB 的整页扫图，按上传上限处理会把它们判成「坏图」。 */
const MIGRATE_MAX_MB = 1024;

/** 扩展名取旧站的 `save_name`（实际落盘名），退到显示名。认不出就用 `.bin`。 */
function extOf(doc: Doc): { ext: string; unknown: boolean } {
  const name = str(doc.sa).trim() || str(doc.n).trim();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return { ext: '.bin', unknown: true };
  return { ext, unknown: !isAllowedImageExt(ext) };
}

type Ingested = { key: string; facts: FileFacts; stored: boolean };

/**
 * 一张图：取到的字节 → 落盘（原图 + 两个变体）→ 事实。
 * 缺字节时**不落盘**，返回空事实 —— 行还是会写，让这张图在界面上可见（占位图），也便于日后重传。
 */
async function ingestBytes(ctx: Ctx, doc: Doc, buffer: Buffer | null): Promise<Ingested> {
  const { ext, unknown } = extOf(doc);
  if (unknown) {
    ctx.report.lose('file-ext-unknown', '文件名的扩展名认不出：存储键用 .bin（不影响看图，只影响按扩展名挑选的场景）', doc._id, false);
  }
  // 键与 fileRow 里算出来的必须一致：都由 id + 扩展名 + 入库时间派生
  const key = newFileKey(lid('file', doc._id), ext, oidTime(doc._id));

  if (!buffer) {
    // 旧站自己就知道这张图没了（未上传/已删除/被拦）与「我们取不到」是两件事：
    // 前者是旧库的既成事实，后者说明迁移的图源配置有问题。混成一类会掩盖真问题。
    const fn = Number(doc.fn ?? 0);
    if (fn === 1 || fn === 2 || fn === 4) {
      ctx.report.lose('file-bytes-absent-in-legacy', '旧站本来就没有这张图的字节（未上传/已删除/被拦）：只建空记录，界面显示占位图', doc._id, false);
    } else {
      ctx.report.lose('file-bytes-missing', '旧存储里找不到这张图：只建空记录，需要人工补图', doc._id);
    }
    return { key, facts: { ext, size: 0, md5: '', sha256: '', width: 0, height: 0 }, stored: false };
  }

  let facts: FileFacts;
  let thumb: Buffer | null = null;
  let preview: Buffer | null = null;
  try {
    const info = await processImage(buffer, { maxMb: MIGRATE_MAX_MB });
    facts = { ext, size: info.size, md5: info.md5, sha256: info.sha256, width: info.width, height: info.height };
    thumb = info.thumb;
    preview = info.preview;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    // 读不出尺寸不等于没有字节：原图照存，宽高记 0 —— 界面上还能看到它
    ctx.report.lose('file-unprocessable', '字节取到了但读不出尺寸（多半是旧库里的损坏文件）：原图照存，宽高记 0', doc._id);
    facts = { ext, ...digest(buffer), width: 0, height: 0 };
  }
  const legacyMd5 = str(doc.md).trim().toLowerCase();
  if (legacyMd5 && legacyMd5 !== facts.md5) {
    ctx.report.lose('file-md5-mismatch', '取到的字节与旧库记的 md5 不一致：以实际字节为准（旧库的 md 多是过期缓存）', doc._id);
  }

  // 先落盘再写库：反过来的话，中途失败会留下指向不存在对象的行
  await storage.put(key, buffer);
  if (thumb && preview) {
    await storage.put(variantKey(key, 'thumb'), thumb);
    await storage.put(variantKey(key, 'preview'), preview);
  }
  return { key, facts, stored: true };
}

export async function stepFiles(ctx: Ctx, _d: Derived): Promise<void> {
  const { plan, report, content } = ctx;
  const docOf = new Map(plan.files.map((f) => [lid('file', f._id), f] as const));
  const allIds = [...docOf.keys()];

  if (!ctx.images) {
    report.check(
      'image-source',
      'confirm',
      '没给图片字节的来源（--images-dir 或 --images-base-url）：只迁元数据，图片一律是空记录',
    );
  } else {
    report.note(`图片字节来源：${ctx.images.describe()}`);
  }

  // 已存在的行：`size > 0` 即视为字节搬完了，重跑直接跳过；`size = 0` 是上次缺图的占位行，这次重试。
  // 没有这一步的话，中断后重跑会把几万张图重下一遍。
  const present = new Map<string, number>();
  for (const batch of chunk(allIds, 1000)) {
    if (!batch.length) continue;
    const rows = await db.select({ id: files.id, size: files.size }).from(files).where(inArray(files.id, batch));
    for (const row of rows) present.set(row.id, row.size);
  }
  const pending = allIds.filter((id) => !(present.get(id)! > 0));

  const sink = new Report(true);
  let inserted = 0;
  for (const batch of chunk(pending, FETCH_CHUNK)) {
    const built = await mapPool(batch, FETCH_CONCURRENCY, async (id) => {
      const doc = docOf.get(id)!;
      const saveName = str(doc.sa).trim();
      const buffer = ctx.images && saveName ? await ctx.images.fetch(saveName) : null;
      const { key, facts } = await ingestBytes(ctx, doc, buffer);
      return { id, key, facts, row: fileRow(doc, plan, content, facts) };
    });
    const fresh = built.filter((b) => !present.has(b.id)).map((b) => b.row);
    if (fresh.length) inserted += await insertById(db, files as never, fresh, sink, 'files');
    // 上次落成空行的：这一次拿到了字节，就地补上（存储键不变，只更新事实）
    for (const b of built) {
      if (!present.has(b.id) || b.facts.size === 0) continue;
      await db
        .update(files)
        .set({
          size: b.facts.size,
          width: b.facts.width,
          height: b.facts.height,
          md5: b.facts.md5,
          sha256: b.facts.sha256,
        })
        .where(eq(files.id, b.id));
      report.note(`补图：${b.id}`);
    }
  }
  report.count('files', plan.files.length, inserted, plan.files.length - inserted);

  // 署名台账：**顺序即显示顺序**，逐行插入保留旧站 tokens 的先后
  const credits = plan.files.flatMap((f) => creditRows(f, plan, oidTime(f._id)));
  await insertById(db, fileCredits as never, credits, report, 'file_credits');

  // 状态流水：迁移不还原旧站的「历史」，只按现有译校进度给一个当前态
  const haveStates = new Set<string>();
  for (const batch of chunk(allIds, 1000)) {
    if (!batch.length) continue;
    const rows = await db.select({ fileId: fileStates.fileId }).from(fileStates).where(inArray(fileStates.fileId, batch));
    for (const row of rows) haveStates.add(row.fileId);
  }
  const stateRows = plan.files
    .filter((f) => !haveStates.has(lid('file', f._id)))
    .map((f) => ({
      fileId: lid('file', f._id),
      fromState: null,
      toState: content.fileState.get(f._id) ?? 'sourced',
      actorId: null,
      note: 'moeflow 迁移：按译校进度推定（旧站没有状态机）',
      createdAt: oidTime(f._id),
    }));
  await eachChunk(stateRows, INSERT_CHUNK, async (batch) => {
    await db.insert(fileStates).values(batch);
  });
  report.count('file_states', plan.files.length, stateRows.length, haveStates.size);
}
