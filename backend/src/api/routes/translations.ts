import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, type DbLike } from '../../db/client.js';
import { files, projects, sources, targets, translations, users } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission } from '../../domain/authorize.js';
import { translationCompleteness } from '../../domain/file-state.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { loadAccessibleFile, parseOrThrow } from '../file-access.js';
import { clientIp, requireAuth } from '../guards.js';
import { listSources } from './sources.js';

/**
 * 译文与校对。
 *
 * 数据模型的关键点：**一个标号对一种语言可以有多份候选译文**（每人一份），
 * 另有「选中」与「校对」两个状态。参考实现就是这个语义，必须保留 ——
 * 同一句话经常有人给出不同译法，压平成「一标号一行」会直接丢数据。
 *
 * 界面上的摩擦点则要尽量少，所以有两条自动规则：
 *  1. 保存译文时，如果这个 (标号, 语言) 还**没有**选中的译文，就把刚存的这份设为选中 ——
 *     单人翻译的作品因此完全不用关心「选中」这个概念；
 *  2. 校对写进 `proofread_content` 而**不覆盖** `content`，
 *     译者的原稿始终留着，校对前后可以直接对照。
 */

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const translationParam = z.object({ translationId: z.string().uuid('译文 ID 不合法') });
const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });

const saveTranslationsSchema = z.object({
  targetId: z.string().uuid('目标语言 ID 不合法'),
  items: z
    .array(
      z.object({
        sourceId: z.string().uuid('标号 ID 不合法'),
        content: z.string().max(4000),
      }),
    )
    .max(500),
});

const saveProofreadsSchema = z.object({
  targetId: z.string().uuid('目标语言 ID 不合法'),
  items: z
    .array(
      z.object({
        sourceId: z.string().uuid('标号 ID 不合法'),
        /** 校对后的文本。传空串表示「撤销校对」 */
        proofreadContent: z.string().max(4000),
        /** 指定要校对哪一份候选；不传则用当前选中的那份 */
        translationId: z.string().uuid().optional(),
      }),
    )
    .max(500),
});

export async function registerTranslationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 翻校工作台的**主数据加载**：一次把「这张图的标号 + 指定语言的全部译文候选」
   * 拿全。拆成多个请求的话，画布会在几个请求之间出现「标号有了但译文还没到」
   * 的中间态，而那种闪动在频繁翻页时非常烦人。
   */
  app.get('/files/:id/translations', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user);

    const query = parseOrThrow(
      z.object({ targetId: z.string().uuid().optional() }),
      request.query,
    );

    const targetList = await db
      .select()
      .from(targets)
      .where(eq(targets.projectId, file.projectId))
      .orderBy(asc(targets.orderIndex), asc(targets.label));

    const targetId = query.targetId ?? targetList[0]?.id ?? null;
    if (query.targetId && !targetList.some((t) => t.id === query.targetId)) {
      throw badRequest('目标语言不属于该作品', 'TARGET_NOT_FOUND');
    }

    const sourceList = await listSources(fileId);
    const bySource = targetId
      ? await translationsOfSources(
          sourceList.map((s) => s.id),
          targetId,
        )
      : new Map<string, TranslationView[]>();

    return {
      file: {
        id: file.id,
        name: file.name,
        width: file.width,
        height: file.height,
        state: file.state,
        projectId: file.projectId,
      },
      targets: targetList.map((t) => ({ id: t.id, language: t.language, label: t.label })),
      targetId,
      sources: sourceList.map((source) => {
        const list = bySource.get(source.id) ?? [];
        return {
          ...source,
          translations: list,
          selected: list.find((t) => t.isSelected) ?? null,
          mine: list.find((t) => t.userId === user.id) ?? null,
        };
      }),
      completeness: await translationCompleteness(fileId),
      my: {
        canTranslate: access.permissions.has('tra.add'),
        canProofread: access.permissions.has('tra.proofread'),
        canCheck: access.permissions.has('tra.check'),
      },
    };
  });

  /**
   * 保存译文（我的那一份候选）。
   *
   * 需要注意的语义：这是**按人分份**的保存 —— A 存了不会覆盖 B 的候选。
   * 这既是多候选模型的要求，也顺带解决了「两个人同时改同一句」的冲突：
   * 各存各的，最后由有审核权的人挑一份。
   */
  app.put('/files/:id/translations', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user, 'tra.add');

    const body = parseOrThrow(saveTranslationsSchema, request.body);
    await assertTargetBelongsToProject(body.targetId, file.projectId);

    const validSourceIds = await sourceIdsOf(fileId);
    const invalid = body.items.find((item) => !validSourceIds.has(item.sourceId));
    if (invalid) throw badRequest('有标号不属于这张图片', 'SOURCE_NOT_FOUND');

    const now = new Date();

    await db.transaction(async (tx) => {
      for (const item of body.items) {
        const existing = await tx
          .select({ id: translations.id })
          .from(translations)
          .where(
            and(
              eq(translations.sourceId, item.sourceId),
              eq(translations.targetId, body.targetId),
              eq(translations.userId, user.id),
            ),
          )
          .limit(1);

        if (existing[0]) {
          await tx
            .update(translations)
            .set({ content: item.content, updatedAt: now })
            .where(eq(translations.id, existing[0].id));
        } else {
          const inserted = await tx
            .insert(translations)
            .values({
              sourceId: item.sourceId,
              targetId: body.targetId,
              userId: user.id,
              content: item.content,
            })
            .returning({ id: translations.id });

          // 没有人选中过就自动选中刚存的这份。单人翻译的作品因此
          // 完全不需要理解「候选」「选中」这两个概念。
          if (inserted[0] && !(await hasSelected(tx, item.sourceId, body.targetId))) {
            await tx
              .update(translations)
              .set({ isSelected: true })
              .where(eq(translations.id, inserted[0].id));
          }
        }
      }

      await tx.update(files).set({ updatedAt: now }).where(eq(files.id, fileId));
      await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, file.projectId));
    });

    const saved = body.items.filter((i) => i.content.trim().length > 0).length;
    if (saved > 0) {
      await logOp({
        actorId: user.id,
        teamId: access.project.teamId,
        action: 'tra.save',
        targetType: 'file',
        targetId: fileId,
        targetName: file.name,
        detail: { count: saved, targetId: body.targetId },
        ip: clientIp(request),
      });
    }

    return {
      translations: await translationsOfSources([...validSourceIds], body.targetId),
      completeness: await translationCompleteness(fileId),
    };
  });

  /**
   * 保存校对。
   *
   * 写进 `proofread_content` 而**不覆盖** `content`：译者的原稿要留着，
   * 校对前后能直接对照，也是「这句话被改了什么」的唯一依据。
   * 传空串表示撤销校对（校对时误判了、或者发现还是原来那句对）。
   */
  app.put('/files/:id/proofreads', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user, 'tra.proofread');

    const body = parseOrThrow(saveProofreadsSchema, request.body);
    await assertTargetBelongsToProject(body.targetId, file.projectId);

    const validSourceIds = await sourceIdsOf(fileId);
    const invalid = body.items.find((item) => !validSourceIds.has(item.sourceId));
    if (invalid) throw badRequest('有标号不属于这张图片', 'SOURCE_NOT_FOUND');

    const now = new Date();

    await db.transaction(async (tx) => {
      for (const item of body.items) {
        // 没指定就校对「当前选中的那一份」—— 那才是最终会进成品的文本。
        const target = item.translationId
          ? await tx
              .select({ id: translations.id })
              .from(translations)
              .where(
                and(
                  eq(translations.id, item.translationId),
                  eq(translations.sourceId, item.sourceId),
                  eq(translations.targetId, body.targetId),
                ),
              )
              .limit(1)
          : await tx
              .select({ id: translations.id })
              .from(translations)
              .where(
                and(
                  eq(translations.sourceId, item.sourceId),
                  eq(translations.targetId, body.targetId),
                  eq(translations.isSelected, true),
                ),
              )
              .limit(1);

        const row = target[0];
        // 还没有译文就没有可校对的对象。**静默跳过而不是报错**：
        // 校对页整页提交时，未翻译的标号本来就会被一起提交上来。
        if (!row) continue;

        await tx
          .update(translations)
          .set({
            proofreadContent: item.proofreadContent,
            proofreaderId: item.proofreadContent.trim() ? user.id : null,
            proofreadAt: item.proofreadContent.trim() ? now : null,
            updatedAt: now,
          })
          .where(eq(translations.id, row.id));
      }

      await tx.update(projects).set({ updatedAt: now }).where(eq(projects.id, file.projectId));
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'tra.proofread',
      targetType: 'file',
      targetId: fileId,
      targetName: file.name,
      detail: { count: body.items.length, targetId: body.targetId },
      ip: clientIp(request),
    });

    return {
      translations: await translationsOfSources([...validSourceIds], body.targetId),
      completeness: await translationCompleteness(fileId),
    };
  });

  /**
   * 选为最终译文。多候选时由有审核权的人挑一份。
   *
   * 这是一个**编辑决策**而不是录入动作，所以要求 `tra.check`：
   * 让译者自己挑「我更喜欢哪一版」，多候选就失去了意义。
   */
  app.post('/translations/:translationId/select', async (request) => {
    const user = await requireAuth(request);
    const { translationId } = translationParam.parse(request.params);

    const rows = await db
      .select({
        translation: translations,
        projectId: files.projectId,
        fileId: files.id,
        fileName: files.name,
      })
      .from(translations)
      .innerJoin(sources, eq(sources.id, translations.sourceId))
      .innerJoin(files, eq(files.id, sources.fileId))
      .where(eq(translations.id, translationId))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('译文不存在', 'TRANSLATION_NOT_FOUND');

    const access = await requireProjectAccess(row.projectId, user);
    requireProjectPermission(access, 'tra.check');

    await db.transaction(async (tx) => {
      // 先清掉同组里原来的选中项再设新的。顺序不能反 ——
      // 部分唯一索引会在「两个都选中」的那一瞬间报错。
      await tx
        .update(translations)
        .set({ isSelected: false })
        .where(
          and(
            eq(translations.sourceId, row.translation.sourceId),
            eq(translations.targetId, row.translation.targetId),
          ),
        );

      await tx
        .update(translations)
        .set({ isSelected: true, updatedAt: new Date() })
        .where(eq(translations.id, translationId));
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'tra.select',
      targetType: 'file',
      targetId: row.fileId,
      targetName: row.fileName,
      detail: { translationId },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.delete('/translations/:translationId', async (request) => {
    const user = await requireAuth(request);
    const { translationId } = translationParam.parse(request.params);

    const rows = await db
      .select({
        translation: translations,
        projectId: files.projectId,
        fileId: files.id,
        fileName: files.name,
      })
      .from(translations)
      .innerJoin(sources, eq(sources.id, translations.sourceId))
      .innerJoin(files, eq(files.id, sources.fileId))
      .where(eq(translations.id, translationId))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('译文不存在', 'TRANSLATION_NOT_FOUND');

    const access = await requireProjectAccess(row.projectId, user);
    // 删自己的候选只需录入权；删别人的需要有 tra.delete。
    if (row.translation.userId !== user.id) {
      requireProjectPermission(access, 'tra.delete');
    } else {
      requireProjectPermission(access, 'tra.add');
    }

    await db.delete(translations).where(eq(translations.id, translationId));

    return { ok: true };
  });

  /**
   * 作品级的翻译进度（文件列表上每张图显示「12/20 已翻」）。
   *
   * 单独一个接口而不是塞进文件列表：文件列表在翻页时会反复调用，
   * 而进度统计要扫全部标号与译文 —— 分开可以让文件列表保持轻。
   */
  app.get('/projects/:id/translation-stats', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = projectParam.parse(request.params);
    await requireProjectAccess(projectId, user);

    const query = parseOrThrow(z.object({ targetId: z.string().uuid().optional() }), request.query);

    const targetList = await db
      .select()
      .from(targets)
      .where(eq(targets.projectId, projectId))
      .orderBy(asc(targets.orderIndex), asc(targets.label));

    const targetId = query.targetId ?? targetList[0]?.id ?? null;
    if (!targetId) return { targets: [], targetId: null, files: {} };

    // 一次 GROUP BY 拿到「每个文件的标号数 / 已选译文数 / 已校对字数」。
    // 不做成「每个文件一次查询」—— 一个作品几百张图就是几百次往返。
    const rows = await db
      .select({
        fileId: files.id,
        sourceCount: sql<number>`COUNT(DISTINCT ${sources.id}) FILTER (WHERE trim(${sources.content}) <> '')`,
        translatedCount: sql<number>`COUNT(DISTINCT ${sources.id}) FILTER (WHERE trim(${sources.content}) <> '' AND ${translations.isSelected} AND trim(${translations.content}) <> '')`,
        proofreadCount: sql<number>`COUNT(DISTINCT ${sources.id}) FILTER (WHERE trim(${sources.content}) <> '' AND trim(${translations.proofreadContent}) <> '')`,
      })
      .from(files)
      .leftJoin(sources, eq(sources.fileId, files.id))
      .leftJoin(
        translations,
        and(eq(translations.sourceId, sources.id), eq(translations.targetId, targetId)),
      )
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt)))
      .groupBy(files.id);

    const map: Record<string, { sources: number; translated: number; proofread: number }> = {};
    for (const row of rows) {
      map[row.fileId] = {
        sources: Number(row.sourceCount ?? 0),
        translated: Number(row.translatedCount ?? 0),
        proofread: Number(row.proofreadCount ?? 0),
      };
    }

    return {
      targets: targetList.map((t) => ({ id: t.id, language: t.language, label: t.label })),
      targetId,
      files: map,
    };
  });
}

// ── 内部工具 ────────────────────────────────────────────────

export type TranslationView = {
  id: string;
  userId: string | null;
  displayName: string;
  content: string;
  proofreadContent: string;
  proofreaderId: string | null;
  proofreadAt: string | null;
  isSelected: boolean;
  machineTranslated: boolean;
  updatedAt: string;
};

/** 取一批标号在某个目标语言下的全部候选译文。 */
export async function translationsOfSources(
  sourceIds: readonly string[],
  targetId: string,
  tx: DbLike = db,
): Promise<Map<string, TranslationView[]>> {
  const result = new Map<string, TranslationView[]>();
  if (sourceIds.length === 0) return result;

  const rows = await tx
    .select({
      id: translations.id,
      sourceId: translations.sourceId,
      userId: translations.userId,
      displayName: users.displayName,
      content: translations.content,
      proofreadContent: translations.proofreadContent,
      proofreaderId: translations.proofreaderId,
      proofreadAt: translations.proofreadAt,
      isSelected: translations.isSelected,
      machineTranslated: translations.machineTranslated,
      updatedAt: translations.updatedAt,
    })
    .from(translations)
    .leftJoin(users, eq(users.id, translations.userId))
    .where(and(inArray(translations.sourceId, [...sourceIds]), eq(translations.targetId, targetId)))
    .orderBy(asc(translations.createdAt));

  for (const row of rows) {
    const list = result.get(row.sourceId) ?? [];
    list.push({
      id: row.id,
      userId: row.userId,
      displayName: row.displayName ?? '已注销用户',
      content: row.content,
      proofreadContent: row.proofreadContent,
      proofreaderId: row.proofreaderId,
      proofreadAt: row.proofreadAt ? row.proofreadAt.toISOString() : null,
      isSelected: row.isSelected,
      machineTranslated: row.machineTranslated,
      updatedAt: row.updatedAt.toISOString(),
    });
    result.set(row.sourceId, list);
  }

  return result;
}

async function hasSelected(tx: DbLike, sourceId: string, targetId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: translations.id })
    .from(translations)
    .where(
      and(
        eq(translations.sourceId, sourceId),
        eq(translations.targetId, targetId),
        eq(translations.isSelected, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function sourceIdsOf(fileId: string): Promise<Set<string>> {
  const rows = await db.select({ id: sources.id }).from(sources).where(eq(sources.fileId, fileId));
  return new Set(rows.map((r) => r.id));
}

async function assertTargetBelongsToProject(targetId: string, projectId: string): Promise<void> {
  const rows = await db
    .select({ id: targets.id })
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.projectId, projectId)))
    .limit(1);
  if (rows.length === 0) throw badRequest('目标语言不属于该作品', 'TARGET_NOT_FOUND');
}

