import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { publishAccounts, type PublishAccount } from '../db/schema.js';
import { encryptCredentials, decryptCredentials, hasCredentials, maskCredentials } from '../lib/credentials.js';
import { requirePlatform } from '../platforms/registry.js';

/**
 * 发布账号的领域逻辑。
 *
 * 一条贯穿全文件的规则：**凭据只写不读**。
 *  - 写入前先向平台校验，**通不过就不覆盖**（否则一次手滑就把能用的 Cookie 弄坏了）；
 *  - 对外输出一律走 `serializeAccount`，它只给掩码，永远不给明文。
 */

export type AccountView = {
  id: string;
  teamId: string;
  platform: string;
  label: string;
  platformUid: string;
  platformName: string;
  avatarUrl: string;
  enabled: boolean;
  cookieStatus: string;
  cookieCheckedAt: string | null;
  cookieMessage: string;
  /** 掩码后的凭据，例如 `{ sessdata: '••••ab12', biliJct: '••••cd34' }` */
  credentials: Record<string, string>;
  hasCredentials: boolean;
  createdAt: string;
};

/** 对外序列化 —— **这里是凭据不外泄的唯一收口点**。 */
export function serializeAccount(row: PublishAccount): AccountView {
  return {
    id: row.id,
    teamId: row.teamId,
    platform: row.platform,
    label: row.label,
    platformUid: row.platformUid,
    platformName: row.platformName,
    avatarUrl: row.avatarUrl,
    enabled: row.enabled,
    cookieStatus: row.cookieStatus,
    cookieCheckedAt: row.cookieCheckedAt ? row.cookieCheckedAt.toISOString() : null,
    cookieMessage: row.cookieMessage,
    credentials: maskCredentials(row.credentials),
    hasCredentials: hasCredentials(row.credentials),
    createdAt: row.createdAt.toISOString(),
  };
}

export type SaveCredentialsResult =
  | { ok: true; account: PublishAccount; profile: { uid: string; name: string; avatarUrl: string } }
  | { ok: false; error: string };

/**
 * 保存（或覆盖）凭据。**先校验，通过才写。**
 *
 * 顺序不能反过来：先写再校验的话，一次错误的粘贴会**覆盖掉正在用的凭据**，
 * 而那条 Cookie 可能还有半年有效期 —— 用户会突然发现定时任务全挂了，
 * 却不知道为什么。旧实现（380nm）就是先校验后覆盖，这条沿用。
 */
export async function saveCredentials(
  account: PublishAccount,
  credentials: Record<string, string>,
): Promise<SaveCredentialsResult> {
  let adapter;
  try {
    adapter = requirePlatform(account.platform);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '平台不可用' };
  }

  const verified = await adapter.verifyCredential(credentials);
  if (!verified.ok || !verified.profile) {
    // 校验失败**原样保留旧凭据**，只把状态记下来
    await db
      .update(publishAccounts)
      .set({
        cookieStatus: 'expired',
        cookieCheckedAt: new Date(),
        cookieMessage: verified.error ?? '校验未通过',
        updatedAt: new Date(),
      })
      .where(eq(publishAccounts.id, account.id));
    return { ok: false, error: verified.error ?? '凭据校验未通过' };
  }

  const rows = await db
    .update(publishAccounts)
    .set({
      credentials: encryptCredentials(credentials),
      platformUid: verified.profile.uid,
      platformName: verified.profile.name,
      avatarUrl: verified.profile.avatarUrl,
      cookieStatus: 'ok',
      cookieCheckedAt: new Date(),
      cookieMessage: '',
      updatedAt: new Date(),
    })
    .where(eq(publishAccounts.id, account.id))
    .returning();

  const updated = rows[0];
  if (!updated) return { ok: false, error: '账号不存在' };
  return { ok: true, account: updated, profile: verified.profile };
}

/** 手动校验一次（不换凭据，只更新状态）。 */
export async function verifyAccount(account: PublishAccount): Promise<{ ok: boolean; error?: string }> {
  const credentials = decryptCredentials(account.credentials);
  if (!credentials.sessdata) {
    await db
      .update(publishAccounts)
      .set({ cookieStatus: 'expired', cookieCheckedAt: new Date(), cookieMessage: '凭据为空或解不开，请重新录入', updatedAt: new Date() })
      .where(eq(publishAccounts.id, account.id));
    return { ok: false, error: '凭据为空或解不开，请重新录入 Cookie' };
  }

  let adapter;
  try {
    adapter = requirePlatform(account.platform);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '平台不可用' };
  }

  const result = await adapter.verifyCredential(credentials);
  await db
    .update(publishAccounts)
    .set({
      cookieStatus: result.ok ? 'ok' : 'expired',
      cookieCheckedAt: new Date(),
      cookieMessage: result.ok ? '' : (result.error ?? '校验未通过'),
      // 校验通过时顺带刷新展示用的身份 —— 账号可能改过名或换过头像
      ...(result.ok && result.profile
        ? {
            platformUid: result.profile.uid,
            platformName: result.profile.name,
            avatarUrl: result.profile.avatarUrl,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(publishAccounts.id, account.id));

  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

export type CookieCheckReport = { checked: number; ok: number; expired: number };

/**
 * 批量巡检。由 worker 的 `cookieLoop` 定期调用（启动 8 秒后一次，之后按配置间隔）。
 *
 * 只查**启用的**账号：停用的账号查了也没意义，还会平白多打几次平台接口。
 * 单个账号失败**不影响其它账号** —— 一个账号的 Cookie 过期不该让巡检停在它那里。
 */
export async function checkAllAccounts(log: (msg: string, extra?: object) => void): Promise<CookieCheckReport> {
  const rows = await db
    .select()
    .from(publishAccounts)
    .where(eq(publishAccounts.enabled, true));

  const report: CookieCheckReport = { checked: 0, ok: 0, expired: 0 };

  for (const account of rows) {
    try {
      const result = await verifyAccount(account);
      report.checked += 1;
      if (result.ok) report.ok += 1;
      else {
        report.expired += 1;
        // 状态**翻转**时才吭声：每分钟都报一遍「Cookie 过期」会把日志淹掉，
        // 真正需要被看到的反而沉底了。
        if (account.cookieStatus !== 'expired') {
          log('[publish] 发布账号的 Cookie 已失效', {
            accountId: account.id,
            label: account.label,
            reason: result.error,
          });
        }
      }
    } catch (err) {
      log('[publish] 巡检账号失败', {
        accountId: account.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/** 团队里可用的发布账号（发布时的下拉）。 */
export async function listUsableAccounts(teamId: string) {
  return db
    .select()
    .from(publishAccounts)
    .where(and(eq(publishAccounts.teamId, teamId), eq(publishAccounts.enabled, true)));
}
