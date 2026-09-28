/**
 * 图源抓取的失败分类。
 *
 * 分类**必须**具体到能驱动后续动作，而不是统一一个「抓取失败」：
 *
 *  - `BLOCKED`     → 指纹或 IP 被识别为爬虫。这是**需要人来处理**的事
 *                    （换代理出口、更新 impit），重试一万次也没用。
 *  - `TIMEOUT` / `NETWORK` → 瞬时的，可以退避重试。
 *  - `RATE_LIMITED`→ 要退避，而且退了多半能成。
 *  - `NOT_FOUND`   → 链接本身不对（作品被删、id 写错）。提示用户改链接，不要重试。
 *  - `UNSUPPORTED` → 我们还不支持这类链接。
 *
 * 这个区分不是洁癖：导入任务是持久化的、可以跑几百张图，如果所有失败都长一样，
 * 一次「代理挂了」和一次「有一条链接写错了」会在界面上完全无法区分，
 * 用户只能一张张去猜。
 */
export type SourcingFailureCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROXY'
  | 'BLOCKED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'NO_MEDIA'
  | 'UPSTREAM_ERROR'
  | 'HTTP_STATUS'
  | 'TOO_MANY_REDIRECTS'
  | 'CONTENT_TYPE'
  | 'EMPTY'
  | 'PARSE';

/**
 * 是否值得原样重试。用于「重试失败项」时过滤出真正可能成功的那些。
 *
 * `UPSTREAM_ERROR`（5xx）与 `HTTP_STATUS`（其他 4xx）刻意分成两个码：
 * 前者是上游**暂时**出了问题，重试有意义；后者是请求本身不对
 * （403 没带 Referer、401 凭据过期），原样重试一万次也一样。
 */
const RETRYABLE: ReadonlySet<SourcingFailureCode> = new Set([
  'TIMEOUT',
  'NETWORK',
  'PROXY',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
]);

export class SourcingError extends Error {
  readonly code: SourcingFailureCode;
  /** 便于排查的上下文：状态码、上游消息、被拒的 URL 等。**不往客户端原样吐**。 */
  readonly detail: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: SourcingFailureCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SourcingError';
    this.code = code;
    this.detail = detail;
    this.retryable = RETRYABLE.has(code);
  }

  /** 给用户看的一句话。不带内部细节（URL 里的 token、上游 HTML 片段都不能露）。 */
  get userMessage(): string {
    switch (this.code) {
      case 'INVALID_URL':
        return '链接格式不对';
      case 'UNSUPPORTED':
        return '暂时不支持这类链接';
      case 'TIMEOUT':
        return '上游响应超时';
      case 'NETWORK':
        return '连不上上游';
      case 'PROXY':
        return '代理不可用';
      case 'BLOCKED':
        return '被上游拦截（可能需要更换出口）';
      case 'RATE_LIMITED':
        return '被上游限流，稍后再试';
      case 'NOT_FOUND':
        return '内容不存在或已被删除';
      case 'NO_MEDIA':
        return '这个链接里没有图片';
      case 'UPSTREAM_ERROR':
        return '上游暂时出错，稍后再试';
      case 'CONTENT_TYPE':
        return '返回的不是图片';
      case 'EMPTY':
        return '内容是空的';
      case 'PARSE':
        return '页面结构变了，解析不出内容';
      default:
        return '抓取失败';
    }
  }
}

export function isSourcingError(err: unknown): err is SourcingError {
  return err instanceof SourcingError;
}
