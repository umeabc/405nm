import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { outputs, targets } from '../../db/schema.js';
import { countOutputs, createOutput, deleteOutput, listOutputs } from '../../domain/file-output.js';
import { env } from '../../env.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { mimeForExt } from '../../lib/mime.js';
import { logOp } from '../../lib/oplog.js';
import { storage, variantKey, type ImageVariant } from '../../storage/index.js';
import { resolveLanguage } from '../../publish/compose.js';
import { loadAccessibleFile } from '../file-access.js';
import { clientIp, requireAuth } from '../guards.js';

/**
 * 嵌字成品的回传与读取 —— 离线 PS 嵌字流程的回程。
 *
 * 权限用 `file.typeset`（回传嵌字成品），与「导出嵌字包」的 `tra.output` 分开：
 * 导出是只读的、谁都能做；回传是写入，是要署名与审计的动作。
 */

const fileParam = z.object({ id: z.string().uuid('文件 ID 不合法') });
const outputParam = z.object({
  id: z.string().uuid('文件 ID 不合法'),
  outputId: z.string().uuid('成品 ID 不合法'),
});
const outputMediaParam = z.object({
  id: z.string().uuid('文件 ID 不合法'),
  outputId: z.string().uuid('成品 ID 不合法'),
  variant: z.enum(['raw', 'thumb', 'preview']),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数不合法');
  return parsed.data;
}

/**
 * 定出这次回传算哪个语言的成品。
 *
 * 规则与成品草稿（发布）走**同一份实现** —— 见 `publish/compose.ts` 的
 * `resolveLanguage`。两处各写一遍的话，迟早一边改了另一边没改，
 * 表现是「回传时算一个语言、生成草稿时又按另一个语言找」。
 */
async function resolveLanguageForOutput(projectId: string, requested?: string): Promise<string> {
  try {
    return await resolveLanguage(projectId, requested);
  } catch (err) {
    // compose 里的版本不认识 HTTP 错误码，这里翻译一下
    throw badRequest(err instanceof Error ? err.message : '语言不合法', 'UNKNOWN_LANGUAGE');
  }
}

export async function registerOutputRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 回传成品。
   *
   * 上限用 `MAX_OUTPUT_MB`（比原图宽松），且通过 `request.parts({ limits })`
   * **按请求覆盖** —— 全局的 multipart 上限是按原图定的，改全局会顺带放松
   * 普通图片上传；逐个请求设限才是把差别表达在正确的地方。
   */
  app.post(
    '/files/:id/outputs',
    { bodyLimit: env.MAX_OUTPUT_MB * 1024 * 1024 + 1024 * 1024 },
    async (request) => {
      const user = await requireAuth(request);
      const { id: fileId } = parse(fileParam, request.params);
      const { file, access } = await loadAccessibleFile(fileId, user, 'file.typeset');

      if (!request.isMultipart()) {
        throw badRequest('请使用 multipart/form-data 上传成品图', 'NOT_MULTIPART');
      }

      let buffer: Buffer | null = null;
      let name = 'output.png';
      let note = '';
      let requestedLanguage: string | undefined;

      for await (const part of request.parts({
        limits: { fileSize: env.MAX_OUTPUT_MB * 1024 * 1024, files: 1, fields: 10 },
      })) {
        if (part.type === 'field') {
          if (part.fieldname === 'note') note = String(part.value ?? '').slice(0, 500);
          if (part.fieldname === 'language') requestedLanguage = String(part.value ?? '');
          continue;
        }

        // 只收一个文件。第二次进来就是调用方用错了接口形状。
        if (buffer !== null) {
          throw badRequest('一次只能回传一张成品', 'TOO_MANY_FILES');
        }

        name = (part.filename ?? 'output.png').split(/[\\/]/).pop() ?? 'output.png';
        try {
          buffer = await part.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
            throw badRequest(`成品图超过 ${env.MAX_OUTPUT_MB}MB 上限`, 'FILE_TOO_LARGE');
          }
          throw badRequest('读取上传内容失败', 'READ_FAILED');
        }
      }

      if (buffer === null) throw badRequest('没有收到成品图文件', 'NO_FILE');

      const language = await resolveLanguageForOutput(file.projectId, requestedLanguage);
      const created = await createOutput({
        fileId,
        projectId: file.projectId,
        actorId: user.id,
        language,
        name,
        buffer,
        note,
      });

      await logOp({
        actorId: user.id,
        teamId: access.project.teamId,
        action: 'file.output_upload',
        targetType: 'project',
        targetId: file.projectId,
        targetName: access.project.name,
        detail: { fileId, name, version: created.version, language },
        ip: clientIp(request),
      });

      return {
        ok: true,
        output: { ...created, name },
        /** 回传给界面直接提示下一步：已经有成品了，可以标记为已嵌字 */
        hint: '成品已入库。可以在图片上把状态推进到「已嵌字」了。',
      };
    },
  );

  /** 列出某个文件的成品版本（最新在前）。 */
  app.get('/files/:id/outputs', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId } = parse(fileParam, request.params);
    await loadAccessibleFile(fileId, user);

    const list = await listOutputs(fileId);
    return { outputs: list, count: list.length };
  });

  /** 删除一版成品。字节一并删掉，不留孤儿。 */
  app.delete('/files/:id/outputs/:outputId', async (request) => {
    const user = await requireAuth(request);
    const { id: fileId, outputId } = parse(outputParam, request.params);
    const { file, access } = await loadAccessibleFile(fileId, user, 'file.typeset');

    await deleteOutput(outputId, fileId);

    await logOp({
      actorId: user.id,
      teamId: access.project.teamId,
      action: 'file.output_delete',
      targetType: 'project',
      targetId: file.projectId,
      targetName: access.project.name,
      detail: { fileId, outputId },
      ip: clientIp(request),
    });

    return { ok: true, remaining: await countOutputs(fileId) };
  });

  /**
   * 成品的字节流。
   *
   * 与图片媒体路由同一套做法：**鉴权后由应用读盘吐出**，不做静态直发。
   * ETag 由 id + 变体构成 —— 成品一旦回传就不再改动（改是新增一版），
   * 所以可以 immutable 长缓存。
   */
  app.get('/files/:id/outputs/:outputId/media/:variant', async (request, reply) => {
    const user = await requireAuth(request);
    const { id: fileId, outputId, variant } = parse(outputMediaParam, request.params);
    const { file } = await loadAccessibleFile(fileId, user);

    // 直接查表而不是走 listOutputs：这里需要 storageKey，而列表视图刻意不暴露它。
    // ⚠️ 两个条件都要带：只按 outputId 查的话，知道别处某个成品 id 的人
    // 就能拿自己作品里的文件 id 当跳板把别人的成品读走。
    const rows = await db
      .select()
      .from(outputs)
      .where(and(eq(outputs.id, outputId), eq(outputs.fileId, file.id)))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('成品不存在', 'OUTPUT_NOT_FOUND');

    const key =
      variant === 'raw' ? row.storageKey : variantKey(row.storageKey, variant as ImageVariant);
    const object = await storage.openRead(key);
    if (!object) throw notFound('成品文件不存在或已被清理', 'OUTPUT_MISSING');

    const etag = `"out-${row.id.slice(0, 24)}-${variant}-v${row.version}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.code(304);
      return reply.send();
    }

    const ext = variant === 'raw' ? row.storageKey.match(/\.[^.]+$/)?.[0] ?? '.png' : '.webp';
    reply
      .header('Content-Type', mimeForExt(ext))
      .header('Content-Length', String(object.size))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff');

    return reply.send(object.stream);
  });
}
