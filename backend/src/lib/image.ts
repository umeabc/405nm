import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../env.js';
import { AppError, badRequest } from './errors.js';

/**
 * 图片处理：探测尺寸、算摘要、生成缩略图与预览图。
 *
 * ── 为什么不用 sharp ────────────────────────────────────────
 *
 * 最初这里用的是 sharp。它在测试机上**起不来**：
 *   Could not load the "sharp" module using the linux-x64 runtime
 *   Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture
 * 原因是被虚拟化的机器只暴露了最基础的 x86-64 —— `/proc/cpuinfo` 的 model name 是
 * 「Common KVM processor」，没有 SSSE3 / SSE4.2 / POPCNT，也就是缺 x86-64-v2。
 * sharp 的 WebAssembly 兜底**也走不通**：它要求 Wasm SIMD，而 V8 在缺少对应
 * 指令集的 CPU 上会直接禁用 SIMD（`Wasm SIMD unsupported`）。
 *
 * 于是改成调用 **Debian 自带的 libvips 命令行**（`libvips-tools` 8.14.1）：
 * 发行版打包的二进制按「基线 x86-64」编译，在任何机器上都能跑 —— 这一点比 sharp
 * 的预编译产物**更可移植**，而且底下是同一个引擎（libvips），缩放与编码的结果
 * 与 sharp 语义一致（`--size` 是等比内接、且不放大，与 `fit: inside` +
 * `withoutEnlargement` 相同）。
 *
 * 代价是每张图多一次进程启动（约 50ms）。相对于图片解码本身，这个开销可以忽略；
 * 换来的是「不会因为宿主机 CPU 型号而在启动时崩溃」—— 这类问题在部署现场极难定位。
 *
 * ── 为什么三件事绑在一起做 ──────────────────────────────────
 * 都要把整张图读一遍，分开调用就是同一份大图被读三次。一张 8000×12000 的扫图
 * 解码后约 380MB，分开做在小内存机器上必炸。
 */

/** 只放行这些 libvips loader。**白名单**，不是黑名单 —— 黑名单永远漏。 */
const ALLOWED_LOADERS = new Set(['pngload', 'jpegload', 'webpload', 'gifload', 'tiffload', 'heifload', 'avifload']);

/** loader 名 → 供日志与错误提示用的格式名。 */
const FORMAT_BY_LOADER: Readonly<Record<string, string>> = {
  pngload: 'png',
  jpegload: 'jpeg',
  webpload: 'webp',
  gifload: 'gif',
  tiffload: 'tiff',
  heifload: 'heif',
  avifload: 'avif',
};

/** EXIF 方向里的 5–8 表示「旋转了 90°，宽高互换」。 */
const SWAPPED_ORIENTATIONS = new Set([5, 6, 7, 8]);

export type ImageInfo = {
  width: number;
  height: number;
  format: string;
  md5: string;
  sha256: string;
  size: number;
  thumb: Buffer;
  preview: Buffer;
};

/**
 * 并发闸门。libvips 解码一张大图的峰值内存是「宽 × 高 × 通道数」，
 * 不设上限时十来张并发上传就能把 256MB 的容器打爆（表现为容器被杀，
 * 日志里只留一句 OOM，什么都查不到）。与图译空间取齐，用 2。
 */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

const gate = new Semaphore(env.IMAGE_CONCURRENCY);
const execFileAsync = promisify(execFile);

export function digest(buffer: Buffer): { md5: string; sha256: string; size: number } {
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.byteLength,
  };
}

type Probed = { width: number; height: number; loader: string; orientation: number };

/**
 * 读元数据。刻意用一次 `vipsheader -a` 拿全部字段，而不是三次 `-f`：
 * 每次调用都是一个进程，三次就是三倍开销，而这个函数在每张图上传时都要跑。
 */
async function probe(file: string): Promise<Probed> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('vipsheader', ['-a', file], { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      // 这是部署问题（镜像里没装 libvips-tools），不是用户的问题 —— 大声报出来。
      throw new Error('服务器缺少 libvips 命令行工具（apt-get install libvips-tools）');
    }
    throw badRequest('无法识别的图片格式', 'UNSUPPORTED_IMAGE');
  }

  // 首行形如：`/tmp/x.png: 1200x1600 uchar, 3 bands, srgb, pngload`
  const summary = stdout.match(/:\s*(\d+)x(\d+)\s+[^\n]*/);
  if (!summary) throw badRequest('无法读取图片尺寸', 'UNSUPPORTED_IMAGE');

  const width = Number(summary[1]);
  const height = Number(summary[2]);
  if (!width || !height) throw badRequest('无法读取图片尺寸', 'UNSUPPORTED_IMAGE');

  // loader 有两种来源：独立字段最可靠，拿不到就退回首行的最后一个词。
  const loaderField = stdout.match(/^vips-loader:\s*(\S+)/m);
  const loader = loaderField
    ? loaderField[1]!
    : (stdout.split('\n')[0]?.split(',').pop()?.trim() ?? '');

  const orientationField = stdout.match(/^orientation:\s*(\d+)/m);

  return {
    width,
    height,
    loader: loader.toLowerCase(),
    orientation: orientationField ? Number(orientationField[1]) : 1,
  };
}

/** 生成一张变体图（WebP）。`--rotate` 按 EXIF 摆正，`--size` 等比内接且不放大。 */
async function renderVariant(input: string, output: string, maxEdge: number, quality: number): Promise<Buffer> {
  await execFileAsync(
    'vipsthumbnail',
    ['--rotate', '--size', `${maxEdge}x${maxEdge}`, '--output', `${output}[Q=${quality},strip]`, input],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return fs.readFile(output);
}

/**
 * 只验证「这确实是一张能解析的图片」，不生成变体、不落库。
 *
 * 给立绘这类「存原图就够」的场景用。它**仍然走同一个并发闸门** ——
 * 闸门护的是 libvips 的解码峰值内存，绕开它会让「上传大图的同时传立绘」
 * 变成双倍峰值，而那正是要防的事。
 */
export async function probeImage(
  buffer: Buffer,
): Promise<{ width: number; height: number; format: string }> {
  if (buffer.byteLength === 0) throw badRequest('文件内容为空', 'EMPTY_FILE');

  return gate.run(async () => {
    const workDir = path.join(os.tmpdir(), `nm405-probe-${randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });
    const source = path.join(workDir, 'source');

    try {
      await fs.writeFile(source, buffer);
      const meta = await probe(source);
      if (!ALLOWED_LOADERS.has(meta.loader)) {
        throw badRequest(`不支持的文件类型：${meta.loader || '未知'}`, 'UNSUPPORTED_IMAGE');
      }
      return {
        width: meta.width,
        height: meta.height,
        format: FORMAT_BY_LOADER[meta.loader] ?? meta.loader,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw badRequest('图片解析失败，文件可能已损坏', 'UNSUPPORTED_IMAGE');
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * 处理一张图：校验 → 探测 → 摘要 → 生成两个变体。
 *
 * 尺寸取**应用 EXIF 方向之后**的值。手机直出的照片与部分扫图带方向标记，
 * 直接读元数据会拿到宽高颠倒的结果，界面上表现为「图是横的但占位框是竖的」。
 */
export async function processImage(buffer: Buffer): Promise<ImageInfo> {
  if (buffer.byteLength === 0) throw badRequest('文件内容为空', 'EMPTY_FILE');

  const limitBytes = env.MAX_IMAGE_MB * 1024 * 1024;
  if (buffer.byteLength > limitBytes) {
    throw badRequest(`图片超过 ${env.MAX_IMAGE_MB}MB 上限`, 'FILE_TOO_LARGE');
  }

  return gate.run(async () => {
    const workDir = path.join(os.tmpdir(), `nm405-img-${randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });
    const source = path.join(workDir, 'source');
    const thumbPath = path.join(workDir, 'thumb.webp');
    const previewPath = path.join(workDir, 'preview.webp');

    try {
      await fs.writeFile(source, buffer);

      const meta = await probe(source);
      if (!ALLOWED_LOADERS.has(meta.loader)) {
        throw badRequest(
          `不支持的文件类型：${meta.loader || '未知'}`,
          'UNSUPPORTED_IMAGE',
        );
      }

      const swapped = SWAPPED_ORIENTATIONS.has(meta.orientation);
      const width = swapped ? meta.height : meta.width;
      const height = swapped ? meta.width : meta.height;

      // 两张变体串行生成：并发跑两张等于同时解两次码，峰值内存翻倍，
      // 而外层闸门只保证「同时有几张图」，不保证「同一张图只解一次」。
      const thumb = await renderVariant(source, thumbPath, env.THUMB_SIZE, 80);
      const preview = await renderVariant(source, previewPath, env.PREVIEW_SIZE, 88);

      return {
        width,
        height,
        format: FORMAT_BY_LOADER[meta.loader] ?? meta.loader,
        ...digest(buffer),
        thumb,
        preview,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      // libvips 对损坏文件的报错五花八门，统一收成一个业务错误；
      // 原始信息留给日志（调用方会记），不往客户端吐。
      throw badRequest('图片解析失败，文件可能已损坏', 'UNSUPPORTED_IMAGE');
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
