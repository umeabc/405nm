import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { naturalSortKey } from '@405nm/shared';
import { db } from '../../db/client.js';
import { fileStates, files, projects } from '../../db/schema.js';
import { requireProjectAccess, requireProjectPermission, requireTeamAccess } from '../../domain/authorize.js';
import { ingestImage } from '../../domain/ingest-image.js';
import { env } from '../../env.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { extOf, mimeForExt } from '../../lib/mime.js';
import { logOp } from '../../lib/oplog.js';
import {
  IMAGE_VARIANTS,
  newFileKey,
  safeImageExt,
  storage,
  variantKey,
  type ImageVariant,
} from '../../storage/index.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 文件（图片）的上传、浏览、改名、删除与**字节流服务**。
 *
 * 关于「图片怎么给到浏览器」这条链路，这里是全案最需要说清楚的一处设计：
 *
 *  - 图片**不放在 nginx 的静态目录里**，而是经 `GET /files/:id/media/:variant`
 *    由应用读盘后流式吐出。代价是多一次转发，换来的是**每一张图都过一遍权限**：
 *    nginx 直发静态文件的话，凡是猜到 URL 的人都能看到未发表的作品。
 *  - URL 里带的是**文件 id**，不是存储键。这样既不可能通过构造路径去探测
 *    别人的对象（`../` 之类的攻击面直接不存在），也让权限判定有明确的主体 ——
 *    拿 id 查一次库就知道该文件的团队与作品，再按作品的权限校验。
 *  - 响应带 `immutable` 长缓存：同一个 id + variant 的内容永不改变
 *    （换图是新建修订版、得到新 id），所以浏览器可以放心长期缓存。
 */

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const mediaParam = z.object({
  id: z.string().uuid('文件 ID 不合法'),
  variant: z.enum(['raw', 'thumb', 'preview']),
});
const projectParam = z.object({ id: z.string().uuid('作品 ID 不合法') });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}

/**
 * 上传时用的文件名清洗。
 *
 * 只做显示用，**绝不参与存储路径的构造**（键是服务端生成的 uuid），
 * 所以这里的目的不是防穿越，而是防「文件名里带路径/控制字符」把界面或日志搞乱。
 */
function cleanFilename(raw: string | undefined, fallbackExt: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  // 控制字符（\u0000-\u001f 与 \u007f）会让日志与 JSON 难以阅读，有些还会在终端里搞出转义。
  const stripped = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = stripped.length > 0 ? stripped : `image${fallbackExt}`;
  return name.slice(0, 180);
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  // ── 列表 ──────────────────────────────────────────────────

  app.get('/projects/:id/files', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(projectParam, request.params);
    await requireProjectAccess(id, user);

    const query = parse(
      z.object({
        state: z.string().trim().max(24).optional(),
        keyword: z.string().trim().max(60).optional(),
        // 默认排除已软删除的图；只有显式的回收站视图才带上。
        includeDeleted: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      request.query,
    );

    const conditions = [eq(files.projectId, id)];
    if (!query.includeDeleted) conditions.push(isNull(files.deletedAt));
    if (query.state) conditions.push(eq(files.state, query.state));
    if (query.keyword) {
      conditions.push(sql`lower(${files.name}) LIKE ${`%${query.keyword.toLowerCase()}%`}`);
    }

    const rows = await db
      .select()
      .from(files)
      .where(and(...conditions))
      // 按 sort_name 排：数据库的字典序在补零键上就等于自然序，
      // 于是「p2 排在 p10 前面」不需要把全量取回来在内存里排 —— 分页因此是稳的。
      .orderBy(asc(files.sortName))
      .limit(query.limit);

    const [counts] = await db
      .select({
        total: count(),
        bytes: sql<number>`COALESCE(SUM(${files.size}), 0)`,
      })
      .from(files)
      .where(and(eq(files.projectId, id), isNull(files.deletedAt)));

    return {
      files: rows.map((row) => ({
        id: row.id,
        name: row.name,
        size: row.size,
        width: row.width,
        height: row.height,
        md5: row.md5,
        state: row.state,
        revision: row.revision,
        activated: row.activated,
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      total: Number(counts?.total ?? 0),
      bytes: Number(counts?.bytes ?? 0),
      truncated: rows.length >= query.limit,
    };
  });

  app.get('/files/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(fileParam, request.params);
    const file = await loadFile(id);
    await requireProjectAccess(file.projectId, user);

    const history = await db
      .select()
      .from(fileStates)
      .where(eq(fileStates.fileId, id))
      .orderBy(desc(fileStates.createdAt))
      .limit(50);

    return {
      file: {
        id: file.id,
        projectId: file.projectId,
        teamId: file.teamId,
        name: file.name,
        size: file.size,
        width: file.width,
        height: file.height,
        md5: file.md5,
        sha256: file.sha256,
        state: file.state,
        revision: file.revision,
        activated: file.activated,
        deletedAt: file.deletedAt ? file.deletedAt.toISOString() : null,
        createdAt: file.createdAt.toISOString(),
        updatedAt: file.updatedAt.toISOString(),
      },
      history: history.map((h) => ({
        from: h.fromState,
        to: h.toState,
        note: h.note,
        at: h.createdAt.toISOString(),
      })),
    };
  });

  // ── 上传 ──────────────────────────────────────────────────

  app.post(
    '/projects/:id/files',
    {
      // Fastify 的全局 bodyLimit 是 1MB（给 JSON 用的），
      // 图片请求必须在这里单独放宽，否则 multer 还没开始读就被 413 拦掉。
      bodyLimit: env.MAX_IMAGE_MB * 1024 * 1024 + 1024 * 1024,
    },
    async (request, reply) => {
      const user = await requireAuth(request);
      const { id: projectId } = parse(projectParam, request.params);
      const access = await requireProjectAccess(projectId, user);
      requireProjectPermission(access, 'file.add');

      if (!request.isMultipart()) {
        throw badRequest('请使用 multipart/form-data 上传图片', 'NOT_MULTIPART');
      }

      const uploaded: Array<{ id: string; name: string; width: number; height: number; size: number }> = [];
      const duplicates: Array<{ name: string; existingId: string; existingName: string }> = [];
      const failures: Array<{ name: string; reason: string; code: string }> = [];

      // 逐张处理，不并发：图片解码是内存大户（一张大图解码后几百 MB），
      // 并发上传几张就能把容器打爆。lib/image.ts 里还有一道闸门，
      // 这里是第一道 —— 两道都要有，因为这一道还负责「顺序写库、进度可预期」。
      for await (const part of request.parts()) {
        if (part.type !== 'file') {
          // 普通表单字段（如作品 id）。@fastify/multipart 已经把它读完放进
          // `.value`，这里只需跳过 —— 不能去调 toBuffer()，那是文件才有的方法。
          continue;
        }

        const filename = cleanFilename(part.filename, '.jpg');

        let buffer: Buffer;
        try {
          buffer = await part.toBuffer();
        } catch (err) {
          // @fastify/multipart 在超过 limits.fileSize 时抛这个错。
          const code = (err as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE') {
            failures.push({
              name: filename,
              reason: `超过 ${env.MAX_IMAGE_MB}MB 上限`,
              code: 'FILE_TOO_LARGE',
            });
            continue;
          }
          failures.push({ name: filename, reason: '读取上传内容失败', code: 'READ_FAILED' });
          continue;
        }

        try {
          safeImageExt(filename);
        } catch (err) {
          failures.push({
            name: filename,
            reason: err instanceof Error ? err.message : '不支持的格式',
            code: 'UNSUPPORTED_IMAGE',
          });
          continue;
        }

        // ⚠️ 这里**刻意不再先 processImage 一次**。
        // 它原本是为了拿摘要做去重、顺便校验图片；现在那两件事都在 ingestImage 里做，
        // 再留着就是同一张图解码两遍 —— 一张 8000×12000 的扫图解码后约 380MB，
        // 在小内存机器上这一下就是 OOM。解码失败仍会被下面的 catch 逐张记成失败项。

        // 去重判定与落库都交给 domain/ingest-image —— **图源导入走的是同一份实现**。
        // 各写一份的话，两边迟早分叉，最典型的症状是「导入进来的图没有缩略图」
        // 而上传的图有，而这种差异不会有人想到去查两处代码。
        try {
          const outcome = await ingestImage({
            teamId: access.project.teamId,
            projectId,
            actorId: user.id,
            name: filename,
            buffer,
            note: '上传入库',
          });

          if (outcome.status === 'duplicate') {
            duplicates.push({
              name: filename,
              existingId: outcome.existingId,
              existingName: outcome.existingName,
            });
            continue;
          }

          uploaded.push({
            id: outcome.id,
            name: outcome.name,
            width: outcome.width,
            height: outcome.height,
            size: outcome.size,
          });
        } catch (err) {
          const code = err instanceof AppError ? err.code : 'SAVE_FAILED';
          const reason = err instanceof AppError ? err.message : '保存失败，请重试';
          request.log.error({ err }, '写入文件记录失败');
          failures.push({ name: filename, reason, code });
        }
      }

      if (uploaded.length > 0) {
        await logOp({
          actorId: user.id,
          teamId: access.project.teamId,
          action: 'file.upload',
          targetType: 'project',
          targetId: projectId,
          targetName: access.project.name,
          detail: { count: uploaded.length, names: uploaded.map((u) => u.name).slice(0, 20) },
          ip: clientIp(request),
        });
      }

      // 全部失败时返回 400，让前端能一眼看出「这次上传一无所获」；
      // 部分成功仍返回 200，逐项结果放在 failures 里 —— 这与 380nm 的上传弹窗
      // 「成功几张、失败几张，失败的可以重试」那套交互是对齐的。
      if (uploaded.length === 0 && failures.length > 0 && duplicates.length === 0) {
        reply.code(400);
      } else if (uploaded.length > 0) {
        reply.code(201);
      }

      return { uploaded, duplicates, failures };
    },
  );

  // ── 字节流 ────────────────────────────────────────────────

  app.get('/files/:id/media/:variant', async (request, reply) => {
    const user = await requireAuth(request);
    const { id, variant } = parse(mediaParam, request.params);
    const file = await loadFile(id);

    // 已软删除的图不再对外提供字节 —— 否则「删了」只是界面上看不见，
    // 拿着 id 照样能取到，删除就成了假的。
    if (file.deletedAt) throw notFound('图片已被删除', 'FILE_DELETED');

    await requireProjectAccess(file.projectId, user);

    const key = variant === 'raw' ? file.storageKey : variantKey(file.storageKey, variant as ImageVariant);
    const object = await storage.openRead(key);

    if (!object) {
      // 刻意**不回落**到原图：缩略图缺失时回落会把一张十几 MB 的原图
      // 塞进列表页的每个格子里，把带宽和内存一起打光。
      // 让前端拿到 404 显示占位图，比悄悄降级要诚实得多。
      throw notFound('图片文件不存在或已被清理', 'MEDIA_MISSING');
    }

    // 同一个 id + variant 的字节永不改变（换图会得到新的 id），
    // 所以可以放心 immutable —— 浏览器不会再为此发请求。
    const etag = `"${file.sha256.slice(0, 32)}-${variant}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.code(304);
      return reply.send();
    }

    const ext = variant === 'raw' ? extOf(file.storageKey) : '.webp';
    reply
      .header('Content-Type', mimeForExt(ext))
      .header('Content-Length', String(object.size))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', etag)
      // 图片是用户上传的内容，别让浏览器去猜类型执行它。
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(object.stream);
  });

  /** 变体清单，前端不必硬编码。 */
  app.get('/files/media-variants', async (request) => {
    await requireAuth(request);
    return { variants: ['raw', ...IMAGE_VARIANTS] };
  });

  // ── 改名 / 删除 ───────────────────────────────────────────

  app.patch('/files/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(fileParam, request.params);
    const file = await loadFile(id);
    const access = await requireProjectAccess(file.projectId, user);
    requireProjectPermission(access, 'file.rename');

    const body = parse(
      z.strictObject({ name: z.string().trim().min(1, '请填写文件名').max(180, '文件名过长') }),
      request.body,
    );

    // 只改显示名与排序键，**不动存储键** —— 存储键是数据的身份，
    // 改名是视图层的事，改键会让缓存、修订链、外部引用一起失效。
    const updated = await db
      .update(files)
      .set({ name: body.name, sortName: naturalSortKey(body.name), updatedAt: new Date() })
      .where(and(eq(files.id, id), isNull(files.deletedAt)))
      .returning({ id: files.id });
    if (updated.length === 0) throw notFound('图片不存在或已删除', 'FILE_NOT_FOUND');

    return { ok: true };
  });

  app.delete('/files/:id', async (request) => {
    const user = await requireAuth(request);
    const { id } = parse(fileParam, request.params);
    const file = await loadFile(id);
    const access = await requireProjectAccess(file.projectId, user);
    requireProjectPermission(access, 'file.delete');

    await softDelete([id], access.project.id);
    await touchProject(access.project.id);

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.delete',
      targetType: 'project',
      targetId: access.project.id,
      targetName: access.project.name,
      detail: { fileId: id, name: file.name },
      ip: clientIp(request),
    });

    return { ok: true };
  });

  app.post('/projects/:id/files/batch-delete', async (request) => {
    const user = await requireAuth(request);
    const { id: projectId } = parse(projectParam, request.params);
    const access = await requireProjectAccess(projectId, user);
    requireProjectPermission(access, 'file.delete');

    const body = parse(
      z.object({ fileIds: z.array(z.string().uuid()).min(1, '请选择要删除的图片').max(500) }),
      request.body,
    );

    // 只删属于这个作品的图：请求里混进别的作品的 id 就整批拒绝，
    // 而不是「悄悄跳过」—— 静默跳过会让调用方以为删干净了。
    const rows = await db
      .select({ id: files.id })
      .from(files)
      .where(and(inArray(files.id, body.fileIds), eq(files.projectId, projectId), isNull(files.deletedAt)));

    if (rows.length !== body.fileIds.length) {
      throw badRequest('部分图片不属于该作品或已被删除', 'FILE_SCOPE_MISMATCH');
    }

    await softDelete(body.fileIds, projectId);
    await touchProject(projectId);

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.batch_delete',
      targetType: 'project',
      targetId: projectId,
      targetName: access.project.name,
      detail: { count: body.fileIds.length },
      ip: clientIp(request),
    });

    return { ok: true, deleted: body.fileIds.length };
  });

  // ── 存储用量 ──────────────────────────────────────────────

  /**
   * 团队用量。**从数据库求和**，而不是去遍历磁盘 ——
   * 磁盘统计要扫全站（含别的团队），慢且口径不对。
   * 磁盘余量取一次 statfs，那是唯一必须从文件系统拿的数字。
   */
  app.get('/teams/:id/storage', async (request) => {
    const user = await requireAuth(request);
    const { id: teamId } = parse(z.object({ id: z.string().uuid() }), request.params);
    await requireTeamAccess(teamId, user);

    const [totals] = await db
      .select({
        total: count(),
        bytes: sql<number>`COALESCE(SUM(${files.size}), 0)`,
      })
      .from(files)
      .where(and(eq(files.teamId, teamId), isNull(files.deletedAt)));

    const disk = await storage.usage();

    return {
      team: {
        fileCount: Number(totals?.total ?? 0),
        usedBytes: Number(totals?.bytes ?? 0),
      },
      disk: {
        usedBytes: disk.usedBytes,
        totalBytes: disk.totalBytes,
        availableBytes: disk.availableBytes,
        objectCount: disk.objectCount,
        elapsedMs: disk.elapsedMs,
      },
      driver: storage.id,
    };
  });
}

async function loadFile(id: string) {
  const rows = await db.select().from(files).where(eq(files.id, id)).limit(1);
  const file = rows[0];
  if (!file) throw notFound('图片不存在', 'FILE_NOT_FOUND');
  return file;
}

/**
 * 软删除。**只标记不删字节** —— 已经产出的标号与译文还引用着这一页，
 * 真删会让它们变成指向空白的孤儿。物理清理是单独的运维动作（M5 的清理工具）。
 */
async function softDelete(fileIds: readonly string[], projectId: string): Promise<void> {
  if (fileIds.length === 0) return;
  await db
    .update(files)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(files.id, [...fileIds]), eq(files.projectId, projectId)));
}

async function touchProject(projectId: string): Promise<void> {
  await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
}
