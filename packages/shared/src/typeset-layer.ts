/**
 * 排版层：换行与竖排的**纯算法**。
 *
 * 这一层的存在理由只有一个：**前端画布看到的断行，必须与后端导出/PS 脚本得到的断行
 * 逐字相同**。漫画嵌字里「这一行结尾是不是把「」拆开了」是会被读者一眼看出来的，
 * 而如果画布和导出各写一套换行，两边一定会漂移 —— 而且是在用户已经在 PS 里排完版
 * 之后才发现。
 *
 * 因此这里**不做任何绘制**，只回答「给我一段文字和一个宽度，应该断成哪几行」。
 * 文字宽度的测量由平台提供（画布给 `ctx.measureText`，导出给同一套字体度量），
 * 算法本身与平台无关。
 */

// ── 禁则（避头尾）────────────────────────────────────────────
//
// 中文与日文的排版规范：某些字符不能顶在行首，某些不能落在行尾。
// 不做这件事的话，`「` 会孤零零留在上一行末尾、`。` 会跑到下一行开头，
// 在漫画对白框这种短行场景里格外刺眼。

/** 不能出现在**行首**的字符：收尾类标点、小假名、连着上一字的符号。 */
const NO_LINE_START = new Set(
  [...'、。，．,.!?！？；;：:）)』」】》〉〕｝］】’”ー〜～ぁぃぅぇぉっゃゅょゎゕゖ々ゝゞヽヾ・…—'],
);

/** 不能出现在**行尾**的字符：起头类标点。 */
const NO_LINE_END = new Set([...'（(『「【《〈〔｛［“‘']);

/**
 * 小假名与长音符：它们不能独立成行，也不能出现在行首
 * （已包含在 NO_LINE_START 里，这里单独列出来是为了「纵中横」判断时要区别对待）。
 */
const SMALL_KANA = new Set([...'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ']);

export function canStartLine(char: string): boolean {
  return !NO_LINE_START.has(char);
}

export function canEndLine(char: string): boolean {
  return !NO_LINE_END.has(char);
}

// ── 分词 ────────────────────────────────────────────────────
//
// 中文/日文没有词间空格，可以在任意字之间断行；拉丁文必须按词断。
// 所以先把字符串切成「原子」：每个 CJK 字符是一个原子，
// 连续的非 CJK 字符（英文、数字、连字符等）合成一个原子。

export type TextAtomKind = 'cjk' | 'latin' | 'space';

export type TextAtom = {
  text: string;
  kind: TextAtomKind;
  /** 这个原子之前是否允许断行 */
  breakBefore: boolean;
};

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xff00 && code <= 0xff60) || // 全角标点与字母
    (code >= 0xffe0 && code <= 0xffe6) ||
    code === 0x3000 || // 全角空格
    NO_LINE_START.has(String.fromCodePoint(code)) ||
    NO_LINE_END.has(String.fromCodePoint(code))
  );
}

/** 把文本切成排版原子。空白单独成原子，方便断行时把它吃掉。 */
export function atomize(text: string): TextAtom[] {
  const atoms: TextAtom[] = [];

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (char === '\n') {
      // 显式换行：用一个零宽标记表达，交给上层处理更麻烦，这里直接转成空格原子，
      // 由调用方先把文本按 \n 拆段。见 wrapText 的说明。
      continue;
    }

    const kind: TextAtomKind = char === ' ' || char === '\t' ? 'space' : isCjk(code) ? 'cjk' : 'latin';

    const prev = atoms[atoms.length - 1];
    if (kind === 'latin' && prev?.kind === 'latin') {
      prev.text += char;
      // 拉丁词内部不断行
      continue;
    }

    atoms.push({
      text: char,
      kind,
      // 拉丁词内不可断；其余位置都允许，禁则由 canStartLine/canEndLine 单独处理
      breakBefore: true,
    });
  }

  // 拉丁词的原子标记为「内部不可断」：把后继原子标成不可在它之前断行。
  for (let i = 0; i < atoms.length; i += 1) {
    const atom = atoms[i]!;
    if (atom.kind === 'latin') atom.breakBefore = i === 0 || atoms[i - 1]!.kind !== 'latin';
    if (atom.kind === 'space') atom.breakBefore = true;
  }

  return atoms;
}

/** 文字宽度测量函数。画布传 `ctx.measureText(...).width`，导出传同一套字体度量。 */
export type Measure = (text: string, fontSizePx: number) => number;

/**
 * 断行。
 *
 * 返回**不含行尾空白**的行数组。空行由调用方按 `\n` 自行拆分后再逐段调用，
 * 这样「段落」与「换行」两种换行语义不会混在一起。
 */
export function wrapText(text: string, maxWidth: number, fontSizePx: number, measure: Measure): string[] {
  if (!text) return [];
  if (maxWidth <= 0) return [text];

  const atoms = atomize(text);
  const lines: string[] = [];
  let start = 0;

  while (start < atoms.length) {
    // 新行不吃行首空白 —— 否则断行后会在行首看到一个空格。
    while (start < atoms.length && atoms[start]!.kind === 'space') start += 1;
    if (start >= atoms.length) break;

    // 先按宽度贪心地吃到吃不下为止。
    let end = start;
    let acc = '';
    while (end < atoms.length) {
      const candidate = acc + atoms[end]!.text;
      if (end > start && measure(candidate, fontSizePx) > maxWidth) break;
      acc = candidate;
      end += 1;
      // 单个原子就超宽（一长串英文）：让它独占一行，否则这里会死循环。
      if (measure(acc, fontSizePx) > maxWidth) break;
    }

    // ── 断点修正 ──
    // ① 落在拉丁词内部 → 退到词首，把整个词推到下一行。
    //    （只有词首原子带 breakBefore，所以这个循环天然会在词首停下。）
    //    注意 `end < atoms.length` 这个前提：end 走到末尾说明剩下的全部内容
    //    都排进了这一行，此时没有「下一个原子」可看，也不需要回退。
    while (end < atoms.length && end > start + 1 && !atoms[end]!.breakBefore) end -= 1;
    // ② 行尾不能是开括号/开引号 → 把它推下去（追い出し）。
    if (end - start > 1 && !canEndLine(atoms[end - 1]!.text.slice(-1))) end -= 1;
    // ③ 下一行行首不能是收尾标点 → 把它**吸进本行**（追い込み）。
    //    这一步会让本行略微超宽。这是刻意的：排版规范里「行尾吊一个句号」
    //    比「行首孤零零一个句号」好看得多，两害相权取其轻。
    while (end < atoms.length && end > start && !canStartLine(atoms[end]!.text[0]!)) {
      end += 1;
    }

    lines.push(
      atoms
        .slice(start, end)
        .map((a) => a.text)
        .join('')
        .replace(/[\s　]+$/, ''),
    );

    // 至少前进一个原子，保证循环收敛。
    start = Math.max(end, start + 1);
  }

  return lines;
}

// ── 竖排 ────────────────────────────────────────────────────
//
// 竖排列从右往左排，每列从上往下读。拉丁字母与数字在竖排里的处理叫
// **纵中横**：短的（≤ 4 个字符）整体旋转 90° 躺在一格里，长的则逐字竖排。
// 这是漫画嵌字里区分「像不像人排的」的一个关键细节。

export type VerticalRunKind = 'upright' | 'tateChuYoko';

export type VerticalRun = {
  text: string;
  kind: VerticalRunKind;
};

/** 纵中横的字符数上限。超过就逐字竖排，否则一格里塞不下。 */
export const TATE_CHU_YOKO_MAX = 4;

/**
 * 把文本切成竖排的「格」：CJK 与标点逐字（upright），
 * 短的拉丁/数字串合并成一格并整体旋转（tateChuYoko）。
 */
export function groupVerticalRuns(text: string): VerticalRun[] {
  const runs: VerticalRun[] = [];
  let latin = '';

  const flushLatin = () => {
    if (!latin) return;
    if (latin.length <= TATE_CHU_YOKO_MAX) {
      runs.push({ text: latin, kind: 'tateChuYoko' });
    } else {
      // 太长：逐字符竖排，读者需要歪头看 —— 但总比挤成一团好。
      for (const char of latin) runs.push({ text: char, kind: 'upright' });
    }
    latin = '';
  };

  for (const char of text) {
    if (char === '\n') {
      flushLatin();
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (char === ' ') {
      flushLatin();
      runs.push({ text: ' ', kind: 'upright' });
      continue;
    }
    if (isCjk(code) || SMALL_KANA.has(char)) {
      flushLatin();
      runs.push({ text: char, kind: 'upright' });
    } else {
      latin += char;
    }
  }
  flushLatin();

  return runs;
}

/**
 * 竖排断列。列的**高度**是约束，从第一列开始往下塞，塞不下就换到左边一列。
 * 返回的列按**阅读顺序**（第一个元素是最右列）排列。
 */
export function wrapVertical(text: string, maxHeight: number, fontSizePx: number): VerticalRun[][] {
  const runs = groupVerticalRuns(text);
  if (runs.length === 0) return [];
  if (maxHeight <= 0) return [runs];

  const perColumn = Math.max(1, Math.floor(maxHeight / fontSizePx));
  const columns: VerticalRun[][] = [];

  // 数组按**阅读顺序**排：columns[0] 是最右列。
  for (let i = 0; i < runs.length; i += perColumn) {
    columns.push(runs.slice(i, i + perColumn));
  }

  // 禁则：收尾标点不能出现在列首 → 挪到**前一列的末尾**（同样是追い込み，
  // 宁可让前一列长一个字，也不要让标点孤零零挂在列首）。
  for (let c = 1; c < columns.length; c += 1) {
    const column = columns[c]!;
    const previous = columns[c - 1]!;
    while (column.length > 1 && !canStartLine(column[0]!.text[0]!)) {
      previous.push(column.shift()!);
    }
  }

  return columns;
}

// ── 文本图层规范化 ──────────────────────────────────────────

export type TextLayerLike = {
  text?: string;
  vertical?: boolean;
  fontSizeRatio?: number;
  lineHeight?: number;
  letterSpacing?: number;
  [key: string]: unknown;
};

export type NormalizedTextLayer = {
  text: string;
  vertical: boolean;
  fontSizeRatio: number;
  lineHeight: number;
  letterSpacing: number;
};

/**
 * 补齐默认值并夹紧数值。
 *
 * 导出的边界上要用它：从数据库读出来的样式是 jsonb，可能是任何形状
 * （手工改过、旧版本写的、迁移带过来的）。导出前不过一遍，
 * `fontSizeRatio: "0.05"`（字符串）这类值会让整张图排成一行或直接 NaN。
 */
export function normalizeTextLayers<T extends TextLayerLike>(layers: readonly T[]): Array<T & NormalizedTextLayer> {
  return layers.map((layer) => ({
    ...layer,
    text: typeof layer.text === 'string' ? layer.text : '',
    vertical: layer.vertical === true,
    fontSizeRatio: clampNumber(layer.fontSizeRatio, 0.035, 0.004, 0.6),
    lineHeight: clampNumber(layer.lineHeight, 1.2, 0.6, 4),
    letterSpacing: clampNumber(layer.letterSpacing, 0, -0.5, 2),
  }));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
