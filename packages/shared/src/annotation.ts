import { normalizeTextLayers, wrapText, wrapVertical, type Measure, type VerticalRun } from './typeset-layer.js';

/**
 * 标号（标注）模型。
 *
 * 三条约定，都是为了让「同一份数据在画布、导出、PS 脚本里表现一致」：
 *
 * 1. **位置一律归一化到 0–1**（相对图片宽高），字号也一样 —— 用
 *    `fontSizeRatio × 图片高度` 而不是绝对像素。这样同一份标号在
 *    520px 缩略图、2000px 预览图和原始大图上都落在同一个位置，
 *    换分辨率、换屏幕、换导出尺寸都不会错位。
 * 2. **宽度高度从框算，不从文字算**。文字排版是「往框里塞」，
 *    塞不下就缩字号、再塞不下就溢出（并如实标记 overflow）。
 * 3. **标号是点，不是框**。对齐彩翻的工作台形态：画面上只有「数字圆点 + 箭头」，
 *    没有矩形。坐标就是箭尖所指的那一点。`w/h` 仍然保留，但当前一律为 0 ——
 *    留着是为了迁移期能如实存下旧站的矩形/多边形标注，以及 M5 导出要按框排版。
 */

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 文字排版的基础字号约定：字号按相对图片高度的比例存储，而非绝对像素。 */
export const DEFAULT_FONT_SIZE_RATIO = 0.035;

/**
 * 框内 / 框外。
 *
 * 取自彩翻，但要注意它**不是几何判定** —— 不是「文字落在画面内还是画面外」，
 * 而是一个由**创建方式**决定的分类：左键点 = 框内、右键点 = 框外。
 *
 * 之所以要落成数据而不是渲染时再算：嵌字时这两类的处理方式不同，
 * 而且嵌字是离线在 PS 里做的，那边只能看到这份数据。
 */
export type PositionType = 'in' | 'out';

export const POSITION_TYPES: readonly PositionType[] = ['in', 'out'];

/** 文字对齐。竖排下 `left/right` 的含义是「靠列的上端/下端」。 */
export type TextAlign = 'left' | 'center' | 'right';

export type TextStyle = {
  /** 字号 ÷ 图片高度 */
  fontSizeRatio: number;
  /** 行高倍数 */
  lineHeight: number;
  /** 字距，单位是字号的比例 */
  letterSpacing: number;
  align: TextAlign;
  vertical: boolean;
  bold: boolean;
  italic: boolean;
  /** 文字色（#RRGGBB） */
  color: string;
  /** 描边色；空字符串表示不描边 */
  outlineColor: string;
  /** 描边宽度 ÷ 字号 */
  outlineWidth: number;
  /** 背景色；空字符串表示透明。以 `#RRGGBBAA` 形式携带透明度 */
  background: string;
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSizeRatio: DEFAULT_FONT_SIZE_RATIO,
  lineHeight: 1.2,
  letterSpacing: 0,
  align: 'center',
  vertical: false,
  bold: false,
  italic: false,
  color: '#000000',
  outlineColor: '',
  outlineWidth: 0,
  background: '',
};

export type Annotation = {
  id: string;
  /** 框内还是框外。决定标记的颜色，也是嵌字时的分类依据。 */
  positionType: PositionType;
  /** 归一化 x（标号坐标 = 箭尖所指的那一点） */
  x: number;
  /** 归一化 y */
  y: number;
  /**
   * 归一化宽高。**当前一律为 0** —— 标号是点。
   * 保留这两列只为两件事：迁移期如实存下旧站的矩形/多边形标注，
   * 以及 M5 导出时按框排版（见下面的 `annotationRect`）。
   */
  w: number;
  h: number;
  /** 多边形顶点（[[x,y],…]，归一化）。为 null 时用矩形。 */
  vertices: Array<[number, number]> | null;
  /** 同一段话被拆成多个框时归组 */
  groupId: string | null;
  /** 阅读顺序（画布上的显示序号） */
  orderIndex: number;
  /** 原文 */
  content: string;
  /** 给译者的备注（如「这句是双关」） */
  note: string;
  style: Partial<TextStyle>;
};

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * 取「有效矩形」。
 *
 * 标号是点、没有面积，但 M5 导出要按框排版，所以 w/h 为 0 时退化成
 * 「以点为中心、边长等于一个字号」的正方形 —— 一个既不至于空、也不会
 * 离谱地吞掉半页画面的默认框。
 *
 * ⚠️ **画布不再用这个函数做命中判定** —— 标记是固定屏幕尺寸的，
 * 判定必须在屏幕空间做，见 `marker.ts` 的 `hitTestMarker`。
 */
export function annotationRect(annotation: Annotation): Rect {
  if (annotation.w === 0 && annotation.h === 0) {
    const half = (annotation.style?.fontSizeRatio ?? DEFAULT_FONT_SIZE_RATIO) / 2;
    return { x: annotation.x - half, y: annotation.y - half, w: half * 2, h: half * 2 };
  }
  // 允许负宽高（旧数据里从右下往左上拖的框），这里统一成正的。
  return {
    x: annotation.w < 0 ? annotation.x + annotation.w : annotation.x,
    y: annotation.h < 0 ? annotation.y + annotation.h : annotation.y,
    w: Math.abs(annotation.w),
    h: Math.abs(annotation.h),
  };
}

// ── 排版 ────────────────────────────────────────────────────

export type LaidOutText = {
  /** 实际采用的字号（像素） */
  fontSizePx: number;
  /** 文字色等样式解析后的完整值 */
  style: TextStyle;
  /** 横向：每行的文字；纵向：每列的 runs */
  lines: string[];
  verticalColumns: VerticalRun[][];
  /** 文字实际占用高度（像素），用于垂直对齐 */
  usedHeightPx: number;
  /** 文字实际占用宽度（像素） */
  usedWidthPx: number;
  /** 缩到最小字号仍放不下 */
  overflow: boolean;
};

/**
 * 字号收缩的步长。每次缩 8%，是「缩得动但不会一次缩太狠」的经验值。
 */
const SHRINK_STEP = 0.92;

/**
 * 再小就没有可读性了，此时宁可报 `overflow` 也不继续缩 ——
 * 一个缩到 3px 的译文等同于丢字，让译者知道「这个框塞不下」比悄悄糊过去有用得多。
 */
const MIN_FONT_SIZE_PX = 6;

/**
 * 收缩次数的**推导**上限（而不是拍一个常数）。
 *
 * 早先写死 14 次，结果是从 40px 起缩只能到 12.5px，明明缩到 6px 就放得下，
 * 却被告知「塞不下」—— 这个 bug 是 shared-verify 的断言抓出来的。
 * 次数应当由「初始字号到最小字号需要几步」决定，这样无论起点多大都能试到下限。
 */
function shrinkStepsFor(fontSizePx: number): number {
  if (fontSizePx <= MIN_FONT_SIZE_PX) return 0;
  return Math.ceil(Math.log(MIN_FONT_SIZE_PX / fontSizePx) / Math.log(SHRINK_STEP)) + 1;
}

export function resolveStyle(style: Partial<TextStyle> | null | undefined): TextStyle {
  const [normalized] = normalizeTextLayers([{ ...style }]);
  return {
    ...DEFAULT_TEXT_STYLE,
    ...style,
    fontSizeRatio: normalized?.fontSizeRatio ?? DEFAULT_TEXT_STYLE.fontSizeRatio,
    lineHeight: normalized?.lineHeight ?? DEFAULT_TEXT_STYLE.lineHeight,
    letterSpacing: normalized?.letterSpacing ?? DEFAULT_TEXT_STYLE.letterSpacing,
    vertical: style?.vertical === true,
  };
}

export type LayoutInput = {
  text: string;
  /** 图片的像素尺寸 —— 归一化坐标换算成像素要靠它 */
  imageWidth: number;
  imageHeight: number;
  /** 框（归一化）。pin 会按字号退化成一个正方形。 */
  rect: Rect;
  style: Partial<TextStyle> | null | undefined;
  measure: Measure;
};

/**
 * 把文字排进一个框。
 *
 * 算法：按设定字号贪心断行，放不下就整体缩字号（每次 ×0.92），最多 14 次；
 * 再放不下就**如实标记 `overflow` 交给上层提示**，而不是继续缩到看不见 ——
 * 一个缩成 4px 的译文等同于丢字，让译者知道「这个框塞不下」比悄悄糊过去有用得多。
 *
 * `measure` 由平台提供：画布给 `ctx.measureText`，导出给同一套字体度量。
 * 同一个算法 + 同字体同字号，两边得到的换行就是一致的。
 */
export function layoutText(input: LayoutInput): LaidOutText {
  const { text, imageWidth, imageHeight, rect } = input;
  const style = resolveStyle(input.style);

  // 字距不体现在 measureText 的结果里（它是绘制阶段的概念），
  // 所以在这里把字距折算进宽度测量 —— 否则字距调大之后换行数不会变，
  // 画布上就会看到文字从框里冒出去。
  const measure: Measure = (value, size) => {
    const base = input.measure(value, size);
    const count = [...value].length;
    return count > 1 ? base + style.letterSpacing * size * (count - 1) : base;
  };

  const boxWidthPx = Math.max(1, rect.w * imageWidth);
  const boxHeightPx = Math.max(1, rect.h * imageHeight);

  let fontSizePx = style.fontSizeRatio * imageHeight;
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) fontSizePx = 16;

  const steps = shrinkStepsFor(fontSizePx);
  let last = tryLayout(text, boxWidthPx, boxHeightPx, style, measure, fontSizePx);

  for (let attempt = 0; attempt <= steps; attempt += 1) {
    if (last.fits) return { ...last.layout, overflow: false };
    // 最后一步钳到最小字号再试一次：要试过下限才能说「塞不下」。
    fontSizePx = Math.max(MIN_FONT_SIZE_PX, fontSizePx * SHRINK_STEP);
    last = tryLayout(text, boxWidthPx, boxHeightPx, style, measure, fontSizePx);
    if (fontSizePx <= MIN_FONT_SIZE_PX) break;
  }

  return { ...last.layout, overflow: !last.fits };
}

/** 便捷入口：直接从标号取框与样式。画布与导出都用这个，免得各写一遍换算。 */
export function layoutAnnotation(
  annotation: Annotation,
  text: string,
  imageWidth: number,
  imageHeight: number,
  measure: Measure,
): LaidOutText {
  return layoutText({
    text,
    imageWidth,
    imageHeight,
    rect: annotationRect(annotation),
    style: annotation.style,
    measure,
  });
}

function tryLayout(
  text: string,
  boxWidthPx: number,
  boxHeightPx: number,
  style: TextStyle,
  measure: Measure,
  fontSizePx: number,
): { fits: boolean; layout: Omit<LaidOutText, 'overflow'> } {
  if (style.vertical) {
    const columns = wrapVertical(text, boxHeightPx, fontSizePx * style.lineHeight);
    const usedHeightPx = Math.max(0, ...columns.map((c) => c.length)) * fontSizePx * style.lineHeight;
    const usedWidthPx = columns.length * fontSizePx * style.lineHeight;
    return {
      fits: usedHeightPx <= boxHeightPx + 0.5 && usedWidthPx <= boxWidthPx + 0.5,
      layout: { fontSizePx, style, lines: [], verticalColumns: columns, usedHeightPx, usedWidthPx },
    };
  }

  const lines = wrapText(text, boxWidthPx, fontSizePx, measure);
  const usedHeightPx = lines.length * fontSizePx * style.lineHeight;
  const usedWidthPx = Math.max(0, ...lines.map((line) => measure(line, fontSizePx)));

  return {
    fits: usedHeightPx <= boxHeightPx + 0.5 && usedWidthPx <= boxWidthPx + 0.5,
    layout: { fontSizePx, style, lines, verticalColumns: [], usedHeightPx, usedWidthPx },
  };
}
