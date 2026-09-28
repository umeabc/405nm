import { env } from '../env.js';
import type { StorageDriver } from './index.js';
import { LocalStorage } from './local.js';

/**
 * 驱动选择。v1 只有 local 一种，但**选择动作本身**放在这里 ——
 * 二期加 R2 / remote-HTTP 时，只改这个文件，加上 env 里的分支，
 * 调用方（上传、导出、成品、迁移）一行都不用动。
 *
 * 未知驱动名一律**启动即失败**而不是回落到 local：认不出配置就静默用磁盘，
 * 在对象存储的部署里会把图片写到容器本地盘上 —— 重启即丢，而且没人会发现。
 */
export function storageFor(driver: string, dir: string): StorageDriver {
  switch (driver) {
    case 'local':
      return new LocalStorage(dir);
    default:
      throw new Error(`未知的存储驱动：${driver}（v1 只支持 local）`);
  }
}

export const storage: StorageDriver = storageFor(env.STORAGE_DRIVER, env.STORAGE_DIR);
