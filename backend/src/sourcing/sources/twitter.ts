import { SourcingError } from '../errors.js';
import { fetchJson } from '../json.js';
import type { ParseContext, SourceParseResult, SourceParser, SourcedImage } from '../types.js';

/**
 * X（Twitter）。
 *
 * 2026-09-29 实测，把「以为能用」和「实际能用」分清楚了：
 *
 *   ✅ `GET cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en&token=x` → 200
 *      单条推文靠它，**不需要任何凭据**。
 *   ❌ `syndication.twitter.com/srv/timeline-profile/screen-name/<name>`
 *      一律 429（换了参数组合、换了出口 IP 都一样）—— 这条路已经不通了。
 *   ❌ `api.x.com/1.1/guest/activate.json` → 404，旧的游客令牌入口没了。
 *   ❌ `platform.twitter.com/embed/Tweet.html` 现在返回的是 JS 空壳（429 字节），
 *      **og:image 回退路径已经不存在**。所以别指望「主路径挂了还有兜底」。
 *   ✅ `api.x.com/graphql/<queryId>/UserByScreenName` 带公开 web bearer → 200，拿得到 rest_id。
 *   ⚠️ 按用户批量还要 `UserMedia`，它的 queryId 是上游每月会换的常量，
 *      查不到（x.com 首页是 JS 空壳，bundle 里挖不出）。所以做成**账号配置项**，
 *      而不是在代码里写一个过两天就失效的常量。
 *
 * 结论：单条推文开箱即用；按用户批量需要在该图源账号里填 `bearer` 与 `userMediaQueryId`。
 */

const TWEET_RE = /\/(?:status|statuses)\/(\d+)/;
const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;

/** 这些是功能路径，不是用户名。不排除的话 x.com/home 会被当成一个叫 home 的用户。 */
const RESERVED_PATHS = new Set([
  'i', 'home', 'explore', 'search', 'settings', 'messages', 'notifications',
  'compose', 'intent', 'share', 'login', 'logout', 'signup', 'tos', 'privacy', 'about',
]);

const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';
const GRAPHQL = 'https://api.x.com/graphql';

function isTwitterHost(hostname: string): boolean {
  return /(^|\.)(x|twitter)\.com$/.test(hostname);
}

function tweetId(url: URL): string | null {
  return TWEET_RE.exec(url.pathname)?.[1] ?? null;
}

function handleOf(url: URL): string | null {
  const m = HANDLE_RE.exec(url.pathname);
  const handle = m?.[1];
  if (!handle) return null;
  return RESERVED_PATHS.has(handle.toLowerCase()) ? null : handle;
}

type SyndicationTweet = {
  id_str?: string;
  text?: string;
  user?: { screen_name?: string; name?: string };
  /** 现代形态 */
  mediaDetails?: Array<{ type?: string; media_url_https?: string; expanded_url?: string }>;
  /** 老形态，偶尔还会出现 */
  photos?: Array<{ url?: string }>;
  entities?: { media?: Array<{ type?: string; media_url_https?: string }> };
};

/**
 * 原图地址。
 *
 * `?name=orig` 是拿原图的关键；**绝不能改成 `format=jpg`** ——
 * 那是一张 `format` 原图转换接口，PNG 稿件会直接 404（这个坑 380nm 上踩过）。
 */
export function originalUrl(raw: string): string {
  const url = raw.split('?')[0] ?? raw;
  return `${url}?name=orig`;
}

function extensionOf(url: string): string {
  const path = url.split('?')[0] ?? '';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '.jpg';
}

export function imagesOfTweet(tweet: SyndicationTweet): SourcedImage[] {
  const out: SourcedImage[] = [];
  const push = (raw: string | undefined, note: string) => {
    if (!raw) return;
    out.push({ url: originalUrl(raw), filename: `${note}${extensionOf(raw)}` });
  };

  const details = tweet.mediaDetails ?? tweet.entities?.media ?? [];
  for (const [i, media] of details.entries()) {
    if (media.type && media.type !== 'photo') {
      // 视频/动图的 `media_url_https` 只是一张封面图。导入它等于导进一张
      // 意义不明的缩略图，不如不收，但要让人知道收了什么、没收什么。
      continue;
    }
    push(media.media_url_https, `p${i + 1}`);
  }

  // 老接口形态（`photos[].url`）作为兜底 —— 虽然实测主路径还有效，
  // 但改一次解析器比改一次「完全抓不到」便宜得多。
  if (out.length === 0) {
    for (const [i, photo] of (tweet.photos ?? []).entries()) push(photo.url, `p${i + 1}`);
  }

  return out;
}

export const twitterTweetSource: SourceParser = {
  id: 'twitter',
  match: (url) => isTwitterHost(url.hostname) && tweetId(url) !== null,
  async parse(url, ctx) {
    const id = tweetId(url);
    if (!id) throw new SourcingError('INVALID_URL', '从链接里读不出推文 id', { url: url.href });

    const tweet = await fetchJson<SyndicationTweet>(
      `${SYNDICATION}?id=${id}&lang=en&token=x`,
      ctx,
      { headers: { accept: 'application/json' } },
    );

    const images = imagesOfTweet(tweet);
    if (images.length === 0) {
      throw new SourcingError('NO_MEDIA', '这条推文里没有可下载的图片', { resource: id });
    }

    return {
      images: images.slice(0, ctx.maxImages),
      ...(tweet.user?.screen_name ? { author: tweet.user.name ?? tweet.user.screen_name } : {}),
      // 用推文 id 当文件名前缀，避免同一批导入里多张 p1.jpg 撞名。
      title: `twitter-${id}`,
      ...(tweet.text ? { notes: [`推文：${tweet.text.slice(0, 80)}`] } : {}),
    };
  },
};

// ── 按用户批量 ────────────────────────────────────────────────

type UserByScreenNameResponse = {
  data?: { user?: { result?: { rest_id?: string; legacy?: { name?: string } } } };
};

type TimelineResponse = {
  data?: {
    user?: {
      result?: {
        timeline_v2?: { timeline?: { instructions?: unknown[] } };
      };
    };
  };
};

type MediaItem = { media_url_https?: string; type?: string };

/** 从 GraphQL 时间线的 instructions 里把图片抠出来，顺带拿下一页游标。 */
function harvestTimeline(instructions: unknown[]): { images: SourcedImage[]; cursor?: string } {
  const images: SourcedImage[] = [];
  let cursor: string | undefined;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;

    const content = obj.content as Record<string, unknown> | undefined;
    if (content?.cursorType === 'Bottom' && typeof content.value === 'string') {
      cursor = content.value;
    }

    // 一条推文的媒体在 legacy.extended_entities.media（多图）
    // 或 legacy.entities.media（单图）里，两处都要看。
    const legacy = (obj.legacy ?? (content?.itemContent as Record<string, unknown> | undefined)?.tweet_results) as
      | Record<string, unknown>
      | undefined;
    const search = (source: Record<string, unknown> | undefined) => {
      const legacyInner = source?.legacy as Record<string, unknown> | undefined;
      const media = [
        ...((legacyInner?.extended_entities as { media?: MediaItem[] } | undefined)?.media ?? []),
        ...((legacyInner?.entities as { media?: MediaItem[] } | undefined)?.media ?? []),
      ];
      for (const item of media) {
        if (item.type && item.type !== 'photo') continue;
        if (!item.media_url_https) continue;
        images.push({
          url: originalUrl(item.media_url_https),
          filename: `p${images.length + 1}${extensionOf(item.media_url_https)}`,
        });
      }
    };
    if (legacy) search(legacy);

    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) for (const item of value) visit(item);
      else if (value && typeof value === 'object') visit(value);
    }
  };

  for (const instruction of instructions) visit(instruction);
  return { images, ...(cursor ? { cursor } : {}) };
}

export const twitterUserSource: SourceParser = {
  id: 'twitter_user',
  match: (url) => isTwitterHost(url.hostname) && tweetId(url) === null && handleOf(url) !== null,
  async parse(url, ctx) {
    const handle = handleOf(url);
    if (!handle) throw new SourcingError('INVALID_URL', '从链接里读不出用户名', { url: url.href });

    const bearer = ctx.credentials.bearer?.trim();
    const userMediaQueryId = ctx.credentials.userMediaQueryId?.trim();
    if (!bearer || !userMediaQueryId) {
      // 与其拿一个会过期的常量去撞，不如把「缺什么、去哪儿配」讲清楚。
      throw new SourcingError(
        'UNSUPPORTED',
        '按用户抓 X 需要在该图源账号里填 `bearer` 与 `userMediaQueryId`（X 的 GraphQL 查询 id 上游每月会换，代码里写死必然过期）。只想抓单条推文不需要任何配置。',
        { handle },
      );
    }

    const authHeaders = {
      authorization: `Bearer ${bearer}`,
      'x-twitter-active-user': 'yes',
      accept: 'application/json',
    };

    const lookup = encodeURIComponent(JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true }));
    const userRes = await fetchJson<UserByScreenNameResponse>(
      `${GRAPHQL}/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?variables=${lookup}`,
      ctx,
      { headers: authHeaders },
    );
    const restId = userRes.data?.user?.result?.rest_id;
    if (!restId) {
      throw new SourcingError('NOT_FOUND', `找不到用户 @${handle}`, { handle });
    }

    const notes: string[] = [];
    const images: SourcedImage[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const maxPages = 40;

    do {
      const variables = encodeURIComponent(
        JSON.stringify({
          userId: restId,
          count: 100,
          includePromotedContent: false,
          withClientEventToken: false,
          withBirdwatchNotes: false,
          withVoice: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      const timeline = await fetchJson<TimelineResponse>(
        `${GRAPHQL}/${userMediaQueryId}/UserMedia?variables=${variables}`,
        ctx,
        { headers: authHeaders },
      );

      const instructions = timeline.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];
      const harvested = harvestTimeline(instructions);
      images.push(...harvested.images);
      cursor = harvested.cursor;
      pages += 1;

      if (images.length >= ctx.maxImages) {
        notes.push(`已达到单次导入上限 ${ctx.maxImages} 张`);
        break;
      }
    } while (cursor && pages < maxPages);

    if (cursor && pages >= maxPages) {
      notes.push(`只取了前 ${maxPages} 页，@${handle} 还有更早的媒体没有取`);
    }
    if (images.length === 0) {
      throw new SourcingError('NO_MEDIA', `@${handle} 的近期媒体里没有图片`, { handle });
    }

    return {
      images: images.slice(0, ctx.maxImages),
      title: `@${handle} 的媒体`,
      notes,
    };
  },
};
