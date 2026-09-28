import { isSourcingError } from './errors.js';
import { sourcingFetch } from './http.js';
import type { SourceId } from './types.js';

/**
 * 图源账号的连通性自检。
 *
 * 后台点「测试」时跑它。选的探测点都是**必然有响应**的地址 ——
 * 只要它不是 403/503 就说明「出口通、没被拦」，至于内容对不对不重要。
 *
 * 为什么不直接拿一个真实作品去试：那会把「这个账号能不能用」和
 * 「那个作品还在不在」混在一起，而后者的失败会让人以为账号配错了。
 */

type Probe = { url: string; label: string; headers?: Record<string, string> };

const PROBES: Partial<Record<SourceId, Probe>> = {
  twitter: {
    label: 'X 的 syndication 接口',
    // id=20 是那条著名的「just setting up my twttr」，永远存在
    url: 'https://cdn.syndication.twimg.com/tweet-result?id=20&lang=en&token=x',
  },
  twitter_user: {
    label: 'X 的 GraphQL 接口',
    url: 'https://cdn.syndication.twimg.com/tweet-result?id=20&lang=en&token=x',
  },
  pixiv: { label: 'Pixiv 排行榜接口', url: 'https://www.pixiv.net/ranking.php?mode=daily&format=json' },
  pixiv_user: { label: 'Pixiv 排行榜接口', url: 'https://www.pixiv.net/ranking.php?mode=daily&format=json' },
  bluesky: { label: 'Bluesky 公开 API', url: 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app' },
  bluesky_user: { label: 'Bluesky 公开 API', url: 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app' },
};

export type ProbeResult = { ok: boolean; status: string; message: string };

export async function probeAccount(source: SourceId, proxyUrl: string | null): Promise<ProbeResult> {
  const probe = PROBES[source];
  if (!probe) {
    return { ok: true, status: 'skip', message: '这类图源不需要凭据，无需测试' };
  }

  try {
    const res = await sourcingFetch(probe.url, {
      proxyUrl,
      ...(probe.headers ? { headers: probe.headers } : {}),
      timeoutMs: 15000,
    });
    return {
      ok: true,
      status: 'ok',
      message: `${probe.label} 可达（HTTP ${res.status}）`,
    };
  } catch (err) {
    if (isSourcingError(err)) {
      return { ok: false, status: err.code, message: `${probe.label}：${err.userMessage}` };
    }
    return { ok: false, status: 'UNKNOWN', message: err instanceof Error ? err.message : '测试失败' };
  }
}
