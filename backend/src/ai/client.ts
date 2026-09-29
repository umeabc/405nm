/**
 * OpenAI 兼容的模型客户端。**只做一件事**：把「一段提示 + 可选的图」发出去，拿回文本。
 *
 * 刻意不做的事：
 *  - 不引 SDK。各家网关（官方、Azure、自建 vLLM、one-api…）都实现了同一个
 *    `/chat/completions`，一个 POST 就够；引 SDK 等于把「兼容」交给 SDK 的版本节奏。
 *  - 不传 `response_format`。不少自建网关收到没实现的字段会直接 400，
 *    而我们要的是「尽量拿到 JSON」而不是「一定拿不到」。改为把 JSON 从回复里**抠**出来。
 *  - 不在这里落库、不在这里判权限。那些属于上层。
 *
 * 出网沿用图源那一套（`sourcingFetch`）：同一个 impit 客户端、同一套代理语义、
 * 同一套失败分类。**代理留空 = 直连**，不跟随 SOURCING_PROXY —— 自建模型多半在内网，
 * 跟随站点默认出口会让「配了抓取代理的机器上所有模型调用都绕一圈甚至直接失败」。
 */
import { env } from '../env.js';
import { Semaphore } from '../lib/semaphore.js';
import { resolveProxy, sourcingFetch } from '../sourcing/http.js';

export type AiProviderConfig = {
  id: string;
  baseUrl: string;
  /** 解密后的明文 key（只在内存里短暂存在，绝不入日志） */
  apiKey: string;
  chatModel: string;
  visionModel: string;
  proxyUrl: string;
};

export type AiErrorCode =
  | 'CONFIG' // 配置不全（没 key、没模型名、地址不对）
  | 'AUTH' // key 不对 / 没权限
  | 'RATE_LIMITED' // 被限流
  | 'TIMEOUT'
  | 'UPSTREAM' // 上游 5xx 或网络错误
  | 'BAD_RESPONSE'; // 通了，但回的东西看不懂

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** 模型调用单独一个闸门：与图源抓取分开，免得一批抓取把模型排队排到超时。 */
const gate = new Semaphore(env.AI_CONCURRENCY);

export type ChatImage = { dataUrl: string };

export type ChatOptions = {
  provider: AiProviderConfig;
  /** 用哪个模型；识别走 provider.visionModel，翻译走 chatModel */
  model: string;
  system?: string;
  user: string;
  images?: ChatImage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

const RETRY_DELAYS_MS = [800, 2400];

/** 发一次对话请求，返回助手回复的纯文本。 */
export async function chat(options: ChatOptions): Promise<string> {
  const { provider, model } = options;
  if (!provider.baseUrl) throw new AiError('CONFIG', '这个配置还没有填接口地址', false);
  if (!provider.apiKey) throw new AiError('CONFIG', '这个配置还没有填 API Key', false);
  if (!model) throw new AiError('CONFIG', '这个配置还没有指定要用的模型', false);

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model,
    temperature: options.temperature ?? 0.2,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    messages: [
      ...(options.system ? [{ role: 'system', content: options.system }] : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: options.user },
          ...(options.images ?? []).map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ],
      },
    ],
  });

  let last: AiError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await gate.run(() => once(url, body, provider, options.timeoutMs));
    } catch (err) {
      const failure = err instanceof AiError ? err : new AiError('UPSTREAM', '模型调用失败', true);
      last = failure;
      if (!failure.retryable || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]!));
    }
  }
  throw last ?? new AiError('UPSTREAM', '模型调用失败', true);
}

async function once(url: string, body: string, provider: AiProviderConfig, timeoutMs?: number): Promise<string> {
  let response: Awaited<ReturnType<typeof sourcingFetch>>;
  try {
    response = await sourcingFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${provider.apiKey}`,
        // 少数网关按这个头挑格式；与 OpenAI 的默认一致
        accept: 'application/json',
      },
      body,
      // 留空 = 直连（不跟随站点默认出口），见文件头
      proxyUrl: resolveProxy(provider.proxyUrl.trim() || null),
      timeoutMs: timeoutMs ?? env.AI_TIMEOUT_MS,
      acceptStatuses: [200, 201, 400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504],
    });
  } catch (err) {
    // 连接层分不出「代理挂了」和「目标不可达」，一律按可重试的上游故障处理
    throw new AiError('UPSTREAM', `连不上模型服务：${(err as Error).message}`, true);
  }

  const text = response.body.toString('utf8');
  if (response.status === 401 || response.status === 403) {
    throw new AiError('AUTH', 'API Key 被拒（检查 Key 与接口地址是否匹配）', false);
  }
  if (response.status === 429) {
    throw new AiError('RATE_LIMITED', '被上游限流', true);
  }
  if (response.status >= 400) {
    throw new AiError(
      response.status >= 500 ? 'UPSTREAM' : 'CONFIG',
      `模型服务返回 ${response.status}：${snippet(text)}`,
      response.status >= 500,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiError('BAD_RESPONSE', `模型服务没有返回 JSON：${snippet(text)}`, false);
  }
  const content = pickContent(parsed);
  if (content === null) throw new AiError('BAD_RESPONSE', `回复里没有可选的内容：${snippet(text)}`, false);
  return content;
}

/** 兼容两种形态：`{choices:[{message:{content}}]}` 与少数网关的 `{choices:[{text}]}`。 */
function pickContent(payload: unknown): string | null {
  const root = payload as { choices?: unknown[]; error?: { message?: string } };
  if (root?.error?.message) throw new AiError('CONFIG', `模型服务报错：${snippet(root.error.message)}`, false);
  const first = Array.isArray(root?.choices) ? (root.choices[0] as Record<string, unknown>) : undefined;
  if (!first) return null;
  const message = first.message as { content?: unknown } | undefined;
  const content = message?.content ?? first.text;
  if (typeof content === 'string') return content;
  // 有些网关把 content 拆成数组（多段文本）
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String((part as { text?: string })?.text ?? '')))
      .join('');
  }
  return null;
}

const snippet = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text);

/**
 * 从回复里抠出 JSON。
 *
 * 模型经常这样回：先一句「好的，以下是结果：」，再来一段 ```json 围栏。
 * 直接 `JSON.parse` 必然失败，而**失败一次就是一次调用白花**。所以：
 * 去掉围栏 → 从第一个 `{` 或 `[` 扫到与之配对的收尾（跳过字符串里的括号）→ 解析。
 */
export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const direct = tryParse(cleaned);
  if (direct.ok) return direct.value;

  const start = firstBracket(cleaned);
  if (start < 0) throw new AiError('BAD_RESPONSE', `回复里找不到 JSON：${snippet(text)}`, false);
  const end = matchBracket(cleaned, start);
  if (end < 0) throw new AiError('BAD_RESPONSE', `回复里的 JSON 不完整：${snippet(text)}`, false);
  const sliced = tryParse(cleaned.slice(start, end + 1));
  if (sliced.ok) return sliced.value;
  throw new AiError('BAD_RESPONSE', `回复里的 JSON 解析不了：${snippet(text)}`, false);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function firstBracket(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace < 0) return bracket;
  if (bracket < 0) return brace;
  return Math.min(brace, bracket);
}

/** 找与 `start` 处括号配对的收尾位置；字符串内的括号不算。 */
function matchBracket(text: string, start: number): number {
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
