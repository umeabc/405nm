/**
 * 提案落库：标号与机翻候选。
 *
 * 两处都守着同一条底线 —— **只增、不改人的东西**：
 *  - 标号：只插入，绝不修改已有标号（人工点过的位置永远是权威）；
 *  - 译文：只写 `machineTranslated = true` 的候选行，**不选中、不动校对稿**。
 *    重跑同一条提案是「刷新那条机翻候选」，不会新增一行，也不会碰人工译文。
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { db } from '../db/client.js';
import { files, sources, translations } from '../db/schema.js';
import type { MarkerProposal } from './markers.js';

export async function applyMarkers(
  fileId: string,
  proposals: readonly MarkerProposal[],
  actorId: string,
  tx: DbLike = db,
): Promise<{ created: number }> {
  if (proposals.length === 0) return { created: 0 };

  const last = await tx
    .select({ max: sql<number>`COALESCE(MAX(${sources.orderIndex}), -1)` })
    .from(sources)
    .where(eq(sources.fileId, fileId));
  let next = Number(last[0]?.max ?? -1) + 1;

  const rows = proposals.map((p) => ({
    fileId,
    positionType: p.positionType,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    orderIndex: next++,
    content: p.text,
    createdBy: actorId,
  }));

  const inserted = await tx.insert(sources).values(rows).returning({ id: sources.id });
  await tx.update(files).set({ updatedAt: new Date() }).where(eq(files.id, fileId));
  return { created: inserted.length };
}

export type ApplyTranslationItem = { sourceId: string; translated: string };
export type TranslationSkip = { sourceId: string; reason: 'human' | 'selected' | 'not-in-file' | 'empty' };

export async function applyTranslations(
  input: {
    fileId: string;
    targetId: string;
    items: readonly ApplyTranslationItem[];
    actorId: string;
  },
  tx: DbLike = db,
): Promise<{ created: number; updated: number; skipped: TranslationSkip[] }> {
  const skipped: TranslationSkip[] = [];
  let created = 0;
  let updated = 0;
  if (input.items.length === 0) return { created, updated, skipped };

  // 只认属于这一页的标号：前端传来的 id 不该能写到别处去
  const owned = await tx.select({ id: sources.id }).from(sources).where(eq(sources.fileId, input.fileId));
  const ownedIds = new Set(owned.map((row) => row.id));

  const wanted = new Map<string, string>();
  for (const item of input.items) {
    const text = item.translated.trim();
    if (!ownedIds.has(item.sourceId)) {
      skipped.push({ sourceId: item.sourceId, reason: 'not-in-file' });
      continue;
    }
    if (!text) {
      skipped.push({ sourceId: item.sourceId, reason: 'empty' });
      continue;
    }
    wanted.set(item.sourceId, text);
  }
  if (wanted.size === 0) return { created, updated, skipped };

  const ids = [...wanted.keys()];
  const existing = await tx
    .select()
    .from(translations)
    .where(and(eq(translations.targetId, input.targetId), eq(translations.userId, input.actorId)))
    .orderBy(asc(translations.createdAt));
  const mine = new Map(existing.map((row) => [row.sourceId, row]));

  for (const [sourceId, text] of wanted) {
    const row = mine.get(sourceId);
    if (!row) {
      await tx.insert(translations).values({
        sourceId,
        targetId: input.targetId,
        userId: input.actorId,
        content: text,
        machineTranslated: true,
        isSelected: false,
      });
      created += 1;
      continue;
    }
    // 这一行是你自己写的 / 已经被选中了 / 已经有人校对过 —— 一律不动。
    // 判断依据是**行自己的状态**，不是「谁点的机翻」，所以换个人来跑也不会踩到别人的稿子。
    if (!row.machineTranslated) {
      skipped.push({ sourceId, reason: 'human' });
      continue;
    }
    if (row.isSelected) {
      skipped.push({ sourceId, reason: 'selected' });
      continue;
    }
    if (row.content === text) continue; // 一模一样，不必写
    await tx.update(translations).set({ content: text, updatedAt: new Date() }).where(eq(translations.id, row.id));
    updated += 1;
  }

  if (created || updated) {
    await tx.update(files).set({ updatedAt: new Date() }).where(eq(files.id, input.fileId));
  }
  return { created, updated, skipped };
}
