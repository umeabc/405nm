import { z } from 'zod';

/**
 * 环境变量在进程启动时一次性校验。缺关键项就让进程直接起不来 ——
 * 比起跑起来之后在某个请求里 500，启动即失败要好排查得多。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** 会话 token 的哈希胡椒（不是签名密钥，会话是不透明令牌）。至少 32 字符。 */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET 至少 32 字符'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * 会话 Cookie 是否带 Secure。缺省跟随 NODE_ENV（生产开启）。
   *
   * 仅用于**内网 HTTP 测试环境**：浏览器不会保存带 Secure 的 Cookie，
   * 于是「登录看似成功、一刷新就掉登录态」。生产环境必须保持默认（开启）。
   */
  COOKIE_SECURE: z.preprocess(
    // compose 里用 ${COOKIE_SECURE:-} 传进来的是空串，要当成「未设置」。
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),

  /** 存储驱动。v1 只实现 local；R2 / remote-http 在二期加到 storage/registry.ts。 */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  /** 图片落盘的根目录；v1 用 local 存储驱动。 */
  STORAGE_DIR: z.string().default('./uploads'),
  /** 单张图片大小上限（MB）。彩翻的图多为 3–8MB，20MB 留足余量。 */
  MAX_IMAGE_MB: z.coerce.number().int().positive().default(20),
  /**
   * 成品图大小上限（MB）。**刻意比原图宽松**：成品是 PS 嵌完字导出的整页图，
   * 同样是 2000×3000，带文字与描边的 PNG 能到几十 MB，用原图那道上限
   * 会把正常的成品挡在门外 —— 而嵌字的人已经干完活了，被挡回去最伤士气。
   */
  MAX_OUTPUT_MB: z.coerce.number().int().positive().default(60),
  /** 缩略图长边（像素） */
  THUMB_SIZE: z.coerce.number().int().positive().default(520),
  /** 预览图长边（像素）。翻校画布用的就是它，2000 足够看清小字。 */
  PREVIEW_SIZE: z.coerce.number().int().positive().default(2000),
  /** sharp 全局并发上限。sharp 吃内存，不设限会 OOM —— 小内存机器上尤其致命。 */
  IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // ── 发布 ──────────────────────────────────────────────────
  /**
   * 发布动作的超时（毫秒）。
   *
   * **刻意给得比较长**：B 站的发布接口没有幂等参数，超时对我们来说是**歧义**——
   * 请求可能已经发出去并成功了。超时给短了会频繁制造「需要人工确认」的任务；
   * 宁可多等一会儿拿到明确结果，也不要把不确定当常态。
   */
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  /** 任务被认领后的租约时长（分钟）。worker 崩了由下一个 tick 回收 */
  PUBLISH_LEASE_MINUTES: z.coerce.number().int().positive().default(10),
  /** 一个 tick 最多认领几条 */
  PUBLISH_BATCH: z.coerce.number().int().positive().default(3),
  /** Cookie 巡检间隔（分钟） */
  PUBLISH_COOKIE_CHECK_MINUTES: z.coerce.number().int().positive().default(30),

  // ── 限流 ──────────────────────────────────────────────────
  // 注册要挡两件事：有人暴力猜邀请码，以及有人批量刷号。
  // 单 IP 与全站各一个窗口，全站那个是兜底，防止换 IP 绕过。
  // 默认值与图译空间保持一致：单 IP 3 次、全站 30 次。
  REGISTER_MAX_PER_IP: z.coerce.number().int().positive().default(3),
  REGISTER_MAX_GLOBAL: z.coerce.number().int().positive().default(30),
  /** 登录**失败**次数上限（成功即清零），不是请求次数。 */
  LOGIN_MAX_FAILS: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),

  // ── 图源抓取 ──────────────────────────────────────────────
  /**
   * 抓取用的出口代理。**留空 = 直连**。
   *
   * 部署环境的出口到 Pixiv / X / i.pximg.net 的**直连是不通的**（那几个域名的
   * DNS 应答被污染成无关的地址，连 Google 都解析错），所以内网部署必须配上它。
   *
   * ⚠️ 这个值是**内网拓扑**，仓库是公开的 —— 具体地址只写在各部署机的
   * `deploy/.env`（已被 gitignore），**不要**写进 `.env.example`、compose 或文档。
   *
   * 协议由 impit 支持：http / https / socks4 / socks5。
   * 这里只校验「解析得出一个带 host 的 URL」——写错了就让进程起不来，
   * 比跑到第一次抓取才报错好。
   */
  SOURCING_PROXY: z.preprocess(
    // compose 里用 ${SOURCING_PROXY:-} 传进来的是空串，要当成「未设置」。
    (v) => (v === '' || v === undefined ? undefined : v),
    z
      .string()
      .refine((value) => {
        try {
          return new URL(value).host !== '';
        } catch {
          return false;
        }
      }, 'SOURCING_PROXY 必须是一个完整的代理地址，例如 http://主机:端口')
      .optional(),
  ),
  /** 单次抓取请求的超时（毫秒）。图源接口偶尔很慢，20s 是留了余量的值。 */
  SOURCING_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  /** 抓取并发上限。调高会被上游判定为爬虫，也会先把自己的出口压垮。 */
  SOURCING_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // ── AI 机翻（M8）────────────────────────────────────────
  /** 单次模型调用超时（毫秒）。看图识别的响应通常比纯文字慢得多，默认给足 2 分钟。 */
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  /** 模型调用并发。按人计费的通道不适合默默并发，默认 2。 */
  AI_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /**
   * 送给模型的术语表上限（条）。
   *
   * 术语表是**整库命中**的：库里几千条术语全塞进 prompt，既贵又会让模型走神。
   * 做法与图译空间一致 —— 只带**这一批原文里真的出现过的**词（子串命中），
   * 且总数不超过这个上限，超了就按「长词优先」截断。
   */
  AI_GLOSSARY_LIMIT: z.coerce.number().int().positive().default(150),
  /** 一页最多接收多少个识别结果，防止模型吐回一大串噪声把库写满。 */
  AI_MAX_MARKERS: z.coerce.number().int().positive().default(60),
  /**
   * 图源凭据的加密密钥。**没配就从 SESSION_SECRET 派生**。
   *
   * 生产上建议单独配：派生虽然能用，但换 SESSION_SECRET 会让已存的凭据
   * 全部解不开（表现为「凭据突然全失效」），两件事绑在一起是个隐患。
   */
  CREDENTIAL_KEY: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string().min(16, 'CREDENTIAL_KEY 至少 16 字符').optional(),
  ),
  /** 按用户批量时，单个链接最多展开多少个作品/多少页。防止一次点下去抓几千张。 */
  IMPORT_MAX_WORKS: z.coerce.number().int().positive().default(50),
  /** 单个链接最多导入多少张图。 */
  IMPORT_MAX_IMAGES: z.coerce.number().int().positive().default(500),
  /** worker 每次 tick 最多认领几个导入任务。 */
  IMPORT_BATCH: z.coerce.number().int().positive().default(2),
  /** 导入任务的租约时长（分钟）。worker 崩了之后由下一个 tick 回收。 */
  IMPORT_LEASE_MINUTES: z.coerce.number().int().positive().default(15),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // 刻意用 console 而不是 logger：env 校验失败时 logger 可能还没初始化。
  console.error(`环境变量校验失败：\n${issues}\n\n请参考仓库根目录的 .env.example。`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** 只在显式配置时覆盖，否则跟随运行环境。 */
export const cookieSecure =
  env.COOKIE_SECURE === undefined ? isProduction : env.COOKIE_SECURE === 'true';
