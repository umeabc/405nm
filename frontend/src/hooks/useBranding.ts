import { useEffect, useState } from 'react';
import { siteApi, type SiteBranding } from '../api/client';

/**
 * 站点品牌（站名 / 标语 / 立绘）。
 *
 * 与 `useClientConfig` 同一套「模块级缓存 + 单飞」的做法，但**多一个订阅**：
 * 后台改完站名或传完立绘后要立刻生效，不能等用户刷新页面。所以这里带了
 * 一个极小的发布订阅 —— 只订阅这一个不可变对象，用不着引入状态库。
 *
 * 另一处与 `useClientConfig` 的区别：兜底值**刻意做得比后端稀薄**。
 * 站名与标语的真正默认值只在后端定义一份（`domain/site-settings.ts`），
 * 前端再抄一份的话，改默认值时必然漏掉一处 —— 症状是「后台改了、登录页没变」，
 * 而且只在接口恰好失败的那条路径上暴露。这里的兜底只保证「页面不空白」，
 * 不承诺与后端默认值一致。
 */
const FALLBACK: SiteBranding = {
  name: '405nm',
  englishName: '',
  slogan: '',
  description: '',
  footer: '',
  hasMascot: false,
  mascotUrl: null,
};

let cache: SiteBranding | null = null;
let inflight: Promise<SiteBranding> | null = null;
const listeners = new Set<(branding: SiteBranding) => void>();

function publish(next: SiteBranding): void {
  cache = next;
  for (const listener of listeners) listener(next);
}

function fetchBranding(): Promise<SiteBranding> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;

  inflight = siteApi
    .branding()
    .then((res) => {
      cache = res.branding;
      return res.branding;
    })
    .catch(() => FALLBACK)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/**
 * 后台改完品牌后调用。
 *
 * 传 `next` 就用新值立刻广播（写接口都返回了完整的 branding，不必再问一次后端）；
 * 不传则清空缓存，下次读取重新拉。
 */
export function invalidateBranding(next?: SiteBranding): void {
  if (next) {
    publish(next);
    return;
  }
  cache = null;
  inflight = null;
}

export function useBranding(): SiteBranding {
  const [branding, setBranding] = useState<SiteBranding>(cache ?? FALLBACK);

  useEffect(() => {
    listeners.add(setBranding);
    let alive = true;
    void fetchBranding().then((next) => {
      if (alive) setBranding(next);
    });
    return () => {
      alive = false;
      listeners.delete(setBranding);
    };
  }, []);

  return branding;
}
