/**
 * 发布平台适配层。
 *
 * v1 只实现 B 站；微博 / X 只留接口 —— 但接口现在就按「会有多个平台」的形状定，
 * 因为发布动作的**重试语义**是跨平台通用的（见下面的 `ambiguous`），
 * 而这套语义一旦散落到各平台实现里，就会有人写错。
 */

export type PlatformId = 'bilibili';

export type PlatformProfile = {
  uid: string;
  name: string;
  avatarUrl: string;
};

/** 传到平台图床之后拿到的引用。发布时要把这些回填进请求体 */
export type PlatformImage = {
  /** 平台侧的图片地址 */
  src: string;
  width: number;
  height: number;
  size: number;
};

export type TopicOption = { id: string; name: string; statDesc?: string };
export type MentionOption = { uid: string; name: string; face?: string; fans?: number };

export type PublishContext = {
  credentials: Record<string, string>;
  /**
   * **确定性的**上传标识，由任务的幂等键派生。
   *
   * 旧实现（380nm）每次调用都 `crypto.randomBytes(16)` 现生成一个 ——
   * 于是「重试」永远是一次全新的上传，图片这一步根本没有幂等性可言。
   * 由任务派生之后，同一条任务重试时用的是同一个 id。
   */
  uploadId: string;
};

export type PublishDraft = {
  text: string;
  title?: string;
  images: PlatformImage[];
  topic?: { id: string | number; name: string } | null;
  mentions?: Array<{ name: string; uid: string }>;
};

/**
 * 平台错误。
 *
 * 两个标志位是**这套设计里最重要的东西**，它们的区别决定了失败之后
 * 到底是「重试」还是「交人工」：
 *
 *  - `retryable`：这次失败**确定没有产生副作用**，重试是安全的。
 *    例如平台明确回了一个业务错误码 —— 它告诉我们它没做。
 *  - `ambiguous`：**不确定有没有产生副作用**。最典型的是网络超时：
 *    请求可能已经到达并被处理了，只是响应没回来。这种情况下重试就是
 *    **可能发出第二条动态**，必须交人工确认。
 *
 * 把这两件事混成一个 `retryable` 是旧实现最危险的简化：
 * 它让「超时」变成了「自动重发」。
 */
export class PlatformError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(code: string, message: string, options: { retryable: boolean; ambiguous: boolean }) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.retryable = options.retryable;
    this.ambiguous = options.ambiguous;
  }
}

export type VerifyResult = { ok: boolean; profile?: PlatformProfile; error?: string };

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly label: string;

  /** 用凭据换一次身份。**通过才允许覆盖已存的凭据**。 */
  verifyCredential(credentials: Record<string, string>): Promise<VerifyResult>;

  /** 上传一张图，拿到发布时要回填的引用。 */
  uploadImage(ctx: PublishContext, image: { buffer: Buffer; filename: string; contentType: string }): Promise<PlatformImage>;

  searchTopic?(ctx: PublishContext, keyword: string): Promise<TopicOption[]>;
  searchMention?(ctx: PublishContext, keyword: string): Promise<MentionOption[]>;

  /** 真正发出去。**这一步没有幂等参数，是整条链路上唯一不可撤销的动作。** */
  publish(ctx: PublishContext, draft: PublishDraft): Promise<{ externalId: string; url: string }>;
}
