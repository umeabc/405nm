/**
 * 图源解析器的接口。
 *
 * 一个解析器只做一件事：**把一个链接变成一串图片直链**。
 * 它不下载、不落库、不碰数据库 —— 那些是导入任务的事。
 * 这样切开有两个好处：
 *
 *  1. 解析器的输入输出都是纯数据，可以拿真实返回的 JSON 当夹具离线测；
 *  2. 上游接口变了（这些全是非官方接口，变是常态），只需要换掉某一个解析器，
 *     下载与入库那一路完全不受影响。
 */

export type SourceId =
  | 'twitter'
  | 'twitter_user'
  | 'bluesky'
  | 'bluesky_user'
  | 'pixiv'
  | 'pixiv_user'
  | 'external';

export const SOURCE_IDS: readonly SourceId[] = [
  'twitter',
  'twitter_user',
  'bluesky',
  'bluesky_user',
  'pixiv',
  'pixiv_user',
  'external',
];

export const SOURCE_LABELS: Readonly<Record<SourceId, string>> = {
  twitter: 'X / Twitter 单条推文',
  twitter_user: 'X / Twitter 某个人的全部媒体',
  bluesky: 'Bluesky 单条帖子',
  bluesky_user: 'Bluesky 某个人的全部媒体',
  pixiv: 'Pixiv 单个作品',
  pixiv_user: 'Pixiv 某个画师的全部作品',
  external: '图片直链',
};

export type SourcedImage = {
  /** 图片直链 */
  url: string;
  /**
   * 建议的文件名（含扩展名）。
   *
   * 导入时用**它在数组里的位置**生成排序键，而不是靠这个名字 ——
   * 上游给的文件名五花八门（有的带 hash、有的没有扩展名），
   * 拿它排序会出现 p1 / p10 / p2 这种乱序。
   */
  filename?: string;
  /**
   * 下载这张图时必须带的 Referer。
   *
   * ⚠️ `i.pximg.net` **不带 `https://www.pixiv.net/` 就是 403**（实测过）。
   * 这个头必须跟着图片走，不能当成图源级别的全局设置 ——
   * 一次导入里完全可能混着不同站点的图片。
   */
  referer?: string;
  /** 上游声明的尺寸。用来跳过占位图/头像这类明显不是正片的图。 */
  width?: number;
  height?: number;
};

export type SourceParseResult = {
  images: SourcedImage[];
  /** 上游给的标题，用作导入文件名与作品名的建议 */
  title?: string;
  /** 上游给的作者名 */
  author?: string;
  /** 上游的下一个游标（按用户批量时用来续抓） */
  nextCursor?: string;
  /**
   * 解析过程中的非致命提示，例如「该作者有 800 个作品，只取了最新 50 个」。
   * 这些**必须冒到界面上**：不声不响地截断会让人以为已经全导进来了。
   */
  notes?: string[];
};

export type ParseContext = {
  /** 这次抓取走的出口。`null` = 直连。 */
  proxyUrl: string | null;
  /**
   * 该图源账号的凭据（已解密）。键名由各解析器自己定，例如
   * X 的 `authToken` / `ct0`、Pixiv 的 `phpSessId`、Bluesky 的 `handle` / `appPassword`。
   */
  credentials: Readonly<Record<string, string>>;
  /** 按用户批量时最多取多少个作品/多少页，防止一次点下去抓几千张 */
  maxWorks: number;
  /** 单次解析最多返回多少张图片 */
  maxImages: number;
};

export type SourceParser = {
  readonly id: SourceId;
  /**
   * 认领一个链接。
   *
   * 只判断「是不是我的」，不判断「能不能解析成功」—— 后者要发请求才知道。
   * 注册表按顺序问每个解析器，第一个认领的胜出，所以**具体的规则要排在宽泛的前面**
   * （`external` 那种「凡是图片直链都算我的」必须放最后）。
   */
  match(url: URL): boolean;
  parse(url: URL, ctx: ParseContext): Promise<SourceParseResult>;
};
