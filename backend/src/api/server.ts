import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { env, isProduction } from '../env.js';
import { AppError } from '../lib/errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerFileRoutes } from './routes/files.js';
import { registerOutputRoutes } from './routes/outputs.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInsightRoutes } from './routes/insights.js';
import { registerMoveRoutes } from './routes/move.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSiteRoutes } from './routes/site.js';
import { registerSourcingAdminRoutes, registerSourcingRoutes } from './routes/sourcing.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerTranslationRoutes } from './routes/translations.js';
import { registerWorkflowRoutes } from './routes/workflow.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // 前面有 nginx 反代，不开这个拿到的永远是反代容器的 IP。
    trustProxy: true,
    // JSON 请求体的上限。**图片上传不受它约束** ——
    // 上传路由单独设了 bodyLimit，见 api/routes/files.ts。
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_IMAGE_MB * 1024 * 1024,
      // 一次请求最多 50 张。前端是逐张上传（为的是拿到每张的进度），
      // 这个上限是给其他客户端留的余量，不是给浏览器用的。
      files: 50,
      fields: 10,
      // 只在真的超过上限时报错；默认就会在 parts 遍历里抛错并被我们捕获。
      parts: 60,
    },
  });

  // ⚠️ 顺序要紧：`await app.register()` 会**立刻**触发插件加载，
  // 子上下文在那时就捕获了当时的错误处理器。所以这两个 handler 必须写在 register 之前，
  // 否则 AppError 会被 Fastify 的默认处理器接管，响应体变成它自己的 {statusCode, error, message} 形状。
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: `接口不存在：${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // 业务错误是可预期的，按 info 记 —— 不跟真正的故障混在一个级别里。
    if (error instanceof AppError) {
      request.log.info({ code: error.code }, error.message);
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.detail !== undefined ? { detail: error.detail } : {}),
      });
      return;
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error({ err: error }, '请求处理失败');
    }

    reply.code(status).send({
      error: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'ERROR'),
      // 生产环境不把内部错误细节透给前端，开发态保留以便排查。
      message:
        status >= 500 && isProduction ? '服务器内部错误，请稍后重试' : error.message,
    });
  });

  // 所有接口统一挂在 /api 下 —— nginx 只反代这一个前缀，与彩翻一致。
  await app.register(
    async (api) => {
      await registerHealthRoutes(api);
      await registerSiteRoutes(api);
      await registerAuthRoutes(api);
      await registerTeamRoutes(api);
      await registerAdminRoutes(api);
      await registerProjectRoutes(api);
      await registerFileRoutes(api);
      await registerSourceRoutes(api);
      await registerTranslationRoutes(api);
      await registerWorkflowRoutes(api);
      await registerMoveRoutes(api);
      await registerSourcingRoutes(api);
      await registerSourcingAdminRoutes(api);
      await registerOutputRoutes(api);
      await registerExportRoutes(api);
      await registerInsightRoutes(api);
    },
    { prefix: '/api' },
  );

  return app;
}
