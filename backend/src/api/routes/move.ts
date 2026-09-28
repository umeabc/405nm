import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, type Tx } from '../../db/client.js';
import { files, projects, sources, targets, translations } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission } from '../../domain/authorize.js';
import { naturalSortKey } from '@405nm/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 图片跨作品移动。
 *
 * 这是「翻译/校对做到一半发现图片放错作品了」的补救动作，也是参考实现里
 * 最容易被做坏的一处。三件事必须同时做对：
 *
 * 1. **标号随图走**。标号（位置 + 原文）是图片的属性，跟着 `file_id` 走天然就对了 ——
 *    前提是移动的是文件行本身，而不是「在新作品里复制一份」。这里改的是
 *    `files.project_id`，标号、署名、状态流水全靠外键跟着走，一个字都不用搬。
 * 2. **译文按语言重映射**。译文挂在 `targets` 上，而 targets 是**作品级**的。
 *    A 作品的「简体中文」与 B 作品的「简体中文」是两个不同的 id，所以
 *    移动时必须把 `translations.target_id` 换成目标作品里**同语言**的那一条。
 *    目标作品没有这个语言时怎么办：补一条 target，而不是丢掉译文 —— 丢译文
 *    等于让译者白干，这是最容易犯又最难发现的错误（界面上只会显示「没翻译」）。
 * 3. **重复要整批拒绝**。目标作品里已经有这张图（同 md5）时，移动会造成
 *    同一作品内两份相同内容。参考实现是抛 8008；这里保持一致的语义，
 *    但错误信息里**列出是哪几张**，否则用户面对十几张图只能一张张试。
 */

const moveSchema = z.object({
  toProjectId: z.string().uuid('目标作品 ID 不合法'),
  fileIds: z.array(z.string().uuid()).min(1, '请选择要移动的图片').max(200),
});

export async function registerMoveRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 可以移动到的作品列表（同团队内的其他作品）。
   * 一并带上每个目标作品的目标语言，界面上可以先提示「目标作品没有简体中文，
   * 移动后会自动补上」——比移动完再告诉用户更友好。
   */
  app.get('/projects/:id/move-targets', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await requireProjectAccess(projectId, user);

    const rows = await db
      .select({
        id: projects.id,
        serial: projects.serial,
        name: projects.name,
        setId: projects.setId,
      })
      .from(projects)
      .where(
        and(
          eq(projects.teamId, access.project.teamId),
          ne(projects.id, projectId),
          eq(projects.status, 'active'),
        ),
      )
      .orderBy(asc(projects.serial));

    const ids = rows.map((r) => r.id);
    const targetRows = ids.length
      ? await db
          .select({ projectId: targets.projectId, language: targets.language, label: targets.label })
          .from(targets)
          .where(inArray(targets.projectId, ids))
      : [];

    const languagesByProject = new Map<string, Array<{ language: string; label: string }>>();
    for (const row of targetRows) {
      const list = languagesByProject.get(row.projectId) ?? [];
      list.push({ language: row.language, label: row.label });
      languagesByProject.set(row.projectId, list);
    }

    return {
      projects: rows.map((row) => ({
        ...row,
        targetLanguages: languagesByProject.get(row.id) ?? [],
      })),
    };
  });

  app.post('/projects/:id/files/move', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'file.move');

    const body = parseOrThrow(moveSchema, request.body);
    if (body.toProjectId === projectId) {
      throw badRequest('目标作品与当前作品相同', 'SAME_PROJECT');
    }

    const targetAccess = await requireProjectAccess(body.toProjectId, user);
    requireProjectPermission(targetAccess, 'file.add');

    // 团队的边界不能越过：移动只在同一个团队内进行。
    // 跨团队移动涉及「对方团队看不看得到我们的图」这种权限问题，
    // 不是这一版要做的事。
    if (targetAccess.project.teamId !== access.project.teamId) {
      throw badRequest('只能移动到同一团队下的作品', 'CROSS_TEAM_MOVE');
    }

    const movedFiles = await db
      .select()
      .from(files)
      .where(
        and(
          inArray(files.id, body.fileIds),
          eq(files.projectId, projectId),
          isNull(files.deletedAt),
        ),
      );

    if (movedFiles.length !== body.fileIds.length) {
      throw badRequest('部分图片不属于该作品或已被删除', 'FILE_SCOPE_MISMATCH');
    }

    // ── 重复检查：目标作品里已有相同内容就整批拒绝 ──
    const md5List = movedFiles.map((f) => f.md5).filter(Boolean);
    if (md5List.length > 0) {
      const conflicts = await db
        .select({ id: files.id, name: files.name, md5: files.md5 })
        .from(files)
        .where(
          and(
            eq(files.projectId, body.toProjectId),
            inArray(files.md5, md5List),
            isNull(files.deletedAt),
          ),
        );

      if (conflicts.length > 0) {
        const conflictMd5 = new Set(conflicts.map((c) => c.md5));
        const offenders = movedFiles.filter((f) => conflictMd5.has(f.md5));
        throw conflict(
          `目标作品中已存在相同内容的图片：${offenders.map((f) => f.name).join('、')}。请先删除目标作品中的重复图片，或取消勾选这几张。`,
          'DUPLICATE_IN_TARGET',
        );
      }
    }

    const result = await db.transaction(async (tx) => {
      const targetMap = await ensureTargetsFor(tx, body.toProjectId, projectId);

      // 译文重映射。必须在改 `files.project_id` **之前**做：
      // 之后再做的话，中间态就是「图在新作品、译文指向旧作品的 target」，
      // 而这个中间态一旦因异常中断，界面上表现为「译文全没了」。
      const remapped = await remapTranslations(tx, body.fileIds, targetMap);

      for (const file of movedFiles) {
        await tx
          .update(files)
          .set({
            projectId: body.toProjectId,
            // 排序键重算：目标作品里可能已有同名文件，保持显示顺序稳定
            sortName: naturalSortKey(file.name),
            updatedAt: new Date(),
          })
          .where(eq(files.id, file.id));
      }

      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
      await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, body.toProjectId));

      return { remapped, targetMap };
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.move',
      targetType: 'project',
      targetId: body.toProjectId,
      targetName: targetAccess.project.name,
      detail: {
        from: access.project.name,
        count: body.fileIds.length,
        names: movedFiles.map((f) => f.name).slice(0, 20),
        translationsRemapped: result.remapped,
      },
      ip: clientIp(request),
    });

    return {
      ok: true,
      moved: movedFiles.length,
      translationsRemapped: result.remapped,
      createdTargets: result.targetMap.created,
    };
  });
}

/**
 * 保证目标作品具备源作品的每一种目标语言。
 *
 * 缺哪个补哪个，而不是「缺了就丢掉那些语言的译文」——
 * 后者是静默的数据损失：译者明明做了，界面上却显示没做，
 * 而且是在「换了作品」这种看起来无关紧要的动作之后发生的。
 */
async function ensureTargetsFor(
  tx: Tx,
  toProjectId: string,
  fromProjectId: string,
): Promise<{ byLanguage: Map<string, string>; created: Array<{ language: string; label: string }> }> {
  const [fromTargets, toTargets] = await Promise.all([
    tx.select().from(targets).where(eq(targets.projectId, fromProjectId)),
    tx.select().from(targets).where(eq(targets.projectId, toProjectId)),
  ]);

  const byLanguage = new Map<string, string>(toTargets.map((t) => [t.language, t.id]));
  const created: Array<{ language: string; label: string }> = [];

  let order = toTargets.length;

  for (const target of fromTargets) {
    if (byLanguage.has(target.language)) continue;

    const inserted = await tx
      .insert(targets)
      .values({
        projectId: toProjectId,
        language: target.language,
        label: target.label,
        orderIndex: order,
      })
      // 并发移动时可能撞上唯一键，让后来的那次直接复用已插入的行。
      .onConflictDoNothing()
      .returning({ id: targets.id, language: targets.language, label: targets.label });

    if (inserted[0]) {
      byLanguage.set(inserted[0].language, inserted[0].id);
      created.push({ language: inserted[0].language, label: inserted[0].label });
      order += 1;
    } else {
      const existing = await tx
        .select({ id: targets.id })
        .from(targets)
        .where(and(eq(targets.projectId, toProjectId), eq(targets.language, target.language)))
        .limit(1);
      if (existing[0]) byLanguage.set(target.language, existing[0].id);
    }
  }

  return { byLanguage, created };
}

/**
 * 把待移动图片的译文指向目标作品的语言。
 *
 * 同语言目标已存在的情况要**合并**而不是简单 update：目标作品里那张图
 * 可能已经有译文行（例如之前移过来过、或者被别的路径创建过），
 * 而 `(source_id, target_id, user_id)` 上有唯一键 —— 直接 update 会撞键报错。
 * 合并规则：目标已有该用户的行就**保留目标那份**（它对目标作品来说是「现状」），
 * 把源那份删掉；没有才搬过去。
 */
async function remapTranslations(
  tx: Tx,
  fileIds: readonly string[],
  targetMap: { byLanguage: Map<string, string> },
): Promise<number> {
  if (fileIds.length === 0) return 0;

  const rows = await tx
    .select({
      translation: translations,
      language: targets.language,
      sourceId: sources.id,
    })
    .from(translations)
    .innerJoin(targets, eq(targets.id, translations.targetId))
    .innerJoin(sources, eq(sources.id, translations.sourceId))
    .where(inArray(sources.fileId, [...fileIds]));

  let remapped = 0;

  for (const row of rows) {
    const toTargetId = targetMap.byLanguage.get(row.language);
    if (!toTargetId || toTargetId === row.translation.targetId) continue;

    const clash = await tx
      .select({ id: translations.id })
      .from(translations)
      .where(
        and(
          eq(translations.sourceId, row.sourceId),
          eq(translations.targetId, toTargetId),
          row.translation.userId
            ? eq(translations.userId, row.translation.userId)
            : isNull(translations.userId),
        ),
      )
      .limit(1);

    if (clash[0]) {
      // 目标已有同一人的候选 → 保留目标那份（它是目标作品的既成事实），删掉源那份。
      await tx.delete(translations).where(eq(translations.id, row.translation.id));
      continue;
    }

    // 先确保「选中」不会被撞：部分唯一索引要求每个 (标号, 语言) 至多一条 is_selected。
    if (row.translation.isSelected) {
      await tx
        .update(translations)
        .set({ isSelected: false })
        .where(and(eq(translations.sourceId, row.sourceId), eq(translations.targetId, toTargetId)));
    }

    await tx
      .update(translations)
      .set({ targetId: toTargetId, updatedAt: new Date() })
      .where(eq(translations.id, row.translation.id));

    remapped += 1;
  }

  return remapped;
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}
