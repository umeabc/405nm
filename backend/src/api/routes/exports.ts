import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { labelPlusDownloadName } from '@405nm/shared';
import { db } from '../../db/client.js';
import { files, targets } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission } from '../../domain/authorize.js';
import { buildOutputsArchive, buildProjectArchive, contentDisposition } from '../../export/archive.js';
import { buildProjectLabelPlus } from '../../export/labelplus.js';
import { zipToReadable } from '../../export/zip.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth } from '../guards.js';

/**
 * 导出：LabelPlus txt、工程包、成品包。
 *
 * 全部走 `tra.output`（导出译文与图片）。这是**只读**动作，所以不记操作日志 ——
 * 记了只会把「谁下载过」淹进噪声里。真正需要审计的是成品回传
 * （见 routes/outputs.ts），那边每一次写入都留痕。
 */

const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });
const exportQuery = z.object({ targetId: z.string().uuid('目标语言 ID 不合法') });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 导出前的体检。
   *
   * 界面在用户点「下载」之前调它，把「这个语言还有多少没翻」摆出来。
   * 做成独立接口而不是复用下载响应头：下载是浏览器导航行为，
   * 前端拿不到响应体里的统计，只能干等着文件下来。
   */
  app.get('/projects/:id/exports/preview', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'tra.output');

    const query = parse(exportQuery, request.query);
    const built = await buildProjectLabelPlus(projectId, query.targetId);

    const fileRows = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.projectId, projectId), isNull(files.deletedAt), eq(files.activated, true)));

    return {
      project: { id: projectId, name: access.project.name },
      language: built.language,
      targetLabel: built.targetLabel,
      fileCount: fileRows.length,
      markerStats: built.markerStats,
      /** 用**导出后**的名字，用户拿着清单去包里找得到 */
      filesWithoutTranslation: built.filesWithoutTranslation,
    };
  });

  /**
   * LabelPlus txt 单文件。
   *
   * 单独给一条路由（而不是只给压缩包）：改一两句译文之后想快速对比时，
   * 为了一个几十 KB 的 txt 去下几十 MB 的工程包太浪费。
   */
  app.get('/projects/:id/exports/labelplus', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'tra.output');

    const query = parse(exportQuery, request.query);
    const built = await buildProjectLabelPlus(projectId, query.targetId);

    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        contentDisposition(labelPlusDownloadName(access.project.name, built.language)),
      )
      // 不加 immutable：译文随时会变，让浏览器每次回来问一下更符合直觉。
      // （字节本身是稳定的 —— 注释块里刻意没有时间戳，同样的内容得到同样的字节。）
      .header('Cache-Control', 'no-store');

    return reply.send(Buffer.from(built.text, 'utf8'));
  });

  /** 工程包：原图 + txt + manifest + 说明。 */
  app.get('/projects/:id/exports/project.zip', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'tra.output');

    const query = parse(exportQuery, request.query);
    const plan = await buildProjectArchive(projectId, query.targetId);

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(plan.filename))
      .header('Cache-Control', 'no-store');

    // ⚠️ 必须 reply.send(stream) 而不是先拼 Buffer：
    // 几十页、每页几 MB，拼完再发等于把整包塞进内存。
    return reply.send(zipToReadable(plan.entries));
  });

  /** 成品包：各文件在该语言下的最新成品图。 */
  app.get('/projects/:id/exports/outputs.zip', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'tra.output');

    const query = parse(exportQuery, request.query);
    const plan = await buildOutputsArchive(projectId, query.targetId);

    // 有文件还没回传成品时**照样打包能打的**，但把缺的清单放进响应头。
    // 直接报错会让人「一页没嵌完就什么都下载不了」；默默漏掉则会让人以为
    // 包是全的。放响应头是两者的折中 —— 前端读得到，能明确提示。
    if (plan.missing.length > 0) {
      reply.header('X-Missing-Files', encodeURIComponent(plan.missing.slice(0, 50).join(',')));
      reply.header('X-Missing-Count', String(plan.missing.length));
    }

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition(plan.filename))
      .header('Cache-Control', 'no-store');

    return reply.send(zipToReadable(plan.entries));
  });

  /** 作品下的目标语言，供导出界面选。 */
  app.get('/projects/:id/exports/targets', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    await requireProjectAccess(projectId, user);

    const rows = await db
      .select({ id: targets.id, language: targets.language, label: targets.label })
      .from(targets)
      .where(eq(targets.projectId, projectId))
      .orderBy(asc(targets.orderIndex));

    return { targets: rows };
  });
}
