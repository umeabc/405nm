import { Impit } from 'impit';
import { env } from '../env.js';
import { Semaphore } from '../lib/semaphore.js';
import { SourcingError } from './errors.js';

/**
 * 图源抓取的唯一出网口。
 *
 * ── 为什么用 impit 而不是 Node 自带的 fetch ──────────────────
 *
 * 2026-09-29 做过一次 spike（`docs/m4-sourcing-spike.md`），拿三种客户端打
 * `tls.peet.ws` 看服务端读到的指纹：
 *
 *   node fetch (undici)      JA4 = t13d5212h1_b262b3658495_…   52 个密码套件，不像任何浏览器
 *   node http2 + Chrome 参数 JA4 = t13d1512h2_a5e1f07b32e3_…   扩展顺序仍是 Node 的
 *   impit                    JA4 = t13d1516h2_8daaf6152771_…   **与真 Chrome 的 cipher hash 一致**
 *
 * 关键是最后一段：`8daaf6152771` 就是 Chrome 的 JA4 cipher hash。前两种方案
 * 只把 TLS 的**参数**设成 Chrome 的样子，扩展顺序与 HTTP/2 的 SETTINGS 帧
 * 仍是自己的 —— 而 Cloudflare 两层都看。所以这里不做「用哪个客户端」的开关：
 * 只有一个客户端，指纹才不会在某些路径上悄悄退化。
 *
 * ── 代理 ────────────────────────────────────────────────────
 *
 * 部署环境（内网出口）到 Pixiv / X 的**直连是不通的**（DNS 被污染），
 * 必须经代理。spike 已验证代理是普通的 CONNECT 隧道、不是 MITM ——
 * 经代理前后 JA4 完全相同，也就是说伪装在代理下依然有效。
 *
 * ── 实例缓存 ────────────────────────────────────────────────
 *
 * `Impit` 实例持有一个连接池，构造它要起一个 Rust runtime，不便宜。
 * 但它同时**代表一个身份**，所以缓存键必须带上代理 —— 同一个进程里
 * 「经代理」与「直连」是两个不同的出口，混用会让请求从错误的出口发出去。
 */

/** 每个出口一个客户端。键是代理地址（空串 = 直连）。 */
const clients = new Map<string, Impit>();

export function clientFor(proxyUrl: string | null): Impit {
  const key = proxyUrl ?? '';
  let client = clients.get(key);
  if (!client) {
    client = new Impit({
      // 唯一的指纹来源。改这里之前先读文件头的 spike 结论。
      browser: 'chrome',
      ...(proxyUrl ? { proxyUrl } : {}),
      // HTTP/3 与代理互斥，而且上游图源基本都只服务 h2。
      http3: false,
      followRedirects: true,
      maxRedirects: 10,
      timeout: env.SOURCING_TIMEOUT_MS,
      // 刻意**不设默认请求头**：impit 已经按 Chrome 的样式配好了，
      // 手加一个 accept-language 之类的东西反而会让 HTTP 层的头部顺序不像浏览器。
      // 需要 Referer / Cookie 的地方由调用方逐个请求传。
    });
    clients.set(key, client);
  }
  return client;
}

/** 取这次请求该用的出口。`null` 表示显式直连，`undefined` 用配置里的默认值。 */
export function resolveProxy(override?: string | null): string | null {
  if (override === null) return null;
  if (override !== undefined && override !== '') return override;
  return env.SOURCING_PROXY || null;
}

/** 所有出网请求共用一个闸门 —— 一次导入动辄上百张图，无节制开连接会先把出口压垮。 */
const gate = new Semaphore(env.SOURCING_CONCURRENCY);

export type SourcingRequest = {
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  /** 覆盖代理。`null` = 强制直连；不传 = 用 `SOURCING_PROXY`。 */
  proxyUrl?: string | null;
  /** 只认这些状态码为成功。默认 2xx。 */
  acceptStatuses?: readonly number[];
};

export type SourcingResponse = {
  status: number;
  contentType: string;
  body: Buffer;
  headers: { get(name: string): string | null };
};

const RETRY_DELAYS_MS = [600, 1800];

export async function sourcingFetch(
  url: string,
  request: SourcingRequest = {},
): Promise<SourcingResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourcingError('INVALID_URL', `链接格式不对：${url.slice(0, 120)}`, { url });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SourcingError('UNSUPPORTED', `只支持 http/https：${parsed.protocol}`, { url });
  }

  const proxyUrl = resolveProxy(request.proxyUrl);
  const client = clientFor(proxyUrl);

  let lastError: SourcingError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await gate.run(() => once(client, url, request));
    } catch (err) {
      const failure = toSourcingError(err, url, proxyUrl);
      lastError = failure;
      // 只有瞬时故障才重试。403 被拦、404 不存在、链接写错 —— 重试一万次也一样。
      if (!failure.retryable || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }

  throw lastError ?? new SourcingError('NETWORK', '抓取失败', { url });
}

async function once(
  client: Impit,
  url: string,
  request: SourcingRequest,
): Promise<SourcingResponse> {
  const response = await client.fetch(url, {
    method: request.method ?? 'GET',
    headers: { ...(request.headers ?? {}) },
    ...(request.body === undefined ? {} : { body: request.body }),
    timeout: request.timeoutMs ?? env.SOURCING_TIMEOUT_MS,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const buffer = Buffer.from(await response.arrayBuffer());

  const accepted = request.acceptStatuses
    ? request.acceptStatuses.includes(response.status)
    : response.status >= 200 && response.status < 300;

  if (!accepted) {
    throw classifyStatus(response.status, contentType, buffer, url, response.headers);
  }

  return { status: response.status, contentType, body: buffer, headers: response.headers };
}

/**
 * 把「状态码不对」细分成几种真正不同的处境。
 *
 * 关键是别把所有 403 都当成「被拦」。403 至少有两种完全不同的来路：
 *
 *  - **机器人拦截**（Cloudflare 挑战页）：需要人去换出口或升级伪装，重试无用；
 *  - **请求本身不对**（i.pximg.net 没带 Referer 就是 403）：加个请求头就好，
 *    和「被墙了」完全不是一回事。
 *
 * 所以 403 要看**证据**（`server: cloudflare`，或页面里有挑战页的特征串）
 * 才判 `BLOCKED`。判错的代价是运维跑去查出口，而真正的问题只是一个缺了的请求头。
 */
function classifyStatus(
  status: number,
  contentType: string,
  body: Buffer,
  url: string,
  responseHeaders: { get(name: string): string | null },
): SourcingError {
  if (status === 404 || status === 410) {
    return new SourcingError('NOT_FOUND', `上游返回 ${status}`, { url, status });
  }
  if (status === 429) {
    return new SourcingError('RATE_LIMITED', '上游限流（429）', { url, status });
  }
  if (status === 403 && looksLikeBotBlock(responseHeaders, body)) {
    return new SourcingError('BLOCKED', '被上游的机器人防护拦下（403）', {
      url,
      status,
      server: responseHeaders.get('server') ?? '',
      // 只留一小段，用来人工确认是不是 Cloudflare 的挑战页。
      body: body.toString('utf8', 0, 200),
    });
  }
  // 5xx 是上游**暂时**出问题，重试有意义；其他 4xx 是请求本身不对，重试无意义。
  if (status >= 500) {
    return new SourcingError('UPSTREAM_ERROR', `上游返回 ${status}`, { url, status, contentType });
  }
  return new SourcingError('HTTP_STATUS', `上游返回 ${status}`, { url, status, contentType });
}

const BLOCK_MARKERS = ['just a moment', 'cf-chl', 'cf_chl', 'attention required', 'enable javascript and cookies'];

function looksLikeBotBlock(headers: { get(name: string): string | null }, body: Buffer): boolean {
  const server = (headers.get('server') ?? '').toLowerCase();
  if (!server.includes('cloudflare')) {
    // 不是 Cloudflare 也不一定就没拦（别家防护也有），所以再看页面内容。
    const text = body.toString('utf8', 0, 2000).toLowerCase();
    return BLOCK_MARKERS.some((marker) => text.includes(marker));
  }
  // Cloudflare 的 403 有两类：挑战页（拦爬虫）与源站自己回的 403 透传。
  // 挑战页必然带特征串，据此区分。
  const text = body.toString('utf8', 0, 2000).toLowerCase();
  return BLOCK_MARKERS.some((marker) => text.includes(marker)) || text.length < 64;
}

/** impit 的错误是一棵细分的类树，这里把它压成上面那套业务分类。 */
function toSourcingError(err: unknown, url: string, proxyUrl: string | null): SourcingError {
  if (err instanceof SourcingError) return err;

  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  const detail = { url, proxy: proxyUrl ? maskProxy(proxyUrl) : '(直连)', upstream: message.slice(0, 200) };

  if (name === 'InvalidURL') return new SourcingError('INVALID_URL', '链接格式不对', detail);
  if (name === 'TooManyRedirects') return new SourcingError('TOO_MANY_REDIRECTS', '重定向次数过多', detail);
  // 超时要排在代理之前：ProxyTimeout 之类的名字两边都占，而超时是可重试的瞬时故障。
  if (name.includes('Timeout')) return new SourcingError('TIMEOUT', `请求超时：${message}`, detail);
  if (name.includes('Proxy')) return new SourcingError('PROXY', `代理不可用：${message}`, detail);

  // ⚠️ 配了代理时，**连接层的失败一律归为 PROXY**，这是有意为之的启发式。
  //
  // 实测：proxyUrl 指向一个关着的端口时，impit 抛的是 `ConnectError` 而不是
  // 某个 `Proxy*` 错误 —— 它在连接阶段分不出「代理连不上」和「目标连不上」。
  // 但那两种情况**该做的事是同一件**：去查出口。报成 NETWORK（隐含「等一等再试」）
  // 会把运维引向错误的方向。代价是当代理本身正常、只是它到不了目标时，
  // 也会显示「代理不可用」—— 措辞上吃一点亏，换分类不出错。
  if (proxyUrl && (name === 'ConnectError' || name === 'NetworkError')) {
    return new SourcingError('PROXY', `经代理连不上（${message}）`, detail);
  }

  return new SourcingError('NETWORK', `网络错误：${message}`, detail);
}

/** 代理地址可能带用户名密码，日志与错误详情里一律掩码。 */
export function maskProxy(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    return '(无法解析的代理地址)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 仅供测试与「换出口后重试」用：丢掉缓存的客户端。 */
export function resetSourcingClients(): void {
  clients.clear();
}
