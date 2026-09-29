import { env } from '../env.js';
import {
  PlatformError,
  type PlatformAdapter,
  type PlatformImage,
  type PublishContext,
  type PublishDraft,
  type TopicOption,
  type MentionOption,
  type VerifyResult,
} from './adapter.js';

/**
 * B 站动态发布适配器。
 *
 * 实现搬自 `umeabc/380nm` 的 `src/bilibili.js`（自有仓库），有三处**刻意的改动**：
 *
 *  1. **`upload_id` 由调用方传入**（`ctx.uploadId`），不再是每次 `randomBytes(16)`。
 *     旧写法让图片上传这一步不可重试 —— 重试等于又传一张新图。
 *  2. **失败按「有没有副作用」分类**（见 `PlatformError`）。旧实现把所有异常
 *     都当成「可重试」，其中网络超时是**歧义**的：请求可能已经发布成功了。
 *  3. **出网用原生 `fetch` 直连，不走抓取那层的代理与指纹**。理由见下。
 *
 * ── 为什么这里不用 `sourcing/http.ts` ──────────────────────
 *
 * 那一层是为**被反爬拦的图源**准备的：浏览器 TLS 指纹 + 必经代理
 * （内网到 Pixiv / 图床的直连被 DNS 污染）。而 B 站是**国内站点、直连可达**
 * —— 2026-09-29 在测试机上实测 `api.bilibili.com` HTTP 200 / 0.2s，
 * 同机 `pixiv.net` 则完全不通。这里做的是**带 Cookie 的身份化 API 调用**，
 * 既不需要伪装浏览器，也不该被绕到境外代理上去。
 *
 * 若将来的部署环境到 B 站不通，再给这一层加一个独立的代理配置 ——
 * 而**不要**直接复用 `SOURCING_PROXY`：那两个出口的可用性没有关系。
 */

const API = 'https://api.bilibili.com';

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // 动态发布必须带这个 referer，否则部分接口会拒绝
  referer: 'https://t.bilibili.com/',
  accept: 'application/json, text/plain, */*',
};

type BiliResponse = { code?: number; message?: string; data?: unknown };

/**
 * 发一次请求并解析。
 *
 * ⚠️ 这里的分类是整条链路的关键：**只有「服务器明确回了业务错误码」才算
 * 确定失败**。网络层抛出的任何东西（超时、连接重置、DNS）一律**歧义** ——
 * 请求可能已经到达并被执行了。
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<{ status: number; json: BiliResponse }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    throw new PlatformError(
      isTimeout ? 'TIMEOUT' : 'NETWORK',
      `${what}时网络异常（${isTimeout ? '超时' : '连接失败'}）：${String((err as Error).message ?? err)}`,
      // 都算歧义：请求可能已经被处理了，只是我们没拿到回应
      { retryable: false, ambiguous: true },
    );
  }

  let json: BiliResponse | null = null;
  try {
    json = (await res.json()) as BiliResponse;
  } catch {
    json = null;
  }

  // 服务器应答了，但内容不是预期形状 —— 我们无法判断它做了什么
  if (json === null) {
    throw new PlatformError(
      'BAD_RESPONSE',
      `${what}返回了无法解析的内容（HTTP ${res.status}）`,
      { retryable: false, ambiguous: true },
    );
  }

  return { status: res.status, json };
}

/** 服务器明确回了非 0 业务码 —— 这是**确定失败**，重试安全。 */
function businessError(what: string, json: BiliResponse): PlatformError {
  return new PlatformError(
    `BILI_${json.code ?? 'UNKNOWN'}`,
    `${what}失败（code ${json.code ?? '?'}）：${json.message || '未知原因'}`,
    { retryable: true, ambiguous: false },
  );
}

export class BilibiliAdapter implements PlatformAdapter {
  readonly id = 'bilibili' as const;
  readonly label = 'B 站动态';

  private sessdata(credentials: Record<string, string>): string {
    const value = credentials.sessdata?.trim() ?? '';
    if (!value) throw new PlatformError('NO_CREDENTIAL', '缺少 SESSDATA', { retryable: false, ambiguous: false });
    return value;
  }

  private csrf(credentials: Record<string, string>): string {
    const value = credentials.biliJct?.trim() ?? '';
    if (!value) throw new PlatformError('NO_CREDENTIAL', '缺少 bili_jct', { retryable: false, ambiguous: false });
    return value;
  }

  async verifyCredential(credentials: Record<string, string>): Promise<VerifyResult> {
    const sessdata = credentials.sessdata?.trim() ?? '';
    if (!sessdata) return { ok: false, error: '没有填 SESSDATA' };

    try {
      const { json } = await request(
        `${API}/x/web-interface/nav`,
        { headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` } },
        15000,
        '校验凭据',
      );
      const data = (json?.data ?? {}) as { isLogin?: boolean; mid?: number; uname?: string; face?: string };
      if (json?.code !== 0 || !data.isLogin) {
        return { ok: false, error: json?.message || 'Cookie 已失效，请重新登录 B 站后复制' };
      }
      return {
        ok: true,
        profile: {
          uid: String(data.mid ?? ''),
          name: String(data.uname ?? ''),
          avatarUrl: String(data.face ?? ''),
        },
      };
    } catch (err) {
      // 校验失败一律按「没通过」返回，不抛 —— 调用方（保存账号）要的是
      // 「能不能用」，而不是一个异常栈。
      return { ok: false, error: err instanceof Error ? err.message : '校验请求失败' };
    }
  }

  async uploadImage(
    ctx: PublishContext,
    image: { buffer: Buffer; filename: string; contentType: string },
  ): Promise<PlatformImage> {
    const sessdata = this.sessdata(ctx.credentials);
    const csrf = this.csrf(ctx.credentials);

    const form = new FormData();
    form.append('file_up', new Blob([new Uint8Array(image.buffer)], { type: image.contentType }), image.filename);
    form.append('biz', 'new_dyn');
    form.append('category', 'daily');
    form.append('csrf', csrf);
    // 确定性：同一条任务的每次重试用的是同一个 upload_id
    form.append('upload_id', ctx.uploadId);

    const { json } = await request(
      `${API}/x/dynamic/feed/draw/upload_bfs`,
      {
        method: 'POST',
        headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}` },
        body: form,
      },
      120000,
      '上传图片',
    );

    if (json.code !== 0) throw businessError('上传图片', json);

    const data = (json.data ?? {}) as { image_url?: string; image_width?: number; image_height?: number; img_size?: number };
    if (!data.image_url) {
      throw new PlatformError('UPLOAD_NO_URL', '图片上传返回里没有 image_url', {
        // 服务器接受了请求但返回结构不对：不确定它到底存没存下这张图。
        // 图片这一步本身不产生对外可见的副作用（最多是平台上多一张没人引用的图），
        // 所以仍然可以重试。
        retryable: true,
        ambiguous: false,
      });
    }

    return {
      src: data.image_url,
      width: data.image_width ?? 0,
      height: data.image_height ?? 0,
      size: data.img_size ?? 0,
    };
  }

  async searchTopic(ctx: PublishContext, keyword: string): Promise<TopicOption[]> {
    const sessdata = this.sessdata(ctx.credentials);
    const q = new URLSearchParams({
      keywords: String(keyword),
      content: String(keyword),
      upload_id: ctx.uploadId,
      page_size: '20',
      page_num: '1',
    });

    const { json } = await request(
      `${API}/x/topic/pub/search?${q.toString()}`,
      { headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` } },
      15000,
      '搜索话题',
    );
    if (json.code !== 0) throw businessError('搜索话题', json);

    const data = (json.data ?? {}) as { topic_items?: Array<{ id?: number; name?: string; stat_desc?: string }> };
    return (data.topic_items ?? []).map((t) => ({
      id: String(t.id ?? ''),
      name: String(t.name ?? ''),
      statDesc: t.stat_desc ?? '',
    }));
  }

  async searchMention(ctx: PublishContext, keyword: string): Promise<MentionOption[]> {
    const sessdata = this.sessdata(ctx.credentials);
    const { json } = await request(
      `${API}/x/polymer/web-dynamic/v1/mention/search?keyword=${encodeURIComponent(keyword)}`,
      { headers: { ...DEFAULT_HEADERS, cookie: `SESSDATA=${sessdata}` } },
      15000,
      '@人搜索',
    );
    if (json.code !== 0) throw businessError('@人搜索', json);

    const data = (json.data ?? {}) as {
      groups?: Array<{ items?: Array<{ uid?: number | string; name?: string; face?: string; fans?: number }> }>;
    };
    const items: MentionOption[] = [];
    for (const group of data.groups ?? []) {
      for (const item of group.items ?? []) {
        if (item.uid && item.name) {
          items.push({ uid: String(item.uid), name: item.name, face: item.face ?? '', fans: item.fans ?? 0 });
        }
      }
    }
    return items;
  }

  /**
   * 把纯文本 + @提及列表组装成动态的内容节点序列。
   *
   * 普通文本 → `{raw_text, type:1}`；@用户 → `{raw_text:'@昵称 ', type:2, biz_id:<uid>}`。
   * **只有 type:2 且带 biz_id 的节点在 B 站那边才是可点击的 @** ——
   * 正文里写一个 `@某人` 而没进这个数组，它就只是一段普通文字。
   */
  buildContents(text: string, mentions: Array<{ name: string; uid: string }> = []) {
    const nodes: Array<{ raw_text: string; type: number; biz_id: string }> = [];
    const hits: Array<{ idx: number; len: number; m: { name: string; uid: string } }> = [];

    for (const m of mentions) {
      if (!m?.name || !m?.uid) continue;
      const idx = text.indexOf(`@${m.name}`);
      if (idx >= 0) hits.push({ idx, len: m.name.length + 1, m });
    }
    hits.sort((a, b) => a.idx - b.idx);

    let pos = 0;
    const pushText = (seg: string) => {
      if (seg) nodes.push({ raw_text: seg, type: 1, biz_id: '' });
    };
    for (const it of hits) {
      if (it.idx < pos) continue;
      pushText(text.slice(pos, it.idx));
      // 结尾那个空格是必需的：实测不带空格时显示成「@昵称」紧贴后文
      nodes.push({ raw_text: `@${it.m.name} `, type: 2, biz_id: String(it.m.uid) });
      pos = it.idx + it.len;
    }
    pushText(text.slice(pos));

    // 正文里没出现的提及追加到末尾，避免「选了人却没 @ 上」
    for (const m of mentions) {
      if (m?.name && m?.uid && !nodes.some((n) => n.type === 2 && n.biz_id === String(m.uid))) {
        nodes.push({ raw_text: `@${m.name} `, type: 2, biz_id: String(m.uid) });
      }
    }

    if (nodes.length === 0) nodes.push({ raw_text: text, type: 1, biz_id: '' });
    return nodes;
  }

  /**
   * 发布动态。
   *
   * ⚠️ **这个接口没有幂等参数。** 调用方必须在此之前先落一条
   * `publish_attempts(phase='publish', status='in_flight')`，
   * 否则「发出去了但没来得及写库」就是一条永远查不出来的重复。
   */
  async publish(ctx: PublishContext, draft: PublishDraft): Promise<{ externalId: string; url: string }> {
    const sessdata = this.sessdata(ctx.credentials);
    const csrf = this.csrf(ctx.credentials);

    let finalText = String(draft.text ?? '');
    const dynReq: Record<string, unknown> = {
      content: { contents: [{ raw_text: finalText, type: 1, biz_id: '' }], scene: 1 },
      attach_card: null,
      upload_id: ctx.uploadId,
      scene: 1,
      pics: draft.images,
    };

    const title = String(draft.title ?? '').trim();
    if (title) (dynReq.content as Record<string, unknown>).title = title;

    if (draft.topic?.id && draft.topic?.name) {
      // 话题要在正文里出现 `#名字#`，否则动态上看不到话题入口
      if (!finalText.includes(`#${draft.topic.name}#`)) {
        finalText = `${finalText} #${draft.topic.name}# `;
      }
      dynReq.topic = {
        id: Number(draft.topic.id),
        name: draft.topic.name,
        from_source: 'dyn.web.create',
        from_topic_id: 0,
      };
    }

    (dynReq.content as Record<string, unknown>).contents = this.buildContents(finalText, draft.mentions ?? []);

    const { json } = await request(
      `${API}/x/dynamic/feed/create/dyn?platform=web&csrf=${encodeURIComponent(csrf)}`,
      {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'content-type': 'application/json;charset=UTF-8',
          cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}`,
        },
        body: JSON.stringify({ dyn_req: dynReq }),
      },
      env.PUBLISH_TIMEOUT_MS,
      '发布动态',
    );

    if (json.code !== 0) throw businessError('发布动态', json);

    const data = (json.data ?? {}) as { dyn_id_str?: string; dyn_id?: number | string };
    const dynId = String(data.dyn_id_str || data.dyn_id || '');
    if (!dynId) {
      // 服务器说成功了，却没给 id。这条动态**很可能已经发出去了** ——
      // 绝不能当成失败重试。
      throw new PlatformError('NO_DYN_ID', '发布接口返回成功，但没有拿到动态 id（可能已经发出去了）', {
        retryable: false,
        ambiguous: true,
      });
    }

    return { externalId: dynId, url: `https://t.bilibili.com/${dynId}` };
  }
}

export const bilibiliAdapter = new BilibiliAdapter();
