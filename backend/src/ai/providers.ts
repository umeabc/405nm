/**
 * 模型配置的读写。**每人的 key 只对自己可见、只被自己用**。
 *
 * 与图源凭据共用一套加密（`lib/credentials.ts`）：同一个 `CREDENTIAL_KEY`，
 * 同样的「解不开就当没配」。密钥进日志、进接口一律掩码。
 */
import { and, desc, eq } from 'drizzle-orm';
import type { DbLike } from '../db/client.js';
import { db } from '../db/client.js';
import { aiProviders } from '../db/schema.js';
import { decryptCredentials, encryptCredentials, maskCredentials } from '../lib/credentials.js';
import { badRequest, notFound } from '../lib/errors.js';
import { maskProxy } from '../sourcing/http.js';
import type { AiProviderConfig } from './client.js';

export type PublicProvider = {
  id: string;
  name: string;
  baseUrl: string;
  chatModel: string;
  visionModel: string;
  isDefault: boolean;
  enabled: boolean;
  /** `{ apiKey: '…abcd' }`，没有 key 时是空对象 */
  credentials: Record<string, string>;
  /** 带用户名密码的代理地址会在这里被掩码 */
  proxyUrl: string;
  hasKey: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function toPublicProvider(row: typeof aiProviders.$inferSelect): PublicProvider {
  const masked = maskCredentials(row.credentials);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    chatModel: row.chatModel,
    visionModel: row.visionModel,
    isDefault: row.isDefault,
    enabled: row.enabled,
    credentials: masked,
    proxyUrl: row.proxyUrl ? maskProxy(row.proxyUrl) : '',
    hasKey: Boolean(decryptCredentials(row.credentials).apiKey),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listProviders(userId: string, tx: DbLike = db) {
  return tx.select().from(aiProviders).where(eq(aiProviders.userId, userId)).orderBy(desc(aiProviders.isDefault), desc(aiProviders.createdAt));
}

/**
 * 取一份可直接用来发请求的配置。
 *
 * `providerId` 省略时用「默认的那份」；一份都没有就抛出**说清楚该去配什么**的错误 ——
 * 「机翻点了没反应」最恼人的形态就是只回一句「失败」。
 */
export async function loadProviderConfig(userId: string, providerId?: string | null): Promise<AiProviderConfig> {
  const rows = providerId
    ? await db.select().from(aiProviders).where(and(eq(aiProviders.id, providerId), eq(aiProviders.userId, userId))).limit(1)
    : await db
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.userId, userId), eq(aiProviders.enabled, true)))
        .orderBy(desc(aiProviders.isDefault), desc(aiProviders.createdAt))
        .limit(1);

  const row = rows[0];
  if (!row) throw notFound('没有可用的模型配置，请先到「个人资料 → AI 机翻」里添加一个', 'AI_PROVIDER_MISSING');
  if (!row.enabled) throw badRequest('这份模型配置已被停用', 'AI_PROVIDER_DISABLED');

  const apiKey = decryptCredentials(row.credentials).apiKey ?? '';
  if (!apiKey) throw badRequest('这份模型配置没有填 API Key', 'AI_PROVIDER_NO_KEY');

  return {
    id: row.id,
    baseUrl: row.baseUrl,
    apiKey,
    chatModel: row.chatModel,
    visionModel: row.visionModel,
    proxyUrl: row.proxyUrl,
  };
}

/** 写入 apiKey；`undefined` 表示「这次不改 key」，空串表示「清掉 key」。 */
export function credentialsPatch(apiKey: string | undefined, previous: string): string {
  if (apiKey === undefined) return previous;
  return apiKey === '' ? '' : encryptCredentials({ apiKey });
}
