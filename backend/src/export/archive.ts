import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { dedupeLpFilenames } from '@405nm/shared';
import { db } from '../db/client.js';
import { files, outputs, projects, sources, targets } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { buildProjectLabelPlus } from './labelplus.js';
import type { ZipEntry } from './zip.js';

/**
 * 导出包。
 *
 * 两种包，对应嵌字流程的两端：
 *   - **工程包**：原图 + LabelPlus txt + 结构化 JSON。给嵌字的人开工用。
 *   - **成品包**：嵌完传回来的成品图。给发布用。
 *
 * 两者都按「一图一文件」组织，且**图片名与 txt 里的名字同源** ——
 * 这是整个离线流程唯一的硬约束（PS 脚本靠文件名认图）。
 */

export type ArchivePlan = {
  /** 下载文件名（含扩展名，未做 URL 编码） */
  filename: string;
  entries: ZipEntry[];
  fileCount: number;
  /**
   * 包**没能装上**的东西。不静默省略是本项目的既定态度：
   * 一个默默少了两页的成品包，等到发布时才被发现就太晚了。
   */
  missing: string[];
};

/** 磁盘上不会有、也不该有的字符，换成下划线。中文保留 —— 用户看得懂。 */
function safeName(raw: string): string {
  return raw.replace(/[\\/:*?"<>|]/g, '_').trim() || 'export';
}

const stemOf = (name: string): string => name.replace(/\.[^.]*$/, '') || name;
const extOf = (name: string, fallback: string): string => name.match(/\.[^.]{1,8}$/)?.[0] ?? fallback;

export async function buildProjectArchive(projectId: string, targetId: string): Promise<ArchivePlan> {
  const built = await buildProjectLabelPlus(projectId, targetId);

  const projectRows = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectName = projectRows[0]?.name ?? '未命名作品';

  const txtName = `${safeName(projectName)}_${built.language}.txt`;

  // 结构化清单：给「不想用 PS 脚本、想自己写工具处理」的人一条路，
  // 也顺带把样式带上 —— LabelPlus txt 装不下样式，而嵌字时要用。
  const sourceRows = built.files.length
    ? await db
        .select({
          fileId: sources.fileId,
          positionType: sources.positionType,
          x: sources.x,
          y: sources.y,
          w: sources.w,
          h: sources.h,
          content: sources.content,
          note: sources.note,
          style: sources.style,
        })
        .from(sources)
        .where(
          inArray(
            sources.fileId,
            built.files.map((f) => f.fileId),
          ),
        )
        .orderBy(asc(sources.orderIndex), asc(sources.createdAt))
    : [];

  const sourcesByFile = new Map<string, typeof sourceRows>();
  for (const row of sourceRows) {
    const list = sourcesByFile.get(row.fileId);
    if (list) list.push(row);
    else sourcesByFile.set(row.fileId, [row]);
  }

  const manifest = {
    project: projectName,
    language: built.language,
    targetLabel: built.targetLabel,
    markerStats: built.markerStats,
    files: built.files.map((ref) => ({
      name: ref.exportName,
      originalName: ref.name,
      markers: (sourcesByFile.get(ref.fileId) ?? []).map((s, i) => ({
        index: i + 1,
        positionType: s.positionType,
        x: s.x,
        y: s.y,
        // w/h 当前是 0（标号是点）。原样带上，未来按框排版时用得到。
        w: s.w,
        h: s.h,
        source: s.content,
        note: s.note,
        style: s.style,
      })),
    })),
  };

  const untranslated = built.markerStats.fallbackToSource + built.markerStats.empty;
  const readme = [
    `${projectName} —— 嵌字工程包（${built.targetLabel} / ${built.language}）`,
    '',
    '怎么用：',
    '1. 把本压缩包完整解开（图片与 txt 必须放在同一目录）。',
    '2. 在 Photoshop 里运行 LabelPlus 的 PS 脚本（见下）。',
    `3. 脚本会让你选 txt，选「${txtName}」。`,
    '4. 脚本按文件名把标号认到图片上，逐张生成文字图层并另存为 PSD。',
    '5. 完工后把成品图回传到 405nm（图片页的「回传成品」），然后标记为「已嵌字」。',
    '',
    '关于 PS 脚本：',
    '  本包**不附带** PS 脚本。请从 LabelPlus 项目获取官方的',
    '  LabelPlus_Ps_Script.jsx（LabelPlus 是独立项目，其脚本以 GPLv2 发布，',
    '  由你自行下载安装即可 —— 我们不代为分发）。',
    '  装好后：PS 菜单「文件 → 脚本 → 浏览」选中它，或直接拖进 Photoshop 窗口。',
    '',
    '包里有什么：',
    `  - 原图（${built.fileCount} 张）`,
    `  - ${txtName} —— LabelPlus 格式的标号与译文`,
    '  - manifest.json —— 同样的数据，结构化版本（含样式与原文）',
    '  - 本说明',
    '',
    '关于 txt 格式：',
    '  头部是 版本 / 组名 / 注释 三块，用单独一行的 `-` 分隔；',
    '  组名顺序即组号：1=框内、2=框外。',
    '  每张图一行 `>>>>>>[文件名]<<<<<<`，其下是各标号：',
    '  `------[序号]------[x,y,组号]`，紧接着一行或多行译文。',
    '  坐标是**归一化 0–1**（×图片宽高即为像素），保留 4 位小数。',
    '',
    untranslated > 0
      ? `⚠️ ${untranslated} 个标号还没有译文，txt 里填的是原文（原文也空的则是空行）。`
      : '全部标号都已有译文。',
    '',
  ].join('\r\n');

  return {
    filename: `${safeName(projectName)}_${built.language}_工程包.zip`,
    entries: [
      { name: txtName, data: Buffer.from(built.text, 'utf8') },
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
      { name: '说明.txt', data: Buffer.from(`\uFEFF${readme}`, 'utf8') },
      ...built.files.map((ref) => ({ name: ref.exportName, key: ref.storageKey })),
    ],
    fileCount: built.fileCount,
    missing: [],
  };
}

/**
 * 成品包。
 *
 * 只取每个文件在该语言下的**最新版本**（`version` 最大的那条）——
 * 表里刻意没有 `is_current` 列，最新即当前，理由见 schema 的注释。
 * 嵌字返工只要重新传一次就自然成为最新。
 */
export async function buildOutputsArchive(projectId: string, targetId: string): Promise<ArchivePlan> {
  const targetRows = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.projectId, projectId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) throw notFound('该作品下没有这个目标语言', 'TARGET_NOT_FOUND');

  const projectRows = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const projectName = projectRows[0]?.name ?? '未命名作品';

  const fileRows = await db
    .select({ id: files.id, name: files.name })
    .from(files)
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), eq(files.activated, true)))
    .orderBy(asc(files.sortName));

  if (fileRows.length === 0) throw notFound('这个作品还没有图片', 'NO_FILES');

  // 一条查询取回全部候选，再在内存里按文件取版本号最大的一条
  // —— 比每个文件查一次（N+1）省得多，也比拼 `ANY(ARRAY[...])` 干净。
  const outputRows = await db
    .select({
      fileId: outputs.fileId,
      storageKey: outputs.storageKey,
      name: outputs.name,
      version: outputs.version,
    })
    .from(outputs)
    .where(
      and(
        inArray(
          outputs.fileId,
          fileRows.map((f) => f.id),
        ),
        eq(outputs.language, target.language),
      ),
    )
    .orderBy(asc(outputs.fileId), desc(outputs.version));

  // orderBy 已按版本倒序，所以每个文件的**第一次出现**就是最新版
  const latest = new Map<string, { storageKey: string; name: string }>();
  for (const row of outputRows) {
    if (!latest.has(row.fileId)) {
      latest.set(row.fileId, { storageKey: row.storageKey, name: row.name });
    }
  }

  const missing: string[] = [];
  const packed: Array<{ fileId: string; rawName: string; storageKey: string }> = [];

  for (const file of fileRows) {
    const out = latest.get(file.id);
    if (!out) {
      missing.push(file.name);
      continue;
    }
    // 用原图的名干 + 成品自己的扩展名：成品常是 PS 导出的 png 而原图是 jpg，
    // 直接沿用原名会让扩展名说瞎话。名干一致，排版顺序就对得上号。
    packed.push({
      fileId: file.id,
      rawName: `${stemOf(file.name)}${extOf(out.name, '.png')}`,
      storageKey: out.storageKey,
    });
  }

  if (packed.length === 0) throw notFound('这个作品还没有回传成品', 'NO_OUTPUTS');

  // 名干相同时（001.jpg 与 001.png 各有一版）会撞名，交给共用的去重规则处理
  const names = dedupeLpFilenames(packed.map((p) => p.rawName));

  return {
    filename: `${safeName(projectName)}_${target.language}_成品包.zip`,
    entries: packed.map((p, i) => ({ name: names[i]!, key: p.storageKey })),
    fileCount: packed.length,
    missing,
  };
}

/**
 * 组装 Content-Disposition。
 *
 * 必须同时给 `filename`（ASCII 回退）与 `filename*`（RFC 5987 的 UTF-8），
 * 否则中文作品名到了浏览器里会变成乱码或被截断 —— 而这里的文件名
 * 恰恰几乎一定含中文。
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
