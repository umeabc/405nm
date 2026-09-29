/**
 * AI 机翻与术语库的接口封装。
 *
 * 一条贯穿全文件的约定：**提案（propose）与应用（apply）是两次独立请求**。
 * 前端不提供「一键静默应用」—— 模型给的东西一定要有人看过才落库，
 * 否则「AI 帮了多少忙」不可度量，出错也无从追溯。
 */
import { apiRequest } from './client';

export type AiProvider = {
  id: string;
  name: string;
  baseUrl: string;
  chatModel: string;
  visionModel: string;
  isDefault: boolean;
  enabled: boolean;
  credentials: Record<string, string>;
  proxyUrl: string;
  hasKey: boolean;
};

export type ProviderInput = {
  name: string;
  baseUrl: string;
  chatModel?: string;
  visionModel?: string;
  /** 省略 = 不改动已存的 key；空串 = 清掉 */
  apiKey?: string;
  proxyUrl?: string;
  isDefault?: boolean;
  enabled?: boolean;
};

export type MarkerProposal = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  positionType: 'in' | 'out';
};

export type MarkerProposeResult = {
  proposals: MarkerProposal[];
  skipped: number;
  dropped: number;
  model: string;
  existing: number;
};

export type TranslationProposal = {
  sourceId: string;
  original: string;
  translated: string;
  terms: string[];
};

export type TranslateProposeResult = {
  proposals: TranslationProposal[];
  glossary: Array<{ source: string; target: string }>;
  missing: number;
  model: string;
  requested: number;
};

export type TermBank = { id: string; name: string; intro: string; termCount: number };
export type TermRow = { id: string; bankId: string; language: string; source: string; target: string; note: string };

export const aiApi = {
  providers: () => apiRequest<{ providers: AiProvider[]; site: { defaultProxyConfigured: boolean } }>('/ai/providers'),
  createProvider: (input: ProviderInput) => apiRequest<{ provider: AiProvider }>('/ai/providers', { method: 'POST', body: input }),
  updateProvider: (id: string, input: Partial<ProviderInput>) =>
    apiRequest<{ provider: AiProvider }>(`/ai/providers/${id}`, { method: 'PATCH', body: input }),
  removeProvider: (id: string) => apiRequest<{ ok: boolean }>(`/ai/providers/${id}`, { method: 'DELETE' }),

  proposeMarkers: (fileId: string, body: { providerId?: string | null; hint?: string }) =>
    apiRequest<MarkerProposeResult>(`/files/${fileId}/ai/markers/propose`, { method: 'POST', body }),
  applyMarkers: (fileId: string, markers: MarkerProposal[]) =>
    apiRequest<{ created: number }>(`/files/${fileId}/ai/markers`, { method: 'POST', body: { markers } }),

  proposeTranslations: (fileId: string, body: { targetId: string; providerId?: string | null }) =>
    apiRequest<TranslateProposeResult>(`/files/${fileId}/ai/translations/propose`, { method: 'POST', body }),
  applyTranslations: (fileId: string, body: { targetId: string; items: Array<{ sourceId: string; translated: string }> }) =>
    apiRequest<{ created: number; updated: number; skipped: Array<{ sourceId: string; reason: string }> }>(
      `/files/${fileId}/ai/translations`,
      { method: 'POST', body },
    ),
};

export const termApi = {
  banks: (teamId: string) => apiRequest<{ banks: TermBank[] }>(`/teams/${teamId}/term-banks`),
  createBank: (teamId: string, body: { name: string; intro?: string }) =>
    apiRequest<{ bank: TermBank }>(`/teams/${teamId}/term-banks`, { method: 'POST', body }),
  removeBank: (bankId: string) => apiRequest<{ ok: boolean }>(`/term-banks/${bankId}`, { method: 'DELETE' }),
  terms: (bankId: string, query: { language?: string; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (query.language) search.set('language', query.language);
    if (query.q) search.set('q', query.q);
    const suffix = search.toString();
    return apiRequest<{ bank: TermBank; terms: TermRow[] }>(`/term-banks/${bankId}/terms${suffix ? `?${suffix}` : ''}`);
  },
  addTerms: (bankId: string, body: { language: string; text?: string; source?: string; target?: string }) =>
    apiRequest<{ count: number }>(`/term-banks/${bankId}/terms`, { method: 'POST', body }),
  removeTerm: (termId: string) => apiRequest<{ ok: boolean }>(`/terms/${termId}`, { method: 'DELETE' }),
};
