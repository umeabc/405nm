import { SourcingError } from '../errors.js';
import type { SourceParser } from '../types.js';

/**
 * 图片直链。
 *
 * 最朴素的一类：链接本身就是一张图。**它必须排在注册表的最后** ——
 * match 的判据「路径以图片扩展名结尾」太宽了，排前面会把别的图源认走
 * （比如 `i.pximg.net/.../*.png` 这种链接，虽然它不是 pixiv 的页面链接，
 * 但用户可能同时贴了两种）。
 */

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

/**
 * 有些图床**必须带 Referer 才给图**，最典型的就是 `i.pximg.net`：
 * 不带 `https://www.pixiv.net/` 直接 403（实测过）。
 *
 * 用户直接粘一条 i.pximg.net 的直链是很自然的操作，所以这里按域名补上，
 * 而不是让他去猜「为什么这条链接 403、那条没事」。
 */
const REFERER_BY_HOST: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)pximg\.net$/i, 'https://www.pixiv.net/'],
  [/(^|\.)pixiv\.net$/i, 'https://www.pixiv.net/'],
  [/(^|\.)twimg\.com$/i, 'https://x.com/'],
  [/(^|\.)bsky\.app$/i, 'https://bsky.app/'],
];

export function refererFor(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    for (const [pattern, referer] of REFERER_BY_HOST) {
      if (pattern.test(host)) return referer;
    }
  } catch {
    /* 解析不了就不带 Referer */
  }
  return undefined;
}

export const externalSource: SourceParser = {
  id: 'external',
  match: (url) => (url.protocol === 'http:' || url.protocol === 'https:') && IMAGE_EXT_RE.test(url.pathname),
  async parse(url, ctx) {
    if (!IMAGE_EXT_RE.test(url.pathname)) {
      throw new SourcingError('UNSUPPORTED', '这个链接看起来不是图片直链', { url: url.href });
    }
    if (ctx.maxImages < 1) {
      throw new SourcingError('UNSUPPORTED', '单次导入上限为 0', { url: url.href });
    }

    const filename = url.pathname.split('/').pop() ?? 'image';
    const referer = refererFor(url.href);

    return {
      images: [{ url: url.href, filename, ...(referer ? { referer } : {}) }],
      title: filename.replace(IMAGE_EXT_RE, ''),
    };
  },
};
