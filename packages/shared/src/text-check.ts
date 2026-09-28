/**
 * 译文规范检查。
 *
 * 校对环节里最耗时的一类问题是「完全不用动脑子但必须挨个看」的：
 * 半角逗号、`...` 当省略号、括号少一半、行尾多一个空格。
 * 这些让机器指出来，人只需要修，能省掉校对很大一部分体力。
 *
 * 检查**只报问题、不改文本**。自动改标点是危险的：`1,000` 里的逗号
 * 不该变成全角，`...` 有时是刻意为之。给出位置让人自己决定。
 */

export type TextIssueSeverity = 'error' | 'warning';

export type TextIssue = {
  code: string;
  severity: TextIssueSeverity;
  message: string;
  /** 出问题的字符下标（从 0 开始）；范围类问题给起始位置 */
  index: number;
  /** 命中的原文片段 */
  snippet: string;
};

/** 中文语境里应该用全角的半角标点。 */
const HALF_WIDTH_MAP: Readonly<Record<string, string>> = {
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ':': '：',
  ';': '；',
};

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/** 成对符号。左半在 NO_LINE_END 里、右半在 NO_LINE_START 里，这里各列一份。 */
const PAIRS: ReadonlyArray<[string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
  ['〔', '〕'],
  ['《', '》'],
  ['“', '”'],
  ['‘', '’'],
  ['[', ']'],
  ['{', '}'],
];

export function checkText(text: string): TextIssue[] {
  const issues: TextIssue[] = [];
  if (!text) return issues;

  const chars = [...text];

  // 首尾空白：多半是从别处复制粘贴带进来的，在框里会影响居中。
  if (text !== text.trim()) {
    issues.push({
      code: 'TRIM_WHITESPACE',
      severity: 'warning',
      message: '译文首尾有多余空白，建议去掉',
      index: 0,
      snippet: text.slice(0, 8),
    });
  }

  // 连续空白
  const doubleSpace = text.match(/ {2,}|　{2,}/);
  if (doubleSpace?.index !== undefined) {
    issues.push({
      code: 'DOUBLE_SPACE',
      severity: 'warning',
      message: '出现连续空格',
      index: doubleSpace.index,
      snippet: doubleSpace[0],
    });
  }

  // 中文旁边的半角标点
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    const replacement = HALF_WIDTH_MAP[char];
    if (!replacement) continue;

    // `1,000` / `3.5` / `v1.2` 这类数字里的标点是正当的，跳过。
    const prev = chars[i - 1] ?? '';
    const next = chars[i + 1] ?? '';
    if (/\d/.test(prev) && /\d/.test(next)) continue;
    // 网址、英文缩写里的点也跳过：两侧都是拉丁字符时不报。
    if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) continue;

    // 只有紧邻中文时才提醒 —— 纯英文句子里的半角标点是正确的。
    if (CJK.test(prev) || CJK.test(next)) {
      issues.push({
        code: 'HALF_WIDTH_PUNCT',
        severity: 'warning',
        message: `中文里应使用全角「${replacement}」，而不是半角「${char}」`,
        index: i,
        snippet: `${prev}${char}${next}`,
      });
    }
  }

  // 省略号
  const dots = text.match(/\.{3,}|。{3,}/);
  if (dots?.index !== undefined) {
    issues.push({
      code: 'ELLIPSIS',
      severity: 'warning',
      message: '省略号建议写作「……」',
      index: dots.index,
      snippet: dots[0],
    });
  }

  // 波浪号：中文里规范写法是「～」。
  const tilde = text.match(/[~]/);
  if (tilde?.index !== undefined) {
    issues.push({
      code: 'TILDE',
      severity: 'warning',
      message: '中文里波浪号建议写作「～」',
      index: tilde.index,
      snippet: tilde[0],
    });
  }

  // 括号配对
  for (const [open, close] of PAIRS) {
    const opens = countOf(chars, open);
    const closes = countOf(chars, close);
    if (opens !== closes) {
      issues.push({
        code: 'UNBALANCED_PAIR',
        severity: 'error',
        message: `「${open}」与「${close}」数量不一致（${opens} 个 / ${closes} 个）`,
        index: chars.indexOf(opens > closes ? open : close),
        snippet: `${open}${close}`,
      });
    }
  }

  // 全角空格：中文排版里偶尔有用，但在对白框里通常是误敲。
  const ideographic = text.indexOf('　');
  if (ideographic >= 0) {
    issues.push({
      code: 'IDEOGRAPHIC_SPACE',
      severity: 'warning',
      message: '出现了全角空格',
      index: ideographic,
      snippet: '　',
    });
  }

  return issues;
}

function countOf(chars: readonly string[], target: string): number {
  let count = 0;
  for (const char of chars) if (char === target) count += 1;
  return count;
}

/** 有没有必须处理的错误（用来决定「能不能标记为已校对」）。 */
export function hasBlockingIssues(issues: readonly TextIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
