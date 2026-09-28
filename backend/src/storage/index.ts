import type { Readable } from 'node:stream';

/**
 * 存储驱动接口。
 *
 * v1 只实现 local（磁盘），但接口从第一天就按「对象存储」的形状定 ——
 * R2 / remote-HTTP 驱动在二期只需实现这个接口，调用点一行都不用改。
 * 之所以现在就抽象，是因为**调用点会散落到各处**（上传、导出、成品、
 * 头像、迁移工具），等有了二十个调用点再抽象，就是二十次改动。
 *
 * 刻意**不提供** `url(key)` 之外的公网直链能力：local 驱动下图片必须
 * 经应用鉴权后才能读（见 api/routes/files.ts 的媒体路由），
 * 直接把磁盘目录暴露给 nginx 会绕过整套权限。
 */

export type StoredObject = {
  key: string;
  size: number;
};

export type ReadResult = {
  stream: Readable;
  size: number;
};

export type StorageUsage = {
  /** 用掉多少字节 */
  usedBytes: number;
  /** 磁盘总量 / 余量；对象存储类驱动返回 null（它没有「磁盘」的概念） */
  totalBytes: number | null;
  availableBytes: number | null;
  /** 对象个数 */
  objectCount: number;
  /** 统计耗时（毫秒），前端据此提示「数据可能有延迟」 */
  elapsedMs: number;
};

export interface StorageDriver {
  readonly id: string;

  /** 写入。**原子**：先写临时文件再 rename，避免半截文件被读走。 */
  put(key: string, data: Buffer): Promise<StoredObject>;

  /** 流式读取，供 HTTP 直接把字节喂给响应。不存在返回 null。 */
  openRead(key: string): Promise<ReadResult | null>;

  /** 整块读取，供需要 Buffer 的场景（B 站发布、打包）。不存在返回 null。 */
  getBuffer(key: string): Promise<Buffer | null>;

  stat(key: string): Promise<{ size: number } | null>;

  /** 删除。不存在视为成功（幂等）。 */
  remove(key: string): Promise<void>;

  /** 删除一批。批量删是为了少开几次 IO，不是为了事务性。 */
  removeMany(keys: readonly string[]): Promise<void>;

  usage(): Promise<StorageUsage>;
}

export type { ImageVariant } from './keys.js';
export { storage, storageFor } from './registry.js';
export {
  ALLOWED_IMAGE_EXTS,
  IMAGE_VARIANTS,
  STORAGE_PREFIX,
  isAllowedImageExt,
  monthShard,
  newAvatarKey,
  newFileKey,
  newSiteBrandKey,
  safeImageExt,
  variantKey,
} from './keys.js';
