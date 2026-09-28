import crypto from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { files, outputs, projects } from '../db/schema.js';
import { processImage } from '../lib/image.js';
import { env } from '../env.js';
import { newOutputKey, safeImageExt, storage, variantKey } from '../storage/index.js';

/**
 * 成品（嵌字完成的图）的回传、列出与删除。
 *
 * 这是「离线 PS 嵌字」闭环的回程：工程包出去、成品图回来。
 * 状态机进 `typeset` 的前置条件就是这里有行（见 workflow.ts），
 * 所以这个模块的写入路径同时也是「能不能标记为已嵌字」的事实来源。
 */

export type OutputRow = typeof outputs.$inferSelect;

export type CreateOutputParams = {
  fileId: string;
  projectId: string;
  actorId: string | null;
  /** 语言码。空串表示不限语言（项目只有一个目标语言时用） */
  language: string;
  /** 回传时的原始文件名，仅用于展示与对账 */
  name: string;
  buffer: Buffer;
  note: string;
};

export type CreateOutputResult = {
  id: string;
  version: number;
  width: number;
  height: number;
  size: number;
  language: string;
};

/**
 * 回传一份成品。
 *
 * 版本号在事务里分配，且**先锁住文件行**：两个浏览器同时传同一页时，
 * `MAX(version)+1` 如果不串行化，两边会算出同一个号，然后一个成功一个
 * 撞唯一键失败（(file_id, language, version) 是唯一索引）。锁住文件行
 * 让它们排队，代价是同一张图的回传串行 —— 本来就是同一张图，串行无所谓。
 */
export async function createOutput(params: CreateOutputParams): Promise<CreateOutputResult> {
  const { fileId, projectId, actorId, language, name, buffer, note } = params;

  // 成品是整页导出图，用比原图宽松的上限（见 env.MAX_OUTPUT_MB 的说明）
  const info = await processImage(buffer, { maxMb: env.MAX_OUTPUT_MB });

  let ext: string;
  try {
    ext = safeImageExt(name);
  } catch {
    // 回传的文件名可能是 `001_final` 这种没有扩展名的。这里不报错，
    // 从探测到的格式反推一个 —— 用户已经把图传上来了，为文件名较真没有意义。
    ext = `.${info.format === 'jpeg' ? 'jpg' : info.format}`;
  }

  const key = newOutputKey(crypto.randomUUID(), ext);

  // 先落盘再写库，与 ingestImage 同序：反过来会让库里存在指向不存在对象的行，
  // 界面上就是永久裂图。三个对象（原图 + 两个变体）一起写，一起回滚。
  await storage.put(key, buffer);
  await storage.put(variantKey(key, 'thumb'), info.thumb);
  await storage.put(variantKey(key, 'preview'), info.preview);

  try {
    const row = await db.transaction(async (tx) => {
      // 串行化同一文件的版本号分配
      await tx.select({ id: files.id }).from(files).where(eq(files.id, fileId)).for('update');

      const [maxRow] = await tx
        .select({ maxVersion: sql<number>`COALESCE(MAX(${outputs.version}), 0)::int` })
        .from(outputs)
        .where(and(eq(outputs.fileId, fileId), eq(outputs.language, language)));

      const version = Number(maxRow?.maxVersion ?? 0) + 1;

      const inserted = await tx
        .insert(outputs)
        .values({
          fileId,
          language,
          version,
          storageKey: key,
          name: name.slice(0, 180),
          size: info.size,
          width: info.width,
          height: info.height,
          note: note.slice(0, 500),
          createdBy: actorId,
        })
        .returning({
          id: outputs.id,
          version: outputs.version,
          width: outputs.width,
          height: outputs.height,
          size: outputs.size,
          language: outputs.language,
        });

      const created = inserted[0];
      if (!created) throw new Error('写入成品记录失败');

      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));

      return created;
    });

    return row;
  } catch (err) {
    // 写库失败就把刚落的三个对象清掉，别留孤儿占着空间
    await storage.removeMany([key, variantKey(key, 'thumb'), variantKey(key, 'preview')]);
    throw err;
  }
}

export type OutputView = {
  id: string;
  language: string;
  version: number;
  name: string;
  size: number;
  width: number;
  height: number;
  note: string;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
};

/** 列出某个文件的所有成品版本，最新在前。 */
export async function listOutputs(fileId: string): Promise<OutputView[]> {
  const rows = await db
    .select({
      id: outputs.id,
      language: outputs.language,
      version: outputs.version,
      name: outputs.name,
      size: outputs.size,
      width: outputs.width,
      height: outputs.height,
      note: outputs.note,
      createdBy: outputs.createdBy,
      createdByName: outputsTableUserName(),
      createdAt: outputs.createdAt,
    })
    .from(outputs)
    .where(eq(outputs.fileId, fileId))
    .orderBy(desc(outputs.version), asc(outputs.createdAt));

  return rows.map((r) => ({
    ...r,
    createdByName: r.createdByName ?? '',
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * 关联出「回传人」的名字。
 *
 * 单独抽出来只是为了让上面的 select 读起来是一条直线 —— 它内部用的是
 * 相关子查询而不是 join：成品行数很少，子查询更省事，也不会因为
 * 用户被删掉而把成品行整个过滤掉（inner join 会）。
 */
function outputsTableUserName() {
  return sql<string | null>`(
    SELECT COALESCE(NULLIF(u.display_name, ''), u.username)
      FROM users u WHERE u.id = ${outputs.createdBy}
  )`;
}

/** 某文件已回传的成品数量。状态机进 typeset 要看它。 */
export async function countOutputs(fileId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(outputs)
    .where(eq(outputs.fileId, fileId));
  return Number(row?.total ?? 0);
}

/** 删除一份成品。字节也要删 —— 只删行会让成品变成没人认领的孤儿对象。 */
export async function deleteOutput(outputId: string, fileId: string): Promise<void> {
  const rows = await db
    .select({ id: outputs.id, storageKey: outputs.storageKey })
    .from(outputs)
    .where(and(eq(outputs.id, outputId), eq(outputs.fileId, fileId)))
    .limit(1);

  const row = rows[0];
  if (!row) return;

  // 先删库再删字节：反过来的话，删字节成功而删库失败会留下一个
  // 「点开就裂」的成品记录；而删库成功、删字节失败只是留下一个孤立对象，
  // 不影响任何人的使用，清理脚本能捞回来。两害相权取其轻。
  await db.delete(outputs).where(eq(outputs.id, outputId));
  await storage.removeMany([row.storageKey, variantKey(row.storageKey, 'thumb'), variantKey(row.storageKey, 'preview')]);
}

/** 取某文件在某语言下的成品（供媒体路由与成品包使用）。 */
export async function latestOutput(fileId: string, language: string): Promise<OutputRow | null> {
  const rows = await db
    .select()
    .from(outputs)
    .where(and(eq(outputs.fileId, fileId), eq(outputs.language, language)))
    .orderBy(desc(outputs.version))
    .limit(1);
  return rows[0] ?? null;
}

/** 统计一个作品里有多少文件已有成品，供界面上显示「嵌字进度」。 */
export async function countFilesWithOutputs(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(DISTINCT ${outputs.fileId})::int` })
    .from(outputs)
    .innerJoin(files, eq(files.id, outputs.fileId))
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt)));
  return Number(row?.total ?? 0);
}
