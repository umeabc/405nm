/**
 * 业务错误。带一个稳定的机器可读 `code`，前端据此分支；`message` 是给人看的中文。
 * 与 Fastify 自身的 FastifyError 区分开，在 errorHandler 里统一转成响应。
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, statusCode = 400, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    if (detail !== undefined) this.detail = detail;
  }
}

export const badRequest = (message: string, code = 'INVALID_ARGUMENT', detail?: unknown) =>
  new AppError(code, message, 400, detail);

export const unauthorized = (message = '未登录或会话已过期') =>
  new AppError('UNAUTHORIZED', message, 401);

export const forbidden = (message = '没有权限执行该操作') =>
  new AppError('FORBIDDEN', message, 403);

export const notFound = (message = '资源不存在', code = 'NOT_FOUND') =>
  new AppError(code, message, 404);

export const conflict = (message: string, code = 'CONFLICT') => new AppError(code, message, 409);

export const tooManyRequests = (message: string, code = 'RATE_LIMITED') =>
  new AppError(code, message, 429);
