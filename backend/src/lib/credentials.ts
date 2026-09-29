import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../env.js';

/**
 * 图源凭据的加解密。
 *
 * 这些是**别人的账号凭据**（X 的 auth_token、Pixiv 的 PHPSESSID、Bluesky 的 app password）。
 * 明文落库的后果不只是「被拖库时多泄露一份」—— 用户会拿同一个 Cookie 干别的事，
 * 泄露一次等于连带泄露他别处的登录态。所以哪怕 v1 只有本地存储驱动，也必须加密。
 *
 * 算法用 AES-256-GCM：它是**带认证**的（密文被改过会解密失败，而不是悄悄解出一段垃圾），
 * 这一点比 CBC 重要 —— 密钥轮换或数据被截断时，宁可报错也不能拿错误数据去发请求。
 *
 * 密钥来源：优先 `CREDENTIAL_KEY`；没配就从 `SESSION_SECRET` 派生。
 * 派生是**有代价的**：换 SESSION_SECRET 会让已存的凭据全部解不开
 * （表现为「凭据突然全失效」）。所以生产上应当单独配 `CREDENTIAL_KEY`。
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 的标准长度
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = env.CREDENTIAL_KEY || env.SESSION_SECRET;
  const info = env.CREDENTIAL_KEY ? 'nm405:credential-key:v1' : 'nm405:derived-from-session-secret:v1';
  // hkdf 而不是直接 hash：把「拿会话密钥派生凭据密钥」这件事和别的用途隔开，
  // 免得同一个密钥在不同场景下被复用出问题。
  cachedKey = Buffer.from(hkdfSync('sha256', secret, 'nm405-credentials', info, 32));
  return cachedKey;
}

/** 加密一个字符串字典。空对象直接返回空串（等同于「没配凭据」）。 */
export function encryptCredentials(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string' && v !== '',
  );
  if (entries.length === 0) return '';

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const plaintext = JSON.stringify(Object.fromEntries(entries));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // iv | tag | 密文，一起 base64。存成一列比分三列省事，也不会出现「只更新了密文忘了 tag」。
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * 解密。**解不开就返回空对象，而不是抛错**。
 *
 * 理由：密文解不开的原因有「换了 SESSION_SECRET」「数据被改」等，
 * 无论哪种，正确行为都是「当作没配凭据」—— 让抓取以匿名身份继续跑（多数图源匿名可用），
 * 而不是让整次导入因为一个陈旧的凭据字段直接崩掉。
 * 真的影响到抓取时，错误会在下游以 `BLOCKED` / `UNSUPPORTED` 的形式出现，那是可解释的。
 */
export function decryptCredentials(payload: string | null | undefined): Record<string, string> {
  if (!payload) return {};
  try {
    const raw = Buffer.from(payload, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) return {};

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const data = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 给界面看的掩码视图：**只回答「配没配」与「末尾几位」**。
 *
 * 绝不回传明文，也不回传可逆的片段 —— API 与日志里出现的就是这个形状。
 * 留着后 4 位是为了让管理员能对上「我配的是哪一个」，这是唯一的用途。
 */
export function maskCredentials(payload: string | null | undefined): Record<string, string> {
  const plain = decryptCredentials(payload);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(plain)) {
    out[k] = v.length <= 4 ? '••••' : `••••${v.slice(-4)}`;
  }
  return out;
}

/** 只判断有没有配，不解密。列表接口用它，避免为了显示一个布尔值去解所有人的凭据。 */
export function hasCredentials(payload: string | null | undefined): boolean {
  return typeof payload === 'string' && payload.length > 0;
}
