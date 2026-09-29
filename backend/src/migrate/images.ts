/**
 * 旧站图片字节的取用口。
 *
 * 两种取法：**挂载目录**（旧站的存储卷直接挂进来）与 **HTTP**（旧站自己的内容接口）。
 * 无论哪种，都只读 —— 迁移过程中旧站是只读的。
 *
 * `describe()` 刻意不吐地址：报告会被转发、会被贴进聊天窗口，
 * 而地址里往往带着内网 IP 或站点域名。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type ImageSource = {
  /** 给人看的名字（**不含地址**） */
  describe(): string;
  /** 取一张图的字节；不存在返回 null。其它错误抛出 —— 迁移要能中断后重跑 */
  fetch(saveName: string): Promise<Buffer | null>;
};

/** 旧站的文件名是「ObjectId + 扩展名」，只可能是这一小撮字符。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function assertSafeName(saveName: string): void {
  if (!SAFE_NAME.test(saveName) || saveName.includes('..')) {
    throw new Error(`旧站文件名不合法：${saveName}`);
  }
}

export function dirSource(dir: string): ImageSource {
  const root = path.resolve(dir);
  return {
    describe: () => `挂载目录（${path.basename(root)}）`,
    async fetch(saveName) {
      assertSafeName(saveName);
      const full = path.resolve(root, saveName);
      // 双保险：正则已经挡掉了 `..`，这里再确认一次解析结果没跑出根目录。
      if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`路径越界：${saveName}`);
      try {
        return await fs.readFile(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

/**
 * `base` 是能直接拼文件名的那一段（旧站是 `{REMOTE_HTTP_BASE_URL}/files/files`）。
 * 401/403 之类一律当作错误抛出而不是「缺图」：拿不到字节和「这张图本来就没有」
 * 是两件不同的事，混淆的后果是**迁移静默丢图**且报告显示一切正常。
 */
export function httpSource(base: string, attempts = 3): ImageSource {
  const root = base.replace(/\/+$/, '');
  return {
    describe: () => 'HTTP 图源（地址已隐去）',
    async fetch(saveName) {
      assertSafeName(saveName);
      let lastError: unknown = null;
      for (let i = 0; i < attempts; i += 1) {
        const abort = AbortSignal.timeout(120_000);
        try {
          const res = await fetch(`${root}/${encodeURIComponent(saveName)}`, { signal: abort });
          if (res.status === 404 || res.status === 410) return null;
          if (!res.ok) throw new Error(`图源返回 ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        } catch (err) {
          lastError = err;
          if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('取图失败');
    },
  };
}
