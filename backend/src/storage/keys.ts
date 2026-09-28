/**
 * 存储键的构造与派生。
 *
 * 键的形态是有讲究的，不是随手拼字符串：
 *
 *  - **按前缀分域**：`files/`（原图）、`outputs/`（成品）、`user-avatars/`、
 *    `team-avatars/`、`site-brand/`。将来接入 R2 或 remote-HTTP 驱动时，
 *    生命周期策略（保留多久、能否公开访问）是按前缀定的，所以前缀必须先立规矩。
 *  - **按年月分目录**：`files/202609/<uuid>.jpg`。彩翻的老库是 7 万个文件平铺在
 *    一个目录里，`ls` 一次要好几秒，备份同步也难做增量。新库直接分片，
 *    以后不用再为「历史目录搬家」写一次性脚本。
 *  - **缩略图/预览图由原图键派生**，不单独落列：两者必须永远对得上，
 *    分开存就多一个可能不一致的地方。
 *
 * ⚠️ 派生规则是**我们自己的约定**，不承诺与旧站（moeflow）一致 ——
 * 迁移是按字节搬到新键，不搬键名。所以改这个文件不会破坏迁移，
 * 但会让**已有数据**的派生键对不上，必须同时写数据迁移。
 */

export const STORAGE_PREFIX = {
  files: 'files/',
  outputs: 'outputs/',
  userAvatars: 'user-avatars/',
  teamAvatars: 'team-avatars/',
  siteBrand: 'site-brand/',
} as const;

/** 图片变体。`orig` 不是派生键，它就是 `storage_key` 本身。 */
export type ImageVariant = 'thumb' | 'preview';

export const IMAGE_VARIANTS: readonly ImageVariant[] = ['thumb', 'preview'];

const VARIANT_PREFIX: Record<ImageVariant, string> = {
  thumb: 'cover-',
  preview: 'preview-',
};

/**
 * 变体一律存 WebP。
 *
 * 原图不动（保真、留证据），派生图转 WebP 是纯粹为了省流量与内存：
 * 一张 20MB 的 PNG 原图，520px 的 WebP 缩略图通常不到 40KB，
 * 一个 36 页的作品列表从「几十 MB」降到「一 MB 出头」。
 */
const VARIANT_EXT: Record<ImageVariant, string> = {
  thumb: '.webp',
  preview: '.webp',
};

/** `files/202609/abc.jpg` + thumb → `files/202609/cover-abc.webp` */
export function variantKey(key: string, variant: ImageVariant): string {
  const slash = key.lastIndexOf('/');
  const dir = slash >= 0 ? key.slice(0, slash + 1) : '';
  const base = slash >= 0 ? key.slice(slash + 1) : key;

  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;

  return `${dir}${VARIANT_PREFIX[variant]}${stem}${VARIANT_EXT[variant]}`;
}

/** 允许上传的图片扩展名。**白名单**，不是黑名单 —— 黑名单永远漏。 */
export const ALLOWED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'] as const;

export function isAllowedImageExt(ext: string): boolean {
  return (ALLOWED_IMAGE_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * 从原始文件名里取扩展名（已小写、已校验）。取不到或不合法时抛错 ——
 * 调用方要给出「这个文件类型不支持」的提示，而不是静默存成一个没有后缀的文件。
 */
export function safeImageExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (!isAllowedImageExt(ext)) {
    throw new Error(`不支持的图片格式：${ext || '（无扩展名）'}`);
  }
  return ext;
}

/** 年月分片：`202609`。用本地时间还是 UTC？用 UTC —— 服务器时区不该影响键的分布。 */
export function monthShard(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/** 新上传原图的键：`files/<yyyymm>/<uuid><ext>`。 */
export function newFileKey(uuid: string, ext: string, now: Date = new Date()): string {
  return `${STORAGE_PREFIX.files}${monthShard(now)}/${uuid}${ext}`;
}

/** 头像类键（不带分片：头像数量比图片少两个数量级，分片反而多一层目录）。 */
export function newAvatarKey(kind: 'user' | 'team', uuid: string, ext: string): string {
  const prefix = kind === 'user' ? STORAGE_PREFIX.userAvatars : STORAGE_PREFIX.teamAvatars;
  return `${prefix}${uuid}${ext}`;
}

export function newSiteBrandKey(type: string, uuid: string, ext: string): string {
  return `${STORAGE_PREFIX.siteBrand}${type}-${uuid}${ext}`;
}
