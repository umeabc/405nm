import { asc, eq, and, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clamp01 } from '@405nm/shared';
import { db, type DbLike, type Tx } from '../../db/client.js';
import { fileStates, files, projects, sources } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { logOp } from '../../lib/oplog.js';
import { loadAccessibleFile, parseOrThrow } from '../file-access.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 标号（标注）。
 *
 * 三条约束贯穿本文件：
 *
 * 1. **坐标一律归一化到 0–1 再落库**，入口处夹紧。客户端传 1.2 或 -0.3
 *    不该被信任 —— 越界坐标会让标号跑到画布外面，而画布外的元素
 *    在界面上是「看不见但选得中」，最难排查。
 * 2. **画布整张提交，而不是每次拖动发一次请求**。拖动会连续产生几十次变化，
 *    逐次请求既慢又乱序（最后到达的那次决定库里的样子，而那未必是用户想要的）。
 *    所以给一个 `PUT /files/:id/sources` 做批量保存，画布在松手/切页时提交。
 * 3. **默认增量保存，全量替换要显式声明**。全量替换的失败模式太糟：
 *    一次并发编辑或网络抖动导致请求体不全，就会删掉别人刚加的标号。
 */

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const sourceParam = z.object({
  id: z.string().uuid('文件 ID 不合法'),
  sourceId: z.string().uuid('标号 ID 不合法'),
});

const sourceInputSchema = z.object({
  /** 已有标号带 id 表示更新；不带表示新建 */
  id: z.string().uuid().optional(),
  kind: z.enum(['box', 'pin']).default('box'),
  x: z.number(),
  y: z.number(),
  w: z.number().default(0),
  h: z.number().default(0),
  vertices: z.array(z.tuple([z.number(), z.number()])).nullish(),
  groupId: z.string().uuid().nullish(),
  orderIndex: z.number().int().min(0).max(100000).optional(),
  content: z.string().max(4000).default(''),
  note: z.string().max(2000).default(''),
  style: z.record(z.unknown()).default({}),
});

const saveSchema = z.object({
  sources: z.array(sourceInputSchema).max(500),
  /** true = 请求里没出现的标号会被删除。默认 false（只 upsert）。 */
  replace: z.boolean().default(false),
});

/** 夹紧坐标。返回值一定落在 [0,1]；宽高只限绝对值，因为框可以越过图片右边界的一部分。 */
function normalizeGeometry<T extends { x: number; y: number; w: number; h: number }>(input: T): T {
  return {
    ...input,
    x: clamp01(input.x),
    y: clamp01(input.y),
    w: Math.max(-1, Math.min(1, input.w)),
    h: Math.max(-1, Math.min(1, input.h)),
  };
}

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  /** 取一张图的全部标号。翻校画布打开时调它。 */
  app.get('/files/:id/sources', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file } = await loadAccessibleFile(fileId, user);

    return { sources: await listSources(fileId), fileState: file.state };
  });

  /**
   * 批量保存标号。
   *
   * 返回**回读后的完整列表**（而不是只回「成功了几个」）：客户端需要拿到
   * 服务端生成的 id 与夹紧后的最终坐标，否则它只能猜「我本地那个临时 id
   * 对应服务端的哪一个」，并在下一次保存时把同一个标号又创建一遍。
   */
  app.put('/files/:id/sources', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user, 'label.add');

    const body = parseOrThrow(saveSchema, request.body);

    let removed: string[] = [];

    await db.transaction(async (tx) => {
      if (body.replace) {
        const existing = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(eq(sources.fileId, fileId));

        const incoming = new Set(body.sources.map((s) => s.id).filter(Boolean) as string[]);
        removed = existing.map((r) => r.id).filter((id) => !incoming.has(id));
        if (removed.length > 0) {
          await tx.delete(sources).where(inArray(sources.id, removed));
        }
      }

      for (const input of body.sources) {
        const geometry = normalizeGeometry(input);
        const values = {
          kind: geometry.kind,
          x: geometry.x,
          y: geometry.y,
          w: geometry.w,
          h: geometry.h,
          vertices: (input.vertices ?? null) as never,
          groupId: input.groupId ?? null,
          content: input.content,
          note: input.note,
          style: input.style as never,
          updatedAt: new Date(),
        };

        if (input.id) {
          // `file_id` 也进 WHERE：否则一个构造出来的 id 就能改到别的作品的标号上。
          await tx
            .update(sources)
            .set(values)
            .where(and(eq(sources.id, input.id), eq(sources.fileId, fileId)));
        } else {
          await tx.insert(sources).values({
            ...values,
            fileId,
            orderIndex: input.orderIndex ?? (await nextOrderIndex(tx, fileId)),
            createdBy: user.id,
          });
        }
      }

      await advanceToTranslatingIfSourced(tx, fileId, access.project.id, user.id);
    });

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'label.save',
      targetType: 'file',
      targetId: fileId,
      targetName: file.name,
      detail: { saved: body.sources.length, removed: removed.length },
      ip: clientIp(request),
    });

    return { sources: await listSources(fileId), removed };
  });

  app.post('/files/:id/sources', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: fileId } = fileParam.parse(request.params);
    const { access } = await loadAccessibleFile(fileId, user, 'label.add');

    const input = normalizeGeometry(
      parseOrThrow(sourceInputSchema.omit({ id: true }), request.body),
    );

    const inserted = await db
      .insert(sources)
      .values({
        fileId,
        kind: input.kind,
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        vertices: (input.vertices ?? null) as never,
        groupId: input.groupId ?? null,
        orderIndex: input.orderIndex ?? (await nextOrderIndex(db, fileId)),
        content: input.content,
        note: input.note,
        style: input.style as never,
        createdBy: user.id,
      })
      .returning();

    const created = inserted[0];
    if (!created) throw new Error('新建标号失败');

    await advanceToTranslatingIfSourced(db, fileId, access.project.id, user.id);

    reply.code(201);
    return { source: serializeSource(created) };
  });

  app.delete('/files/:id/sources/:sourceId', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId, sourceId } = sourceParam.parse(request.params);
    const { file, access } = await loadAccessibleFile(fileId, user, 'label.delete');

    const removed = await db
      .delete(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.fileId, fileId)))
      .returning({ id: sources.id });

    if (removed.length === 0) throw notFound('标号不存在', 'SOURCE_NOT_FOUND');

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'label.delete',
      targetType: 'file',
      targetId: fileId,
      targetName: file.name,
      detail: { sourceId },
      ip: clientIp(request),
    });

    return { ok: true };
  });
}

export async function listSources(fileId: string, tx: DbLike = db) {
  const rows = await tx
    .select()
    .from(sources)
    .where(eq(sources.fileId, fileId))
    // 阅读顺序即显示序号；`createdAt` 兜底保证顺序稳定（否则两次读取可能不同序）。
    .orderBy(asc(sources.orderIndex), asc(sources.createdAt));

  return rows.map(serializeSource);
}

async function nextOrderIndex(tx: DbLike, fileId: string): Promise<number> {
  const rows = await tx
    .select({ max: sql<number>`COALESCE(MAX(${sources.orderIndex}), -1)` })
    .from(sources)
    .where(eq(sources.fileId, fileId));
  return Number(rows[0]?.max ?? -1) + 1;
}

/**
 * 有标号了 → 这张图进入「翻译中」（如果它还在「已入库」）。
 *
 * 这是「事实自动前进」的那一半：动过标号就说明有人开始干了，不必再让人
 * 按一下「开始翻译」。另一半「完成」必须由人确认，见 domain/file-state.ts。
 */
async function advanceToTranslatingIfSourced(
  tx: DbLike | Tx,
  fileId: string,
  projectId: string,
  actorId: string,
): Promise<void> {
  const rows = await tx.select({ state: files.state }).from(files).where(eq(files.id, fileId)).limit(1);
  if (rows[0]?.state !== 'sourced') return;

  await tx.update(files).set({ state: 'translating', updatedAt: new Date() }).where(eq(files.id, fileId));
  await tx.insert(fileStates).values({
    fileId,
    fromState: 'sourced',
    toState: 'translating',
    actorId,
    note: '新增标号，自动进入翻译中',
  });
  await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
}

function serializeSource(row: typeof sources.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    vertices: row.vertices ?? null,
    groupId: row.groupId,
    orderIndex: row.orderIndex,
    content: row.content,
    note: row.note,
    style: (row.style ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

