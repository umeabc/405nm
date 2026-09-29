import type { PlatformAdapter, PlatformId } from './adapter.js';
import { bilibiliAdapter } from './bilibili.js';

/**
 * 平台注册表。
 *
 * v1 只有 B 站。加平台时**只动这一个文件** —— 路由、队列、前端都按
 * `PlatformAdapter` 接口编程，不认识具体实现。
 */

const ADAPTERS: readonly PlatformAdapter[] = [bilibiliAdapter];

const BY_ID = new Map<string, PlatformAdapter>(ADAPTERS.map((a) => [a.id, a]));

export const PLATFORM_IDS: readonly PlatformId[] = ADAPTERS.map((a) => a.id);

export function platformById(id: string): PlatformAdapter | undefined {
  return BY_ID.get(id);
}

/** 供界面下拉用。 */
export function listPlatforms(): Array<{ id: string; label: string }> {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label }));
}

/**
 * 取适配器，取不到就抛。
 *
 * 库里存的是平台 id 字符串，理论上可能出现「数据里有、代码里没有」的情况
 * （回滚了代码版本、或迁移进来一个未实现的平台）。那种时候要**明确报错**，
 * 而不是回落到 B 站 —— 把内容发到错误的平台是最糟的失败方式。
 */
export function requirePlatform(id: string): PlatformAdapter {
  const adapter = BY_ID.get(id);
  if (!adapter) {
    throw new Error(`不支持发布到「${id}」：本版本只实现了 ${PLATFORM_IDS.join('、')}`);
  }
  return adapter;
}
