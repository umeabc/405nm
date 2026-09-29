import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { importTaskItems, importTasks, sourcingAccounts } from '../db/schema.js';
import { ingestImage } from '../domain/ingest-image.js';
import { importFileName } from './filenames.js';
import { env } from '../env.js';
import { decryptCredentials } from '../lib/credentials.js';
import { isSourcingError, SourcingError } from './errors.js';
import { resolveProxy, sourcingFetch } from './http.js';
import { renewImportLease } from './queue.js';
import { detectSource } from './registry.js';
import type { ParseContext, SourceParser, SourcedImage } from './types.js';

/**
 * 跑一条导入任务。
 *
 * 由 worker 调用（backend 绝不能起这个循环，否则两个容器会同时抓同一批图）。
 * 任务的**每一步都落库**：解析完写 items，每张图跑完更新那一行 ——
 * 中途崩掉重启后能接着跑，而不是从头再来。
 *
 * moeflow 的老实现是进程内 daemon 线程 + 内存计数，重启后任务永远停在
 * `finished=false`，而且没有清理。这里不重蹈覆辙。
 */

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};

function extensionFor(image: SourcedImage, contentType: string): string {
  const fromUrl = image.url.split('?')[0]?.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i)?.[0];
  if (fromUrl) return fromUrl.toLowerCase();
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXT_BY_MIME[mime] ?? '.jpg';
}

/** 找到这次导入该用的账号：团队专属优先，其次是全站共享的。 */
async function resolveAccount(source: string, teamId: string) {
  const rows = await db
    .select()
    .from(sourcingAccounts)
    .where(
      and(
        eq(sourcingAccounts.source, source),
        eq(sourcingAccounts.enabled, true),
        or(eq(sourcingAccounts.teamId, teamId), isNull(sourcingAccounts.teamId)),
      ),
    )
    // 团队专属排前面（true > false），同组内取最近更新的
    .orderBy(sql`${sourcingAccounts.teamId} is null asc`, sql`${sourcingAccounts.updatedAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export async function runImportTask(taskId: string, log: (msg: string, extra?: object) => void): Promise<void> {
  const taskRows = await db.select().from(importTasks).where(eq(importTasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (!task) {
    log('[import] 任务不存在，跳过', { taskId });
    return;
  }

  // ── 一、认链接 + 解析出图片清单 ────────────────────────────
  let parser: SourceParser;
  let images: SourcedImage[];
  let notes: string[];

  const account = task.source ? await resolveAccount(task.source, task.teamId) : null;

  // ⚠️ 这里必须走 resolveProxy，**不能写成 `account?.proxyUrl || null`**。
  //
  // `null` 在 resolveProxy 里的含义是「强制直连」，而账号没配代理时的正确含义是
  // 「用 SOURCING_PROXY 的默认出口」。两者写成同一个值，后果是**没配账号的图源
  // 全都直连** —— 在内网里表现为「每次抓取都恰好 20 秒超时」，
  // 而手工拿同一个代理测又是通的，极其难查。（这个 bug 就是端到端验收抓出来的。）
  const proxyUrl = resolveProxy(account?.proxyUrl?.trim() || undefined);

  const ctx: ParseContext = {
    proxyUrl,
    credentials: decryptCredentials(account?.credentials),
    maxWorks: env.IMPORT_MAX_WORKS,
    maxImages: env.IMPORT_MAX_IMAGES,
  };

  try {
    const detected = detectSource(task.inputUrl);
    parser = detected.parser;

    const result = await parser.parse(detected.url, ctx);
    images = result.images;
    notes = [...(result.notes ?? [])];
    if (result.title) notes.unshift(`来源标题：${result.title}`);

    await db
      .update(importTasks)
      .set({ source: parser.id, notes, updatedAt: new Date() })
      .where(eq(importTasks.id, taskId));
  } catch (err) {
    await failTask(taskId, err, log);
    return;
  }

  if (images.length === 0) {
    await failTask(taskId, new SourcingError('NO_MEDIA', '这个链接里没有图片'), log);
    return;
  }

  // ── 二、把清单落库 ────────────────────────────────────────
  //
  // 重试时（任务被重新认领）**只补跑失败的那几张**，不重下已经成功的：
  // 一次几百张的导入重头再来既慢又白烧上游的配额。
  // 只有「这次的图片清单和上次不一样」（画师又发了新作）才整体重建。
  const stored = await db
    .select({ idx: importTaskItems.idx, url: importTaskItems.url })
    .from(importTaskItems)
    .where(eq(importTaskItems.taskId, taskId))
    .orderBy(asc(importTaskItems.idx));

  const unchanged =
    stored.length === images.length && stored.every((row, i) => row.url === images[i]?.url);

  // 上一轮已经跑完的那部分。**必须单独留着**：重试时列表没变，
  // 上面那些 item 已经是 imported 了，本轮循环一个都不会处理 ——
  // 若最终那次更新只写本轮的局部计数，就会把 done/imported 全部清零，
  // 界面上表现为「重试了一下，进度反而变成 0/29」。
  let base = { imported: 0, duplicated: 0, failed: 0 };

  if (!unchanged) {
    await db.delete(importTaskItems).where(eq(importTaskItems.taskId, taskId));
    await db.insert(importTaskItems).values(
      images.map((image, idx) => ({
        taskId,
        idx,
        url: image.url,
        referer: image.referer ?? '',
      })),
    );
    await db
      .update(importTasks)
      .set({ total: images.length, done: 0, imported: 0, duplicated: 0, failed: 0, updatedAt: new Date() })
      .where(eq(importTasks.id, taskId));
  } else {
    // 清单没变：把计数器按「已落库的既有状态」重算一遍，再从 pending 接着跑。
    base = await countItems(taskId);
    await db
      .update(importTasks)
      .set({
        total: images.length,
        done: base.imported + base.duplicated + base.failed,
        imported: base.imported,
        duplicated: base.duplicated,
        failed: base.failed,
        updatedAt: new Date(),
      })
      .where(eq(importTasks.id, taskId));
  }

  log('[import] 解析完成', { taskId, source: parser.id, images: images.length, resumed: unchanged });

  // ── 三、逐张下载入库 ──────────────────────────────────────
  const pending = await db
    .select()
    .from(importTaskItems)
    .where(and(eq(importTaskItems.taskId, taskId), eq(importTaskItems.status, 'pending')))
    .orderBy(asc(importTaskItems.idx));

  let imported = 0;
  let duplicated = 0;
  let failed = 0;
  let processed = 0;

  // 序号从这个作品里已有的最大序号往后接。
  //
  // 不接的话，一次往同一个作品粘三条链接就会得到「三个 001」—— 而列表是按
  // 自然序排的，三组 001..0NN 会互相穿插，看起来就是彻底乱掉了。
  // 并发跑两条任务时可能取到同一个基准（两个 worker）——那种情况下会重名，
  // 但重名不影响任何逻辑（去重按 MD5、排序按名字），只是不好看，不值得为它上锁。
  const nameBase = await nextNameBase(task.projectId);

  for (const item of pending) {
    let status: 'imported' | 'duplicated' | 'failed' = 'failed';
    let fileId: string | null = null;
    let code = '';
    let reason = '';

    try {
      const res = await sourcingFetch(item.url, {
        proxyUrl,
        ...(item.referer ? { headers: { referer: item.referer } } : {}),
      });

      const contentType = res.contentType.toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        throw new SourcingError('CONTENT_TYPE', `返回的不是图片（${contentType.split(';')[0]}）`, {
          url: item.url,
        });
      }

      const name = importFileName(nameBase + item.idx, extensionFor(images[item.idx]!, contentType));
      const outcome = await ingestImage({
        teamId: task.teamId,
        projectId: task.projectId,
        // 署名记**发起导入的人**，不是 worker —— 否则操作日志里所有导入都成了系统的动作。
        actorId: task.createdBy,
        name,
        buffer: res.body,
        note: '从链接导入',
      });

      if (outcome.status === 'duplicate') {
        status = 'duplicated';
        duplicated += 1;
        code = 'DUPLICATE';
        reason = `这张图已经在本作品里了（${outcome.existingName}）`;
      } else {
        status = 'imported';
        imported += 1;
        fileId = outcome.id;
      }
    } catch (err) {
      failed += 1;
      // 单张失败不中断整条导入 —— 一次几百张里总有几张是坏的。
      // 但**必须如实记下来**（moeflow 的老实现在枚举阶段吞掉单图失败，
      // 于是用户看到「导入完成」却少了几张，且没有任何线索）。
      if (isSourcingError(err)) {
        code = err.code;
        reason = err.userMessage;
      } else {
        code = 'SAVE_FAILED';
        reason = err instanceof Error ? err.message.slice(0, 160) : '保存失败';
      }
    }

    await db
      .update(importTaskItems)
      .set({ status, fileId, code, reason, updatedAt: new Date() })
      .where(eq(importTaskItems.id, item.id));

    processed += 1;
    // 每张都更新计数：前端 1.5s 轮询一次，看到的是「刚刚那张」而不是一批。
    await db
      .update(importTasks)
      .set({
        done: base.imported + base.duplicated + base.failed + processed,
        imported: base.imported + imported,
        duplicated: base.duplicated + duplicated,
        failed: base.failed + failed,
        updatedAt: new Date(),
      })
      .where(eq(importTasks.id, taskId));

    // 长任务续租，免得被另一个 worker 抢走重跑
    if (processed % 20 === 0) await renewImportLease(taskId);
  }

  await db
    .update(importTasks)
    .set({
      status: 'done',
      done: base.imported + base.duplicated + base.failed + processed,
      imported: base.imported + imported,
      duplicated: base.duplicated + duplicated,
      failed: base.failed + failed,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(importTasks.id, taskId));

  log('[import] 完成', { taskId, total: images.length, imported, duplicated, failed });
}

/**
 * 取「这个作品里已有的最大数字序号」。
 *
 * 名字形如 `001.png`。取不到数字前缀（比如手工上传的 `cover.jpg`）时按 0 算，
 * 不会因为它们而把序号推到一个奇怪的数上。
 */
async function nextNameBase(projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT COALESCE(MAX(SUBSTRING(name FROM '^([0-9]+)')::int), 0) AS max_seq
      FROM files
     WHERE project_id = ${projectId} AND deleted_at IS NULL
  `);
  return Number((rows as unknown as Array<{ max_seq: number | string }>)[0]?.max_seq ?? 0);
}

/** 按状态数一遍明细。重试时用它把计数器对齐到「库里实际的样子」。 */
async function countItems(taskId: string): Promise<{ imported: number; duplicated: number; failed: number }> {
  const rows = await db
    .select({ status: importTaskItems.status, count: sql<number>`count(*)::int` })
    .from(importTaskItems)
    .where(eq(importTaskItems.taskId, taskId))
    .groupBy(importTaskItems.status);

  const pick = (status: string) => Number(rows.find((r) => r.status === status)?.count ?? 0);
  return { imported: pick('imported'), duplicated: pick('duplicated'), failed: pick('failed') };
}

/** 链接级别的失败：整条任务没有可导入的内容。逐张的失败不走这里。 */
async function failTask(taskId: string, err: unknown, log: (msg: string, extra?: object) => void): Promise<void> {
  const code = isSourcingError(err) ? err.code : 'PARSE';
  const message = isSourcingError(err) ? err.userMessage : err instanceof Error ? err.message : '导入失败';

  await db
    .update(importTasks)
    .set({
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(importTasks.id, taskId));

  log('[import] 链接级失败', { taskId, code, message });
}
