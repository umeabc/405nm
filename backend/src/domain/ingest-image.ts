import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { naturalSortKey } from '@405nm/shared';
import { db } from '../db/client.js';
import { fileStates, files, projects } from '../db/schema.js';
import { processImage } from '../lib/image.js';
import { newFileKey, safeImageExt, storage, variantKey } from '../storage/index.js';

/**
 * 把一段图片字节变成一条文件记录。
 *
 * **上传与图源导入共用这一份**。它们要做的事完全一样：探测尺寸、算摘要、
 * 生成两个变体、三个对象落盘、写 files + file_states、更新作品时间戳、
 * 失败时回滚已落盘的对象。各写一份的话，两边迟早会在某个细节上分叉 ——
 * 最典型的是「导入进来的图没有缩略图」，而上传的图有，这种差异没人会去查两次代码。
 */

export type IngestOutcome =
  | {
      status: 'imported';
      id: string;
      name: string;
      width: number;
      height: number;
      size: number;
    }
  | {
      status: 'duplicate';
      existingId: string;
      existingName: string;
      /** 已存在的那张在哪个作品里。等于目标作品 = 真的重复；别的作品 = 只是同团队。 */
      existingProjectId: string | null;
    };

export type IngestParams = {
  teamId: string;
  projectId: string;
  /** 入库人。导入时是发起人，不是 worker —— 否则署名与操作日志会记到系统头上。 */
  actorId: string | null;
  name: string;
  buffer: Buffer;
  /** 写进 file_states 的说明，例如「上传入库」「从链接导入」 */
  note: string;
};

export async function ingestImage(params: IngestParams): Promise<IngestOutcome> {
  const { teamId, projectId, actorId, name, buffer, note } = params;

  const info = await processImage(buffer);

  // 先按摘要查：同一份字节在同一团队里存在过的话，连图都不用再解一次。
  //
  // ⚠️ 判定的口径是「**在目标作品里**已存在才算重复」，而不是「整个团队里有就算」。
  // 理由见实施方案：同一张彩页被两个作品引用是合法的，生产库里确实存在。
  // 整个团队范围内拦下来，会让人「给作品 B 粘链接却一张都没导进来」而不知道为什么。
  // 取一批而不是取一条：同一份字节可能同时存在于本作品与团队里别的作品
  // （那是合法的），只取一条会随机命中哪一个 —— 于是「同一份字节，
  // 有时判成重复、有时又导进来一份」这种间歇性行为就会出现。
  const existing = await db
    .select({ id: files.id, name: files.name, projectId: files.projectId })
    .from(files)
    .where(and(eq(files.teamId, teamId), eq(files.md5, info.md5), isNull(files.deletedAt)))
    .limit(20);

  const dup = existing.find((row) => row.projectId === projectId);
  if (dup) {
    return { status: 'duplicate', existingId: dup.id, existingName: dup.name, existingProjectId: dup.projectId };
  }

  const ext = safeImageExt(name);
  const key = newFileKey(crypto.randomUUID(), ext);

  // 先落盘再写库。反过来会让数据库里存在「指向不存在文件」的行，
  // 在界面上表现为永久性的裂图，而且没法自愈。
  await storage.put(key, buffer);
  await storage.put(variantKey(key, 'thumb'), info.thumb);
  await storage.put(variantKey(key, 'preview'), info.preview);

  try {
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(files)
        .values({
          teamId,
          projectId,
          name,
          sortName: naturalSortKey(name),
          storageKey: key,
          size: info.size,
          width: info.width,
          height: info.height,
          md5: info.md5,
          sha256: info.sha256,
          state: 'sourced',
          uploadedBy: actorId,
        })
        .returning({ id: files.id });

      const row = rows[0];
      if (!row) throw new Error('写入文件记录失败');

      await tx.insert(fileStates).values({
        fileId: row.id,
        fromState: null,
        toState: 'sourced',
        actorId,
        note,
      });

      // 作品的「最近更新」要跟着动，否则工作台按更新时间排序会失真。
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));

      return row;
    });

    return {
      status: 'imported',
      id: inserted.id,
      name,
      width: info.width,
      height: info.height,
      size: info.size,
    };
  } catch (err) {
    // 写库失败就把刚落的三个对象清掉，别留孤儿文件占着空间。
    await storage.removeMany([key, variantKey(key, 'thumb'), variantKey(key, 'preview')]);
    throw err;
  }
}
