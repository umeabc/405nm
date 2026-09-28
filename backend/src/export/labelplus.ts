import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { dedupeLpFilenames, serializeLabelPlus, type LpFile, type LpMarker } from '@405nm/shared';
import { db } from '../db/client.js';
import { files, projects, sources, targets, translations } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

/**
 * 把一个作品的标号与译文组装成 LabelPlus txt（供 PS 离线嵌字）。
 *
 * 序列化本身在 `@405nm/shared`（格式是与官方 PS 脚本对齐的，改之前先读那边的注释）。
 * 这里负责的是**取数与取舍**，其中三处判断值得说明：
 *
 * 1. **一条标号到底该嵌哪段字**：校对稿 → 选中的译文 → 原文兜底。
 *    校对稿优先是显然的。原文兜底则是刻意的：宁可让嵌字的人看到一段还没翻的日文，
 *    也不让这个标号从 txt 里凭空消失 —— 后者会表现为「画布上有 29 个标号、
 *    txt 里只有 24 个」，而且没有任何迹象说明少了哪几个。
 *    兜底了多少条会随导出结果一起返回，界面据此提示，所以它**不是静默的**。
 * 2. **注释块里不写导出时间**。同样的内容重导一次要得到同样的字节，
 *    嵌字的人才能拿两版 txt 直接 diff 出「这次改了什么」。
 * 3. **按 `activated` 过滤**，与 `domain/project-stats.ts` 的进度统计一致 ——
 *    修订链里被取代的版本不该出现在嵌字包里，否则同一页会有两张图。
 */

/** 一条标号最终落到了哪一类。用来决定要不要在界面上提醒「有没翻的」。 */
export type MarkerTextStats = {
  total: number;
  /** 有译文（校对稿或选中译文） */
  translated: number;
  /** 没译文，拿原文顶上了 */
  fallbackToSource: number;
  /** 译文与原文都空 */
  empty: number;
  /** 有校对稿的条数，用来判断这一版是否已经过校对 */
  proofread: number;
};

/**
 * 一个文件在导出包里的身份。
 *
 * ⚠️ `exportName` 与 `name` 分开是有原因的，**不是为了好看**：
 * txt 里的文件名会被清洗与去重（`a]b.jpg` → `a_b.jpg`，重名加 `_2`），
 * 而 zip 条目名如果直接用原始名，两边就对不上 —— 官方 PS 脚本是靠
 * **文件名**把标号认到图片上的，对不上的后果是「标号一个都嵌不上」，
 * 而且没有任何报错。打包时必须用同一份 `exportName`。
 */
export type ExportFileRef = {
  fileId: string;
  storageKey: string;
  /** 库里的原始名 */
  name: string;
  /** 清单与压缩包里统一使用的名字 */
  exportName: string;
};

export type LabelPlusBuild = {
  text: string;
  language: string;
  targetLabel: string;
  fileCount: number;
  markerStats: MarkerTextStats;
  /** 一个标号都没翻的文件名（原文兜底也算没翻）。界面据此提示 */
  filesWithoutTranslation: string[];
  /** 按导出顺序排列的文件，供打包复用同一批名字 */
  files: ExportFileRef[];
};

type TranslationRow = {
  sourceId: string;
  content: string;
  proofreadContent: string;
  isSelected: boolean;
};

/**
 * 挑出这一条标号该嵌的字。没有译文时返回空串（而不是 null）——
 * 调用方拿到的永远是字符串，少一层空值分支，也就少一处漏判。
 *
 * 顺序：**有校对稿的 → 被选中的 → 最后一份候选**。
 * 最后那步是为脏数据准备的兜底：正常情况下保存译文时会自动选中第一份
 * （见 routes/translations.ts），所以几乎不会走到。
 */
function pickTranslation(rows: TranslationRow[]): string {
  const proofed = rows.find((r) => r.proofreadContent.trim() !== '');
  if (proofed) return proofed.proofreadContent;

  const selected = rows.find((r) => r.isSelected);
  if (selected) return selected.content;

  const last = rows[rows.length - 1];
  return last ? last.content : '';
}

export async function buildProjectLabelPlus(projectId: string, targetId: string): Promise<LabelPlusBuild> {
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

  // 文件顺序 = 界面列表顺序 = 自然序。**必须与界面一致**：嵌字的人是对着
  // 画布核对序号的，两边顺序不同的话「第 3 个框」在两处指的是不同的框。
  const fileRows = await db
    .select({ id: files.id, name: files.name, storageKey: files.storageKey })
    .from(files)
    .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), eq(files.activated, true)))
    .orderBy(asc(files.sortName));

  if (fileRows.length === 0) {
    return {
      text: serializeLabelPlus({
        comment: [`作品：${projectName}`, `语言：${target.label}（${target.language}）`, '本作品还没有图片'],
        files: [],
      }),
      language: target.language,
      targetLabel: target.label,
      fileCount: 0,
      markerStats: { total: 0, translated: 0, fallbackToSource: 0, empty: 0, proofread: 0 },
      filesWithoutTranslation: [],
      files: [],
    };
  }

  // 导出名在这里算**一次**，txt 与压缩包共用同一份。
  // 让序列化函数自己再算一遍也可以（它是幂等的），但那样两边就有两次机会分叉，
  // 而分叉的后果是「PS 脚本一个标号都嵌不上且不报错」。算一次、传下去。
  const exportNames = dedupeLpFilenames(fileRows.map((f) => f.name));

  const fileIds = fileRows.map((f) => f.id);

  const sourceRows = await db
    .select({
      id: sources.id,
      fileId: sources.fileId,
      positionType: sources.positionType,
      x: sources.x,
      y: sources.y,
      content: sources.content,
    })
    .from(sources)
    // 与 routes/sources.ts 的排序一致：reading 顺序就是画布上的序号
    .orderBy(asc(sources.orderIndex), asc(sources.createdAt))
    .where(inArray(sources.fileId, fileIds));

  const translationRows: TranslationRow[] = sourceRows.length
    ? await db
        .select({
          sourceId: translations.sourceId,
          content: translations.content,
          proofreadContent: translations.proofreadContent,
          isSelected: translations.isSelected,
        })
        .from(translations)
        .where(
          and(
            inArray(
              translations.sourceId,
              sourceRows.map((s) => s.id),
            ),
            eq(translations.targetId, targetId),
          ),
        )
    : [];

  // 一次分组，避免每条标号都去数组里找一遍（一个作品几百条标号 × 每张图都扫）
  const bySource = new Map<string, TranslationRow[]>();
  for (const row of translationRows) {
    const list = bySource.get(row.sourceId);
    if (list) list.push(row);
    else bySource.set(row.sourceId, [row]);
  }

  const byFile = new Map<string, typeof sourceRows>();
  for (const row of sourceRows) {
    const list = byFile.get(row.fileId);
    if (list) list.push(row);
    else byFile.set(row.fileId, [row]);
  }

  const stats: MarkerTextStats = { total: 0, translated: 0, fallbackToSource: 0, empty: 0, proofread: 0 };
  const filesWithoutTranslation: string[] = [];
  const lpFiles: LpFile[] = [];
  const refs: ExportFileRef[] = [];

  fileRows.forEach((file, fileIndex) => {
    const rows = byFile.get(file.id) ?? [];
    let missing = 0;

    const markers: LpMarker[] = rows.map((source, i) => {
      const candidates = bySource.get(source.id) ?? [];
      const picked = pickTranslation(candidates);
      const hasTranslation = picked.trim() !== '';
      // 原文兜底。见文件头注释：宁可露出没翻的原文，也不让标号凭空消失。
      const text = hasTranslation ? picked : source.content;

      stats.total += 1;
      if (hasTranslation) {
        stats.translated += 1;
        if (candidates.some((c) => c.proofreadContent.trim() !== '')) stats.proofread += 1;
      } else if (source.content.trim() !== '') {
        stats.fallbackToSource += 1;
        missing += 1;
      } else {
        stats.empty += 1;
        missing += 1;
      }

      return {
        index: i + 1,
        x: source.x,
        y: source.y,
        // 组号由 positionType 决定，这里不编造 groupId
        positionType: source.positionType === 'out' ? 'out' : 'in',
        text,
      };
    });

    if (missing > 0) filesWithoutTranslation.push(exportNames[fileIndex]!);
    refs.push({
      fileId: file.id,
      storageKey: file.storageKey,
      name: file.name,
      exportName: exportNames[fileIndex]!,
    });
    lpFiles.push({ filename: exportNames[fileIndex]!, markers });
  });

  const text = serializeLabelPlus({
    comment: [
      `作品：${projectName}`,
      `语言：${target.label}（${target.language}）`,
      `共 ${fileRows.length} 张图、${stats.total} 个标号；其中 ${stats.translated} 条有译文。`,
      '用法：把本文件与图片放在同一目录，在 Photoshop 里运行 LabelPlus 的 PS 脚本。',
    ],
    files: lpFiles,
  });

  return {
    text,
    language: target.language,
    targetLabel: target.label,
    fileCount: fileRows.length,
    markerStats: stats,
    filesWithoutTranslation,
    files: refs,
  };
}
