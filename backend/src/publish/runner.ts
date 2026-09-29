import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { publishAccounts, publishJobs, type PublishJob } from '../db/schema.js';
import { decryptCredentials } from '../lib/credentials.js';
import { requirePlatform } from '../platforms/registry.js';
import { PlatformError, type PlatformImage, type PublishContext } from '../platforms/adapter.js';
import { storage } from '../storage/index.js';
import { beginAttempt, finishAttempt, renewPublishLease } from './queue.js';
import { renderFinalText } from './compose.js';

/**
 * 跑一条发布任务。
 *
 * ── 这份代码里最重要的东西是「失败怎么分类」 ──────────────
 *
 * 发布链路上有两段会产生**站外可见的副作用**的地方，它们的重试语义**完全不同**：
 *
 *  - **图片上传**：失败可以随便重试。最坏的结果是 B 站图床上多几张没人引用的图，
 *    没有任何粉丝看得见。而且 `upload_id` 是由任务幂等键派生的定值，
 *    重试用的是同一个 id。
 *  - **`createDynamic`**：**没有幂等参数**。一旦请求发出去了，我们就不再能
 *    确定它有没有成功 —— 网络超时、连接被掐、进程被杀，全都会留下
 *    「可能已经发出去了」的状态。这种情况下**重试就是可能发出第二条动态**。
 *
 * 所以这里只做一件事：**`createDynamic` 之前先落一条 `in_flight` 记录**，
 * 失败时按 `ambiguous` 分流 —— 歧义的一律交人工，绝不自动重发。
 */

export type PublishLog = (message: string, extra?: Record<string, unknown>) => void;

export type RunOutcome =
  | { status: 'published'; url: string; externalId: string }
  | { status: 'retry'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'needs_review'; reason: string };

/**
 * 由任务派生的确定性上传标识。
 *
 * 用任务 id 而不是幂等键：同一条任务无论重试多少次都是同一个值，
 * 而两条不同的任务（哪怕内容一样）不会撞在一起。
 */
export function uploadIdFor(job: Pick<PublishJob, 'id'>): string {
  const digest = crypto.createHash('sha256').update(`nm405:${job.id}`).digest('hex');
  return `up-${digest.slice(0, 32)}`;
}

function asImages(value: unknown): Array<{ key: string; name: string; width: number; height: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .map((v) => ({
      key: String(v.key ?? ''),
      name: String(v.name ?? 'image.jpg'),
      width: Number(v.width ?? 0),
      height: Number(v.height ?? 0),
    }))
    .filter((v) => v.key !== '');
}

function asMentions(value: unknown): Array<{ name: string; uid: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
    .map((v) => ({ name: String(v.name ?? ''), uid: String(v.uid ?? '') }))
    .filter((v) => v.name !== '' && v.uid !== '');
}

export async function runPublishJob(job: PublishJob, log: PublishLog): Promise<RunOutcome> {
  const attemptNo = job.attempts;

  const accountRows = job.accountId
    ? await db.select().from(publishAccounts).where(eq(publishAccounts.id, job.accountId)).limit(1)
    : [];
  const account = accountRows[0];
  if (!account) {
    return finish(job, 'failed', '绑定的发布账号不存在或已被删除，请重新选择账号');
  }
  if (!account.enabled) {
    return finish(job, 'failed', '绑定的发布账号已被停用');
  }

  let adapter;
  try {
    adapter = requirePlatform(account.platform);
  } catch (err) {
    return finish(job, 'failed', err instanceof Error ? err.message : '平台适配器不可用');
  }

  const credentials = decryptCredentials(account.credentials);
  if (!credentials.sessdata) {
    return finish(job, 'failed', '发布账号的凭据为空或解不开，请重新录入 Cookie');
  }

  const ctx: PublishContext = { credentials, uploadId: uploadIdFor(job) };

  // ── 阶段一：上传图片（可安全重试）──────────────────────────
  const images = asImages(job.images);
  const uploadAttempt = await beginAttempt(job.id, 'upload_images', attemptNo, `共 ${images.length} 张`);

  let pictures: PlatformImage[];
  try {
    pictures = [];
    for (const image of images) {
      const buffer = await storage.getBuffer(image.key);
      if (!buffer) {
        // 图丢了属于我们这边的问题，重试也没用 —— 直接判死
        await finishAttempt(uploadAttempt, 'failed', `读不到图片 ${image.key}`);
        return finish(job, 'failed', `准备发布的图片已不存在（${image.name}），请重新生成草稿`);
      }
      pictures.push(
        await adapter.uploadImage(ctx, {
          buffer,
          filename: image.name || 'image.jpg',
          contentType: guessContentType(image.name),
        }),
      );
      await renewPublishLease(job.id);
    }
    await finishAttempt(uploadAttempt, 'succeeded', `上传了 ${pictures.length} 张`);
  } catch (err) {
    const info = classify(err);
    await finishAttempt(uploadAttempt, 'failed', info.message);
    // 图片阶段即使歧义也**可以重试** —— 它不产生对外可见的副作用
    return finish(job, 'retry', `图片上传失败：${info.message}`, { forceRetry: true });
  }

  // ── 阶段二：发布（这一步不可撤销）──────────────────────────
  //
  // 正文的最终形态在这里才拼出来：署名片段 + 提及兜底。
  // 放在发布时而不是保存时，是为了覆盖「历史数据」「重新入队」这些
  // 没走过保存流程的任务 —— 否则它们的 @ 会退化成不可点击的纯文本。
  const finalText = await renderFinalText(job);

  // ⚠️ **先落 in_flight 再发**。这一步的顺序不能调换：
  // 反过来就会出现「发出去了但没留下任何痕迹」，那正是重复动态的来源。
  const publishAttempt = await beginAttempt(job.id, 'publish', attemptNo, finalText.slice(0, 200));

  try {
    const result = await adapter.publish(ctx, {
      text: finalText,
      title: job.title,
      images: pictures,
      topic: (job.topic ?? null) as { id: string | number; name: string } | null,
      mentions: asMentions(job.mentions),
    });
    await finishAttempt(publishAttempt, 'succeeded', result.url);
    await db
      .update(publishJobs)
      .set({
        status: 'published',
        publishedAt: new Date(),
        externalId: result.externalId,
        externalUrl: result.url,
        lastError: '',
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(publishJobs.id, job.id));
    log('[publish] 发布成功', { jobId: job.id, url: result.url });
    return { status: 'published', url: result.url, externalId: result.externalId };
  } catch (err) {
    const info = classify(err);
    await finishAttempt(publishAttempt, 'failed', info.message);
    log('[publish] 发布失败', { jobId: job.id, code: info.code, ambiguous: info.ambiguous });

    if (info.ambiguous) {
      // 不确定。**不重试**，交人工。
      return finish(job, 'needs_review', `发布请求的结果无法确认（${info.message}）—— 请到 B 站确认后再决定是否重发`);
    }
    return finish(job, 'retry', info.message);
  }
}

function classify(err: unknown): { code: string; message: string; ambiguous: boolean; retryable: boolean } {
  if (err instanceof PlatformError) {
    return { code: err.code, message: err.message, ambiguous: err.ambiguous, retryable: err.retryable };
  }
  // 不是 PlatformError 的异常来自我们自己的代码（读字节、渲染…），
  // 那些都在「请求还没发出去」之前，按可重试处理。
  return {
    code: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    ambiguous: false,
    retryable: true,
  };
}

/**
 * 落终态。
 *
 * `retry` 还要看次数：`attempts` 在认领时就 +1 了，所以这里比较的是
 * 「已经试过几次」与 `maxAttempts`。
 */
async function finish(
  job: PublishJob,
  outcome: 'retry' | 'failed' | 'needs_review',
  reason: string,
  options: { forceRetry?: boolean } = {},
): Promise<RunOutcome> {
  if (outcome === 'retry') {
    const exhausted = !options.forceRetry && job.attempts >= job.maxAttempts;
    if (!exhausted) {
      await db
        .update(publishJobs)
        .set({
          status: 'pending',
          // 退避：第 n 次失败等 n 分钟，避免上游持续拒绝时反复撞
          scheduledAt: new Date(Date.now() + job.attempts * 60_000),
          lastError: reason,
          claimedAt: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(publishJobs.id, job.id));
      return { status: 'retry', reason };
    }
    return finish(job, 'failed', `${reason}（已重试 ${job.attempts} 次，不再重试）`);
  }

  await db
    .update(publishJobs)
    .set({
      status: outcome,
      lastError: reason,
      claimedAt: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(publishJobs.id, job.id));

  return outcome === 'needs_review' ? { status: 'needs_review', reason } : { status: 'failed', reason };
}

function guessContentType(name: string): string {
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}
