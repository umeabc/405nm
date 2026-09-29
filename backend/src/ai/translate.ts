/**
 * 机翻提案：把一页里已有的标号原文批量译成目标语言。
 *
 * **只出提案，不落库** —— 落库在 `applyTranslations()`，而且要人点一下。
 * 这样「AI 帮了多少忙」是可度量的，也随时能退回人工：机翻进的是 `translations`
 * 的候选位（`machineTranslated = true`、**不选中**），人工挑哪份仍是人的决定。
 *
 * 术语表按图译空间的做法处理：**只带这一批原文里真的出现过的词**（子串命中），
 * 长词优先，总数封顶。整库塞进 prompt 既贵又会让模型走神。
 */
import type { AiProviderConfig } from './client.js';
import { chat, extractJson } from './client.js';

export type GlossaryEntry = { source: string; target: string };

/**
 * 命中子串的术语。纯函数，好测。
 *
 * 排序按**词长从大到小**：截断时先丢短词 —— 短词更容易误命中（「王」出现在无数地方），
 * 而长词几乎不会误伤。同源词只留第一条。
 */
export function matchGlossary(
  texts: readonly string[],
  glossary: readonly GlossaryEntry[],
  limit: number,
): GlossaryEntry[] {
  const haystack = texts.join('\n');
  const seen = new Set<string>();
  const hits: GlossaryEntry[] = [];
  for (const entry of glossary) {
    const source = entry.source.trim();
    if (!source || seen.has(source)) continue;
    if (!haystack.includes(source)) continue;
    seen.add(source);
    hits.push({ source, target: entry.target });
  }
  hits.sort((a, b) => b.source.length - a.source.length);
  return hits.slice(0, Math.max(0, limit));
}

const SYSTEM = (targetLabel: string) => `你是专业的漫画翻译。把用户给出的每条原文译成${targetLabel}。

规则：
- **逐条对应**：不要合并、不要遗漏、不要新增条目；返回的 id 必须与输入一一对应
- 对话气泡里的台词要口语、简短、符合语气；旁白用书面语；拟声词按中文习惯意译
- 术语表里给出的词**必须**使用它指定的译法
- 只输出 JSON 数组：[{"id":"输入的 id","translated":"译文"}]
- 不要输出任何解释，不要用 markdown 围栏`;

export type TranslateItem = { id: string; text: string };

export type TranslationProposal = {
  sourceId: string;
  original: string;
  translated: string;
  /** 这条用到了哪些术语（命中的源词），便于人核对 */
  terms: string[];
};

export type TranslateProposeResult = {
  proposals: TranslationProposal[];
  glossary: GlossaryEntry[];
  /** 模型漏掉的条数 */
  missing: number;
  model: string;
};

export type TranslateOptions = {
  provider: AiProviderConfig;
  /** 目标语言的中文名，例如「繁体中文」 */
  targetLabel: string;
  items: readonly TranslateItem[];
  glossary?: readonly GlossaryEntry[];
  /** 作品/页面级别的上下文，一句话即可 */
  context?: string;
};

export async function proposeTranslations(options: TranslateOptions): Promise<TranslateProposeResult> {
  if (options.items.length === 0) {
    return { proposals: [], glossary: [], missing: 0, model: options.provider.chatModel };
  }
  const glossary = [...(options.glossary ?? [])];
  const parts: string[] = [];
  if (options.context) parts.push(`背景：${options.context}`);
  if (glossary.length) {
    parts.push(`术语表（必须遵守）：\n${glossary.map((g) => `${g.source} → ${g.target}`).join('\n')}`);
  }
  parts.push(
    `待翻译（共 ${options.items.length} 条）：\n${JSON.stringify(
      options.items.map((item) => ({ id: item.id, text: item.text })),
      null,
      0,
    )}`,
  );

  const content = await chat({
    provider: options.provider,
    model: options.provider.chatModel,
    system: SYSTEM(options.targetLabel),
    user: parts.join('\n\n'),
    temperature: 0.2,
  });

  const parsed = extractJson(content);
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as { translations?: unknown[]; items?: unknown[] })?.translations ??
      (parsed as { items?: unknown[] })?.items ??
      []);
  const byId = new Map<string, string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const id = String(item.id ?? item.sourceId ?? '');
    const translated = String(item.translated ?? item.text ?? item.译文 ?? '').trim();
    if (id && translated) byId.set(id, translated);
  }

  const hitTerms = new Set(glossary.map((g) => g.source));
  const proposals: TranslationProposal[] = [];
  let missing = 0;
  for (const item of options.items) {
    const translated = byId.get(item.id);
    if (!translated) {
      missing += 1;
      continue;
    }
    proposals.push({
      sourceId: item.id,
      original: item.text,
      translated,
      terms: [...hitTerms].filter((term) => item.text.includes(term)),
    });
  }
  return { proposals, glossary, missing, model: options.provider.chatModel };
}
