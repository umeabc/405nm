import { clamp01, type PositionType } from './annotation.js';

/**
 * LabelPlus txt 的序列化与解析。
 *
 * 这个格式没有正式规范，**唯一的权威是消费它的那两个东西**：LabelPlus 本体，
 * 以及官方 PS 脚本（`LabelPlus/PS-Script` 的 text_parser）。所以下面每一处
 * 看起来「随便定的」细节，都是从官方解析器反推出来的，改动前请先读注释。
 *
 * 官方 `judgeLineType()` 的判定是**前缀匹配 + 正则**：
 *   - 文件头：前 6 个字符是 `>`（`>>>>>>[名]<<<<<<`），且结尾有 `]<{6,}`
 *   - 标号头：前 6 个字符是 `-`，且形如 `…-[序号]-{6,}[x,y,组号]`
 * 所以 `>`、`<`、`-` 的**数量下限是 6**。这里统一用 6（与上游导出路由一致），
 * 不是 8 也不是 16 —— 能过官方校验，且不与「用更多横线表意」产生歧义。
 *
 * 组名与别的字段由 `readStartBlocks()` 解析：它把「第一个文件头之前的全部内容」
 * 按 `-` 切开，`blocks[0]` 是版本（逗号分隔两个数）、`blocks[1]` 是组名（每行一个）、
 * 最后一块是注释。**因此组名之间绝不能出现 `-` 字符**，否则组会被切碎、
 * 组号整体错位（表现为「译文全都串到别的组」）。
 */

/** 版本行。官方解析器把它当两个数字读（首版、末版），不使用其值。 */
export const LP_VERSION = '1.0,1.0';

/**
 * 分组名。**顺序即组号**（1-based）。
 *
 * 405nm 只有两个分组，正好对上「框内 / 框外」——这不是巧合：
 * 彩翻的 `position_type` 本来就是这个分类，LabelPlus 的分组也是这个分类。
 */
export const LABELPLUS_GROUPS = ['框内', '框外'] as const;

/** 框内 → 组 1，框外 → 组 2。 */
export function groupIdOfPosition(positionType: PositionType): number {
  return positionType === 'out' ? 2 : 1;
}

/**
 * 组号 → 框内/框外。
 *
 * 只有两组是 405nm 的模型上限；别人手改过的 txt 里可能出现 3 号及以后的组，
 * 那些一律按「框内」处理 —— 组号本身仍会原样保留在解析结果里（见 `LpMarker.groupId`），
 * 这样重新导出时不会把人家自定义的分组悄悄抹平。
 */
export function positionTypeOfGroup(groupId: number): PositionType {
  return groupId === 2 ? 'out' : 'in';
}

export type LpMarker = {
  /** 图内从 1 递增的序号（导出时重排，解析时读原文） */
  index: number;
  /** 归一化坐标 —— 标号是点，就是箭尖那一点 */
  x: number;
  y: number;
  /** 框内 / 框外。**导出时的组号由它决定**，没别的地方能改 */
  positionType: PositionType;
  /**
   * 原文里的组号，只有**解析**时才填。手改过的文件可能有 1~9。
   * 导出**不看这个字段** —— 组号一律由 `positionType` 重新决定，
   * 于是它不必被调用方编一个值出来。
   */
  groupId?: number;
  /** 要嵌的字。多行用 \n */
  text: string;
};

export type LpFile = { filename: string; markers: LpMarker[] };

export type LpDocument = { groups: string[]; files: LpFile[] };

/**
 * 出口文件名清洗。
 *
 * 这几个字符必须替掉，不是洁癖：文件名会被原样写进 `>>>>>>[名]<<<<<<`，
 * 而官方解析器用**正则**取标题；名字里混进 `]` 或 `<` 会让标题截断，
 * 后果是「这张图的标号被挂到别的图上」或者整段丢失。
 * 另外这些字符在 Windows 上本来也不允许出现在文件名里（嵌字用的是 Windows）。
 */
export function sanitizeLpFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|[\]]/g, '_')
    // 控制字符（含 \r\n\t）一起清掉，避免把一行拆成两行
    .replace(/[\u0000-\u001f]/g, '_')
    .trim();
  return cleaned || 'image';
}

/**
 * 把一组文件名去重成互不相同的。
 *
 * 重名必须处理：txt 是靠**文件名**把标号认到图片上的，两张图同名会让
 * 后一张的标号覆盖前一张（官方解析器用文件名当字典键）。
 */
export function dedupeLpFilenames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = sanitizeLpFilename(raw);
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    // 没有扩展名（或点在开头）时直接接后缀，别造出 `.png_2` 这种怪名字
    if (dot <= 0) return `${name}_${count + 1}`;
    return `${name.slice(0, dot)}_${count + 1}${name.slice(dot)}`;
  });
}

/**
 * 序列化成 LabelPlus txt。
 *
 * 逐字节的约定（都不该随手改）：
 *   - 行尾 **CRLF**、开头 **BOM** —— 嵌字在 Windows 的 PS 里做，
 *     少了 BOM 中文会被当成本地编码读，直接乱码。
 *   - 坐标 4 位小数、**归一化 0–1**。官方 PS 脚本会按「两个分量都 ≤1」
 *     判定这是归一化坐标再乘画布尺寸，所以绝不能混入像素值 ——
 *     一张 2000px 宽的图上像素坐标 800 会被当成越界值直接丢到画布外。
 *   - 译文**逐行写**，一行一段，不写转义。
 */
export function serializeLabelPlus(doc: { files: readonly LpFile[]; comment?: readonly string[] }): string {
  const lines: string[] = [LP_VERSION, '-'];

  const groups = [...LABELPLUS_GROUPS];
  for (const name of groups) lines.push(name.replace(/-/g, '／'));
  lines.push('-');

  // 注释块。官方解析器只把它当注释，但这个文件是要给人看、也会被存档的，
  // 所以带上「这是什么、从哪来」比留个占位符有用。
  for (const line of doc.comment ?? []) lines.push(line.replace(/\r?\n/g, ' '));
  lines.push('-');

  const filenames = dedupeLpFilenames(doc.files.map((f) => f.filename));

  doc.files.forEach((file, fileIndex) => {
    lines.push(`>>>>>>[${filenames[fileIndex]}]<<<<<<`);

    let index = 1;
    for (const marker of file.markers) {
      // 空文本的标号**照样导出**（保留序号与位置），只写一行空的译文。
      // 不能直接跳过：序号是在导出时重排的，一旦跳过就会与画布上显示的编号
      // 对不上，嵌字的人按序号去图上找会找到一个别的框。
      const x = clamp01(marker.x).toFixed(4);
      const y = clamp01(marker.y).toFixed(4);
      const groupId = groupIdOfPosition(marker.positionType);
      lines.push(`------[${index}]------[${x},${y},${groupId}]`);
      for (const line of marker.text.replace(/\r\n?/g, '\n').split('\n')) lines.push(line);
      index += 1;
    }
  });

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 官方解析器的前缀判定：文件头 `>`×6 起，标号头 `-`×6 起。 */
const FILE_HEAD_RE = /^>{6,}\[(.+?)]<{6,}\s*$/;
const LABEL_HEAD_RE = /^-{6,}\[(\d+)]-{6,}\[([0-9.]+),([0-9.]+),(\d+)]\s*$/;

/**
 * 解析 LabelPlus txt。
 *
 * 与官方的 `lpTextParser` 同构：先攒「第一个文件头之前」的起始块，
 * 再逐行判定 文件头 / 标号头 / 正文，正文累积到该标号上。
 * 差异只有一处 —— 官方把组名按 `\r` 切，这里按行切（因为我们会先把行尾统一掉），
 * 结果一致。
 *
 * 解析失败不抛错，返回**尽可能多的**内容：一个手工改坏的 txt 也应该能救回来一部分，
 * 而不是整个导不进来。
 */
export function parseLabelPlus(text: string): LpDocument {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');

  // ── 起始块：直到第一个文件头 ──────────────────────────────
  let cursor = 0;
  const startBlock: string[] = [];
  while (cursor < lines.length && !FILE_HEAD_RE.test(lines[cursor]!.trim())) {
    startBlock.push(lines[cursor]!);
    cursor += 1;
  }

  let groups: string[] = [];
  // 起始块按 `-` 切成「版本 / 组名 / 注释」。
  // 注意只在这里切一次，之后 body 里的 `-` 是标号头的一部分，不能再切。
  const blocks = startBlock.join('\n').split('-');
  if (blocks.length >= 2) {
    groups = (blocks[1] ?? '')
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  // ── 正文：文件头 / 标号头 / 文本 ──────────────────────────
  const files: LpFile[] = [];
  let current: LpFile | null = null;
  let marker: LpMarker | null = null;

  const flush = () => {
    if (current && marker) {
      // 官方也是 trim：标号头与下一段之间必然夹着换行
      current.markers.push({ ...marker, text: marker.text.replace(/\n+$/, '') });
      marker = null;
    }
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    const fileMatch = line.trim().match(FILE_HEAD_RE);
    if (fileMatch) {
      flush();
      current = { filename: fileMatch[1]!.trim(), markers: [] };
      files.push(current);
      continue;
    }

    const labelMatch = line.trim().match(LABEL_HEAD_RE);
    if (labelMatch && current) {
      flush();
      const groupId = Number(labelMatch[4]) || 1;
      marker = {
        index: Number(labelMatch[1]) || current.markers.length + 1,
        x: clamp01(Number(labelMatch[2])),
        y: clamp01(Number(labelMatch[3])),
        groupId,
        positionType: positionTypeOfGroup(groupId),
        text: '',
      };
      continue;
    }

    if (marker) marker.text += marker.text ? `\n${line}` : line;
  }
  flush();

  return { groups: groups.slice(0, 9), files };
}

/**
 * 拼出下载文件名。
 *
 * 带作品名与目标语言：嵌字的人手上同时开着好几个作品的 txt 是常态，
 * 全叫 `labelplus.txt` 的话下载目录里会堆成一团分不清哪个是哪个。
 */
export function labelPlusDownloadName(projectName: string, language: string): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
  return `${safe}_${language}.txt`;
}
