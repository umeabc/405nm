import { Readable } from 'node:stream';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { storage } from '../storage/index.js';
import { AppError } from '../lib/errors.js';

/**
 * 流式打 zip。
 *
 * 为什么是流式而不是 `zipSync`：一部 40 页的作品，每页扫描件几 MB，
 * 全量缓冲意味着几百 MB 的峰值内存，容器里迟早会被打爆。这里做成
 * **异步生成器** —— 每读完一个文件就把产出的分片 `yield` 出去，
 * 下游（HTTP 响应）来不及消费时自然就停在 `yield` 上，**背压不用手写**。
 * 峰值内存因此只有一个文件的量级。
 *
 * 另一个刻意的选择：**图片用 store 不压缩**（`ZipPassThrough`）。
 * JPEG / PNG / WebP 本来就是压缩过的，deflate 花掉 CPU 只能换来百分之几，
 * 而这几 MB 的包要下载一遍 —— 让打包快一点比让它小一点更值。
 * 文本（清单、JSON）才走 deflate。
 */

export type ZipEntry = {
  /** 包内路径。用 `/` 分隔，不要以 `/` 开头 */
  name: string;
  /** 二选一：直接给字节，或给存储键去读 */
  data?: Buffer;
  key?: string;
};

/**
 * 包内路径清洗。
 *
 * 必须处理目录穿越（`..`）与绝对路径：压缩包会被用户在自己的机器上解开，
 * 一个写成 `../../x` 的条目名在部分解压工具下会真的写到包外 ——
 * 那等于把服务端的路径控制权交给了数据。
 */
export function sanitizeEntryName(raw: string): string {
  const cleaned = raw
    // 反斜杠一律当分隔符，避免 Windows 风格路径在 Linux 上变成含 `\` 的文件名
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return cleaned || 'file';
}

/**
 * 打一个 zip。
 *
 * 读不到对象时**抛错并中断**，不做「跳过这个文件继续」：
 * 一个缺页的嵌字包比一个报错的导出危险得多 —— 后者用户会重来，
 * 前者会一路嵌到发布才被发现。
 */
export async function* zipStream(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
  const pending: Uint8Array[] = [];
  let ended = false;
  let failure: Error | null = null;

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      ended = true;
      return;
    }
    if (chunk && chunk.length > 0) pending.push(chunk);
    if (final) ended = true;
  });

  /** 把 fflate 同步产出的分片交给下游。yield 会在此处挂起 → 天然背压。 */
  function* drain(): Generator<Uint8Array> {
    while (pending.length > 0) yield pending.shift()!;
  }

  for (const entry of entries) {
    if (failure) throw failure;

    let data: Buffer;
    if (entry.data !== undefined) {
      data = entry.data;
    } else if (entry.key !== undefined) {
      const buf = await storage.getBuffer(entry.key);
      if (!buf) {
        throw new AppError('ZIP_SOURCE_MISSING', `打包失败：读不到对象 ${entry.key}`, 500);
      }
      data = buf;
    } else {
      throw new AppError('ZIP_ENTRY_EMPTY', `打包失败：条目 ${entry.name} 既没有数据也没有存储键`, 500);
    }

    const name = sanitizeEntryName(entry.name);
    // 文本才值得压。图片已经压过了，deflate 只烧 CPU 不省字节。
    const file = /\.(txt|json|csv|md)$/i.test(name)
      ? new ZipDeflate(name, { level: 6 })
      : new ZipPassThrough(name);

    zip.add(file);
    // Buffer 本身就是 Uint8Array，不用再包一层
    file.push(data, true);

    yield* drain();
  }

  zip.end();
  yield* drain();

  if (failure) throw failure;
  if (!ended) throw new AppError('ZIP_INCOMPLETE', '打包失败：压缩流没有正常结束', 500);
}

/** 把生成器接到 Node 可读流上，Fastify 可以直接 pipe。 */
export function zipToReadable(entries: readonly ZipEntry[]): Readable {
  return Readable.from(zipStream(entries));
}
