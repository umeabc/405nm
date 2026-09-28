import { SourcingError } from './errors.js';
import { blueskyPostSource, blueskyUserSource } from './sources/bluesky.js';
import { externalSource } from './sources/external.js';
import { pixivArtworkSource, pixivUserSource } from './sources/pixiv.js';
import { twitterTweetSource, twitterUserSource } from './sources/twitter.js';
import { SOURCE_IDS, SOURCE_LABELS, type SourceId, type SourceParser } from './types.js';

/**
 * 图源注册表。
 *
 * 顺序即优先级，**第一个认领链接的胜出**，所以这里的次序不是随意的：
 *
 *  1. 单条 / 单作品排在前面 —— `x.com/NASA/status/123` 同时满足「是某人的主页」
 *     与「是一条推文」两种正则，只有靠顺序才能得到想要的那个。
 *  2. `external`（凡是图片扩展名结尾都算我的）**必须最后**。它最宽，
 *     排前面会把别的图源全吃掉。
 */
const PARSERS: readonly SourceParser[] = [
  twitterTweetSource,
  twitterUserSource,
  blueskyPostSource,
  blueskyUserSource,
  pixivArtworkSource,
  pixivUserSource,
  externalSource,
];

export function parserById(id: SourceId): SourceParser {
  const parser = PARSERS.find((p) => p.id === id);
  if (!parser) throw new Error(`未知图源：${id}`);
  return parser;
}

export type DetectedSource = { parser: SourceParser; url: URL };

/**
 * 认出这个链接属于哪一类图源。
 *
 * 认不出就抛 `UNSUPPORTED`，并把「支持哪些」一并说清楚 ——
 * 用户粘错链接时，最有用的信息是「你能粘什么」而不是「不支持」。
 */
export function detectSource(raw: string): DetectedSource {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SourcingError('INVALID_URL', '这不是一个完整的链接（要带 https://）', { input: raw.slice(0, 120) });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourcingError('UNSUPPORTED', `不支持的协议：${url.protocol}`, { input: raw.slice(0, 120) });
  }

  for (const parser of PARSERS) {
    if (parser.match(url)) return { parser, url };
  }

  throw new SourcingError(
    'UNSUPPORTED',
    `认不出这个链接属于哪类图源。可以粘：${SOURCE_IDS.map((id) => SOURCE_LABELS[id]).join('、')}`,
    { input: raw.slice(0, 120) },
  );
}

/** 给前端用的图源清单（下拉里显示「支持哪些」）。 */
export function sourceCatalog(): Array<{ id: SourceId; label: string }> {
  return SOURCE_IDS.map((id) => ({ id, label: SOURCE_LABELS[id] }));
}
