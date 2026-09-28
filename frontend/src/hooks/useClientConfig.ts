import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

/**
 * 服务端参数（图片大小上限、缩略图尺寸等）。
 *
 * 模块级缓存 + 单飞：这些值在一次会话里不会变，多个组件同时挂载时
 * 只发一个请求 —— 否则工作台一渲染就是十几个组件各问一遍同一件事。
 */

export type ClientConfig = {
  maxImageMb: number;
  thumbSize: number;
  previewSize: number;
  storageDriver: string;
};

/** 兜底值：请求还没回来时先用它。与后端 env.ts 的默认值保持一致。 */
const FALLBACK: ClientConfig = {
  maxImageMb: 20,
  thumbSize: 520,
  previewSize: 2000,
  storageDriver: 'local',
};

let cache: ClientConfig | null = null;
let inflight: Promise<ClientConfig> | null = null;

function fetchConfig(): Promise<ClientConfig> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;

  inflight = apiRequest<ClientConfig>('/client-config')
    .then((config) => {
      cache = config;
      return config;
    })
    .catch(() => FALLBACK)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function useClientConfig(): ClientConfig {
  const [config, setConfig] = useState<ClientConfig>(cache ?? FALLBACK);

  useEffect(() => {
    let alive = true;
    void fetchConfig().then((next) => {
      if (alive) setConfig(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return config;
}
