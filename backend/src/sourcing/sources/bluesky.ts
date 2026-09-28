import { SourcingError } from '../errors.js';
import { fetchJson } from '../json.js';
import type { ParseContext, SourceParser, SourcedImage } from '../types.js';

/**
 * Bluesky。
 *
 * 2026-09-29 实测：**匿名可用的只有读接口，搜索接口不行**：
 *   ✅ `com.atproto.identity.resolveHandle?handle=`     → `{did}`
 *   ✅ `app.bsky.feed.getPostThread?uri=&depth=0`       → 单条帖子
 *   ✅ `app.bsky.feed.getPosts?uris=`                   → 批量取帖子
 *   ✅ `app.bsky.feed.getAuthorFeed?actor=&filter=posts_with_media&limit=100` → 按用户，带 cursor
 *   ❌ `app.bsky.feed.searchPosts`                      → 403（匿名不给用）
 *
 * 所以「粘贴一条帖子链接」与「粘贴一个主页链接」都能用，不需要凭据。
 * 公开 API 走 `public.api.bsky.app`；要读私密内容才需要 handle + app password 建会话 —— v1 不做。
 */

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';

const POST_RE = /^\/profile\/([^/]+)\/post\/([^/]+)/;
const PROFILE_RE = /^\/profile\/([^/]+)\/?$/;

function isBskyHost(hostname: string): boolean {
  return /(^|\.)bsky\.app$/.test(hostname);
}

type Embed = {
  $type?: string;
  images?: Array<{
    thumb?: string;
    fullsize?: string;
    alt?: string;
    aspectRatio?: { width?: number; height?: number };
    /** 原始 blob 引用，仅在拿不到 fullsize 时用 */
    image?: { ref?: { $link?: string } };
  }>;
  media?: Embed;
  external?: { uri?: string };
};

/** 从帖子的 embed 里抠图片。四段式：直接 images → recordWithMedia → 视频封面 → 外链（不收）。 */
export function imagesOfEmbed(embed: Embed | undefined, did: string, notes: string[]): SourcedImage[] {
  if (!embed) return [];
  const type = embed.$type ?? '';

  if (type === 'app.bsky.embed.images#view') {
    const out: SourcedImage[] = [];
    for (const [i, image] of (embed.images ?? []).entries()) {
      // 正常走 cdn.bsky.app 的 fullsize；拿不到就退回 getBlob ——
      // 敏感内容被限制时 fullsize 会缺，但 blob 还在。
      const cid = image.image?.ref?.$link;
      const url = image.fullsize ?? (cid ? `${PUBLIC_API}/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}` : undefined);
      if (!url) continue;
      out.push({
        url,
        filename: `p${i + 1}.jpg`,
        ...(image.aspectRatio?.width ? { width: image.aspectRatio.width } : {}),
        ...(image.aspectRatio?.height ? { height: image.aspectRatio.height } : {}),
      });
    }
    return out;
  }

  // 引用别人的帖子时，媒体在这一层里
  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return imagesOfEmbed(embed.media, did, notes);
  }

  if (type === 'app.bsky.embed.video#view') {
    notes.push('这条帖子是视频，只跳过（视频封面不是正片）');
    return [];
  }

  if (type === 'app.bsky.embed.external#view') {
    notes.push(`这条帖子挂的是外链而不是图片：${embed.external?.uri ?? ''}`);
    return [];
  }

  return [];
}

async function resolveDid(actor: string, ctx: ParseContext): Promise<string> {
  // 链接里可能直接就是 did（`bsky.app/profile/did:plc:xxx`），那就省一次请求。
  if (actor.startsWith('did:')) return actor;

  const res = await fetchJson<{ did?: string; error?: string; message?: string }>(
    `${PUBLIC_API}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
    ctx,
    { headers: { accept: 'application/json' } },
  );
  if (!res.did) {
    throw new SourcingError('NOT_FOUND', `找不到用户 ${actor}`, { actor });
  }
  return res.did;
}

type PostView = {
  uri?: string;
  author?: { handle?: string; displayName?: string };
  embed?: Embed;
  record?: { text?: string };
};

export const blueskyPostSource: SourceParser = {
  id: 'bluesky',
  match: (url) => isBskyHost(url.hostname) && POST_RE.test(url.pathname),
  async parse(url, ctx) {
    const m = POST_RE.exec(url.pathname);
    const actor = m?.[1];
    const rkey = m?.[2];
    if (!actor || !rkey) throw new SourcingError('INVALID_URL', '从链接里读不出帖子地址', { url: url.href });

    const did = await resolveDid(actor, ctx);
    const uri = `at://${did}/app.bsky.feed.post/${rkey}`;

    const res = await fetchJson<{ thread?: { post?: PostView }; error?: string; message?: string }>(
      `${PUBLIC_API}/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`,
      ctx,
      { headers: { accept: 'application/json' } },
    );

    const post = res.thread?.post;
    if (!post) throw new SourcingError('NOT_FOUND', '帖子不存在或已被删除', { resource: uri });

    const notes: string[] = [];
    const images = imagesOfEmbed(post.embed, did, notes);
    if (images.length === 0) {
      throw new SourcingError('NO_MEDIA', '这条帖子里没有可下载的图片', { resource: uri });
    }

    const author = post.author?.displayName ?? post.author?.handle;
    return {
      images: images.slice(0, ctx.maxImages),
      title: `bsky-${rkey}`,
      ...(author ? { author } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  },
};

export const blueskyUserSource: SourceParser = {
  id: 'bluesky_user',
  match: (url) => isBskyHost(url.hostname) && PROFILE_RE.test(url.pathname),
  async parse(url, ctx) {
    const actor = PROFILE_RE.exec(url.pathname)?.[1];
    if (!actor) throw new SourcingError('INVALID_URL', '从链接里读不出用户名', { url: url.href });

    const did = await resolveDid(actor, ctx);
    const notes: string[] = [];
    const images: SourcedImage[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let displayName: string | undefined;

    do {
      const params = new URLSearchParams({
        actor: did,
        filter: 'posts_with_media',
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);

      const feed = await fetchJson<{ feed?: Array<{ post?: PostView }>; cursor?: string }>(
        `${PUBLIC_API}/app.bsky.feed.getAuthorFeed?${params}`,
        ctx,
        { headers: { accept: 'application/json' } },
      );

      for (const item of feed.feed ?? []) {
        const post = item.post;
        if (!post) continue;
        displayName ??= post.author?.displayName ?? post.author?.handle;
        images.push(...imagesOfEmbed(post.embed, did, notes));
      }

      cursor = feed.cursor;
      pages += 1;
      if (images.length >= ctx.maxImages) {
        notes.push(`已达到单次导入上限 ${ctx.maxImages} 张`);
        break;
      }
      // 上限是保险丝，不是分页策略 —— 正常用户几十条就到底了。
    } while (cursor && pages < 20);

    // 同一批里 notes 可能会重复（每条视频帖子加一句），去重后交出去。
    const uniqueNotes = [...new Set(notes)];
    if (images.length === 0) {
      throw new SourcingError('NO_MEDIA', `${actor} 的近期帖子里没有图片`, { actor });
    }

    return {
      images: images.slice(0, ctx.maxImages),
      title: displayName ? `${displayName} 的帖子` : `bsky-${actor}`,
      ...(displayName ? { author: displayName } : {}),
      ...(uniqueNotes.length > 0 ? { notes: uniqueNotes } : {}),
    };
  },
};
