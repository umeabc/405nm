/**
 * 自动标号：让能看图的模型读一页，吐出「文字块的位置 + 原文」。
 *
 * 三个刻意的取舍：
 *  - **一次调用同时要位置和文字**。图译空间的做法是「先检测框、再逐框裁剪识别」，
 *    更准但一页要几十次调用；这里一页一次，代价是模型得同时干两件事。
 *    真要更准，换更大的视觉模型比加一轮调用更划算。
 *  - 送**预览图**（2000px 的 webp 变体）而不是原图：原图动辄几千像素、几 MB，
 *    传上去又慢又贵，而模型的输入本来就会被它自己缩到千把像素。
 *  - 归一化坐标**由我们算**：模型给 0~1 就照用，给像素就按送出去的图尺寸除。
 *    不把这件事交给模型（它会算错，而且错得很难发现）。
 */
import { env } from '../env.js';
import type { AiProviderConfig } from './client.js';
import { chat, extractJson } from './client.js';

/** 与既有标号判定为「同一个」的距离阈值（归一化坐标）。与图译空间取齐。 */
export const DEDUPE_RADIUS = 0.04;

export type MarkerProposal = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  positionType: 'in' | 'out';
};

export type MarkerProposeResult = {
  proposals: MarkerProposal[];
  /** 与已有标号重叠、被丢掉的个数 */
  skipped: number;
  /** 空文本 / 坐标不合法、被丢掉的个数 */
  dropped: number;
  model: string;
};

const SYSTEM = `你是漫画图片的文字识别助手。用户给你一张漫画页面，请找出页面上**所有文字块**。

对每个文字块给出：
- box: [x, y, w, h]，归一化到 0~1（相对整张图的宽和高）
- text: 框内的原文，**逐字照抄**：不要翻译、不要改写、不要补全、不要合并相邻的框
- positionType: "in" 表示对话框/气泡内的台词；"out" 表示旁白、画面上的宣传字、拟声词等

只输出 JSON 数组，例如：
[{"box":[0.12,0.34,0.2,0.08],"text":"こんにちは","positionType":"in"}]

规则：页面上没有文字就输出 []；不要输出任何解释、不要用 markdown 围栏。`;

export type ProposeOptions = {
  provider: AiProviderConfig;
  /** 送出去的图（预览变体）：data URL 与它自己的像素尺寸 */
  image: { dataUrl: string; width: number; height: number };
  /** 页面上已有的标号中心点，用来去重 */
  existing: ReadonlyArray<{ x: number; y: number }>;
  /** 可选提示，例如「这一页是从右往左读的双页」 */
  hint?: string;
};

export async function proposeMarkers(options: ProposeOptions): Promise<MarkerProposeResult> {
  const content = await chat({
    provider: options.provider,
    model: options.provider.visionModel,
    system: SYSTEM,
    user: options.hint ? `请识别这一页的文字块。补充说明：${options.hint}` : '请识别这一页的文字块。',
    images: [{ dataUrl: options.image.dataUrl }],
    temperature: 0,
  });

  const parsed = extractJson(content);
  const items = pickArray(parsed);
  const out: MarkerProposal[] = [];
  let skipped = 0;
  let dropped = 0;

  for (const raw of items.slice(0, env.AI_MAX_MARKERS * 3)) {
    const proposal = toProposal(raw, options.image);
    if (!proposal) {
      dropped += 1;
      continue;
    }
    // 与已有标号离得太近就丢掉：模型常把同一个气泡读两遍，或者把人工已经点过的位置再点一次
    if (options.existing.some((m) => Math.hypot(m.x - proposal.x, m.y - proposal.y) < DEDUPE_RADIUS)) {
      skipped += 1;
      continue;
    }
    out.push(proposal);
    if (out.length >= env.AI_MAX_MARKERS) break;
  }
  return { proposals: out, skipped, dropped, model: options.provider.visionModel };
}

/** 模型可能给 `[...]`，也可能包一层 `{markers:[...]}`。两种都认。 */
function pickArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of ['markers', 'items', 'result', 'data', 'blocks', 'texts']) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/**
 * 一个模型返回项 → 标号提案。认不出就返回 null（由调用方计入 dropped）。
 *
 * 归一化的判定只看一条：**四个数里有超过 1 的，就认为它给的是像素**。
 * 拿不准的时候宁可当像素（除一下），也不要当 0~1 —— 后者会把标号全堆在左上角，
 * 而那种错在界面上看起来像「模型什么都没识别出来」。
 */
export function toProposal(raw: unknown, image: { width: number; height: number }): MarkerProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const text = String(item.text ?? item.content ?? item.原文 ?? '').trim();
  if (!text) return null;

  const box = readBox(item.box ?? item.bbox ?? item.rect ?? item);
  if (!box) return null;
  let [x, y, w, h] = box;
  if ([x, y, w, h].some((v) => Math.abs(v) > 1.000001)) {
    if (image.width <= 0 || image.height <= 0) return null;
    x /= image.width;
    y /= image.height;
    w /= image.width;
    h /= image.height;
  }
  if (![x, y, w, h].every(Number.isFinite)) return null;

  const cx = clamp01(x + w / 2);
  const cy = clamp01(y + h / 2);
  return {
    x: cx,
    y: cy,
    w: clamp01(Math.abs(w)),
    h: clamp01(Math.abs(h)),
    text,
    positionType: /out|noise|narration|sfx|画面|旁白/i.test(String(item.positionType ?? item.type ?? '')) ? 'out' : 'in',
  };
}

/** 支持 `[x,y,w,h]`、`{x,y,w,h}`、`{left,top,width,height}` 三种写法。 */
function readBox(value: unknown): [number, number, number, number] | null {
  if (Array.isArray(value) && value.length >= 4) {
    const [x, y, w, h] = value.map(Number);
    if ([x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return [x!, y!, w!, h!];
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const num = (...keys: string[]): number | null => {
      for (const key of keys) {
        const n = Number(o[key]);
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    const x = num('x', 'left');
    const y = num('y', 'top');
    const w = num('w', 'width');
    const h = num('h', 'height');
    if (x !== null && y !== null && w !== null && h !== null) return [x, y, w, h];
  }
  return null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
