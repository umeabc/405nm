import { SourcingError } from '../errors.js';
import { fetchJson, idsOf } from '../json.js';
import type { ParseContext, SourceParseResult, SourceParser, SourcedImage } from '../types.js';

/**
 * Pixiv。
 *
 * 实测（2026-09-29，经代理）：
 *   `GET /ajax/illust/{id}`        → `{error, message, body:{pageCount, urls:{original,…}, illustType, xRestrict, userId, userName, title}}`
 *   `GET /ajax/illust/{id}/pages`  → `{body:[{urls:{original,…}, width, height}]}`（多图作品才有意义）
 *   `GET /ajax/user/{uid}/profile/all` → `{body:{illusts, manga}}` —— **这两个字段既可能是
 *        对象 `{id: null}` 也可能是空数组 `[]`**（PHP 的 json_encode 把空 map 写成 `[]`）。
 *        实测 uid=11 是对象（1578 项），uid=30612000 是空数组而 manga 有 31 项。
 *        只按其中一种写，另一种的用户会「一个作品都抓不到」且毫无报错。
 *   `i.pximg.net` **不带 `Referer: https://www.pixiv.net/` 就是 403**（不带 → 403，带 → 200，实测过两次）
 */

const ARTWORK_RE = /\/(?:artworks?|i)\/(\d+)/;
const USER_RE = /\/users\/(\d+)/;

const API = 'https://www.pixiv.net/ajax';
const SITE = 'https://www.pixiv.net/';

/** 浏览器的 ajax 请求就长这样；带上它 Pixiv 才会返回 JSON 而不是 HTML 页面。 */
const AJAX_HEADERS = {
  accept: 'application/json',
  referer: SITE,
};

type IllustDetail = {
  error: boolean;
  message: string;
  body?: {
    id: string;
    illustrativeType?: number;
    illustType?: number;
    pageCount?: number;
    width?: number;
    height?: number;
    xRestrict?: number;
    userId?: string;
    userName?: string;
    title?: string;
    urls?: { original?: string; regular?: string };
  };
};

type PagesResponse = {
  error: boolean;
  message: string;
  body?: Array<{ urls?: { original?: string }; width?: number; height?: number }>;
};

function artworkId(url: URL): string | null {
  return ARTWORK_RE.exec(url.pathname)?.[1] ?? url.searchParams.get('illust_id') ?? null;
}

function userId(url: URL): string | null {
  return USER_RE.exec(url.pathname)?.[1] ?? null;
}

/** 上游把错误塞在 200 的响应体里（`{error:true,message:"…"}`），这里统一翻成业务错误。 */
function raiseUpstream(payload: { error?: boolean; message?: string }, what: string, resource: string): void {
  if (!payload?.error) return;
  const message = payload.message ?? '';
  // 作品被删 / id 不存在时 Pixiv 就是这个文案
  if (!message || /not found|404/i.test(message)) {
    throw new SourcingError('NOT_FOUND', `${what}不存在或已被删除`, { resource });
  }
  if (/login|permission|r-?18/i.test(message)) {
    throw new SourcingError('UNSUPPORTED', `${what}需要登录才能访问（请配置该图源账号的凭据）`, { resource, message });
  }
  throw new SourcingError('PARSE', `${what}返回了错误：${message}`, { resource, message });
}

function extensionOf(url: string): string {
  const path = url.split('?')[0] ?? '';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '.jpg';
}

/**
 * 取一个作品的全部页面。
 *
 * 单图作品直接用 `urls.original`；多图的必须再问一次 `/pages`，
 * 因为详情接口里的 `urls` 只给第一张（`_p0`）的各种尺寸。
 */
async function imagesOfArtwork(id: string, ctx: ParseContext): Promise<{ images: SourcedImage[]; title?: string; author?: string; notes: string[] }> {
  const detail = await fetchJson<IllustDetail>(`${API}/illust/${id}`, ctx, { headers: AJAX_HEADERS });
  raiseUpstream(detail, '作品', id);

  const body = detail.body;
  if (!body) throw new SourcingError('PARSE', '作品详情里没有 body', { resource: id });

  // illustType: 0=插画 1=漫画 2=动图(ugoira)。动图是一串帧 + 一个 zip 配置，
  // 和「一页一张图」的模型对不上，硬塞进来会得到一堆意义不明的帧。
  const type = body.illustType ?? body.illustrativeType;
  if (type === 2) {
    throw new SourcingError('UNSUPPORTED', 'Pixiv 动图（ugoira）暂不支持导入', { resource: id });
  }

  const notes: string[] = [];
  if (body.xRestrict && body.xRestrict > 0) {
    notes.push('这是 R-18 作品，未配置 Pixiv 凭据时可能拿不到全部内容');
  }

  const pageCount = body.pageCount ?? 1;
  const images: SourcedImage[] = [];

  if (pageCount > 1) {
    const pages = await fetchJson<PagesResponse>(`${API}/illust/${id}/pages`, ctx, { headers: AJAX_HEADERS });
    raiseUpstream(pages, '作品', id);
    for (const [index, page] of (pages.body ?? []).entries()) {
      const url = page.urls?.original;
      if (!url) continue;
      images.push({
        url,
        referer: SITE,
        filename: `${id}_p${index}${extensionOf(url)}`,
        ...(page.width ? { width: page.width } : {}),
        ...(page.height ? { height: page.height } : {}),
      });
    }
  } else {
    const url = body.urls?.original;
    if (url) {
      images.push({
        url,
        referer: SITE,
        filename: `${id}_p0${extensionOf(url)}`,
        ...(body.width ? { width: body.width } : {}),
        ...(body.height ? { height: body.height } : {}),
      });
    }
  }

  if (images.length === 0) {
    throw new SourcingError('NOT_FOUND', '这个作品里没有可下载的图片', { resource: id });
  }

  return {
    images,
    ...(body.title ? { title: body.title } : {}),
    ...(body.userName ? { author: body.userName } : {}),
    notes,
  };
}

export const pixivArtworkSource: SourceParser = {
  id: 'pixiv',
  match: (url) => /(^|\.)pixiv\.net$/.test(url.hostname) && artworkId(url) !== null,
  async parse(url, ctx) {
    const id = artworkId(url);
    if (!id) throw new SourcingError('INVALID_URL', '从链接里读不出作品 id', { url: url.href });
    const { images, title, author, notes } = await imagesOfArtwork(id, ctx);
    return {
      images: images.slice(0, ctx.maxImages),
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      notes,
    };
  },
};

export const pixivUserSource: SourceParser = {
  id: 'pixiv_user',
  match: (url) => /(^|\.)pixiv\.net$/.test(url.hostname) && userId(url) !== null,
  async parse(url, ctx) {
    const uid = userId(url);
    if (!uid) throw new SourcingError('INVALID_URL', '从链接里读不出画师 id', { url: url.href });

    const profile = await fetchJson<{ error: boolean; message: string; body?: { illusts?: unknown; manga?: unknown } }>(
      `${API}/user/${uid}/profile/all`,
      ctx,
      { headers: AJAX_HEADERS },
    );
    raiseUpstream(profile, '画师主页', uid);

    // ⚠️ illusts / manga 既可能是对象也可能是空数组，两种都要吃下（见文件头）
    const ids = [...new Set([...idsOf(profile.body?.illusts), ...idsOf(profile.body?.manga)])]
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      // 作品 id 是递增分配的，按数值升序 = 按发布时间从旧到新，
      // 也就是一部作品的阅读顺序。默认倒序会让人拿到「第 10 话排在第 1 话前面」。
      .sort((a, b) => a - b);

    if (ids.length === 0) {
      throw new SourcingError('NOT_FOUND', '这位画师没有公开作品', { resource: uid });
    }

    const notes: string[] = [];
    const picked = ids.slice(0, ctx.maxWorks);
    if (picked.length < ids.length) {
      notes.push(`该画师共 ${ids.length} 个作品，本次只取最早的 ${picked.length} 个`);
    }

    const images: SourcedImage[] = [];
    let author: string | undefined;
    const failures: string[] = [];

    for (const id of picked) {
      if (images.length >= ctx.maxImages) {
        notes.push(`已达到单次导入上限 ${ctx.maxImages} 张，后面的作品没有取`);
        break;
      }
      try {
        const result = await imagesOfArtwork(String(id), ctx);
        images.push(...result.images);
        author ??= result.author;
        notes.push(...result.notes);
      } catch (err) {
        // 单个作品失败（被删、R-18 需要登录）不该让整次导入停下 ——
        // 但要如实记下来，不能悄悄跳过（moeflow 的老实现就是在这里吞错误的）。
        const reason = err instanceof SourcingError ? err.userMessage : '解析失败';
        failures.push(`${id}（${reason}）`);
      }
    }

    if (failures.length > 0) {
      notes.push(`有 ${failures.length} 个作品没取到：${failures.slice(0, 5).join('、')}${failures.length > 5 ? ' 等' : ''}`);
    }
    if (images.length === 0) {
      throw new SourcingError('NOT_FOUND', '这位画师的作品里没有可下载的图片', { resource: uid });
    }

    return {
      images: images.slice(0, ctx.maxImages),
      title: author ? `${author} 的作品` : `pixiv-${uid}`,
      ...(author ? { author } : {}),
      notes,
    };
  },
};
