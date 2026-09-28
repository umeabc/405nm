import { SourcingError } from './errors.js';
import { sourcingFetch } from './http.js';
import type { ParseContext } from './types.js';

/**
 * 抓一个 JSON 接口。
 *
 * 三个解析器都要做同一件事：发请求 → 检查状态 → 解析 JSON → 把「返回的不是 JSON」
 * 和「连不上」分开报。各写一遍的话，某一次修改之后三处的错误文案就会不一致，
 * 而失败分类是给用户看的，不一致比不精确更糟。
 *
 * **上游把错误写在 200 的响应体里**是这些非官方接口的常态（Pixiv 的 `{error:true, message}`、
 * X 的 `{errors:[...]}`），所以这里只负责「拿到并解析」，具体业务错误由调用方判 ——
 * 但解析失败一定要报成 `PARSE`，不能悄悄返回空对象让上层以为「没有图片」。
 */
export async function fetchJson<T = unknown>(
  url: string,
  ctx: ParseContext,
  init: {
    headers?: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: string;
    /** 期望的 HTTP 状态之外是否也算成功（默认只认 2xx） */
    acceptStatuses?: readonly number[];
  } = {},
): Promise<T> {
  const res = await sourcingFetch(url, {
    proxyUrl: ctx.proxyUrl,
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.method ? { method: init.method } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.acceptStatuses ? { acceptStatuses: init.acceptStatuses } : {}),
  });

  const text = res.body.toString('utf8');
  if (text.trim() === '') {
    throw new SourcingError('EMPTY', '上游返回了空响应', { url });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // 常见于「被拦了但状态码是 200」（挑战页是 HTML）。
    // 这里报 PARSE 而不是 BLOCKED，是因为确实无法确定 —— 让上层结合状态码与内容判断。
    throw new SourcingError('PARSE', '上游返回的不是 JSON（接口可能已变更，或返回了拦截页）', {
      url,
      contentType: res.contentType,
      head: text.slice(0, 160),
    });
  }
}

/** 把对象/数组两种形态统一成「id 列表」。Pixiv 的 profile/all 两种都会返回。 */
export function idsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}
