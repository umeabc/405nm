/**
 * 用户名与密码的校验规则。
 *
 * 规则与报错文案对标图译空间（它的 validateUsername / validatePassword），
 * 这样从彩翻过来的人看到的是同一套提示。校验函数返回**错误文案或 null**，
 * 而不是抛异常 —— 便于在 zod 的 refine 里直接用。
 */

/** 允许中文：组内有人用中文名当账号名，图译空间也是这么放开的。 */
const USERNAME_PATTERN = /^[\w.\-一-龥]+$/;

export function validateUsername(username: string): string | null {
  const value = username.trim();
  if (value.length < 3 || value.length > 32) return '用户名长度需为 3 ~ 32 个字符';
  if (!USERNAME_PATTERN.test(value)) {
    return '用户名只能包含字母、数字、下划线、点、连字符或中文';
  }
  return null;
}

/** 不设复杂度要求（图译空间也不设）—— 长度是唯一硬约束。 */
export function validatePassword(password: string): string | null {
  if (password.length < 8 || password.length > 128) return '密码长度需为 8 ~ 128 个字符';
  return null;
}

export function validateDisplayName(name: string): string | null {
  const value = name.trim();
  if (!value) return '请输入昵称';
  if (value.length > 32) return '昵称最多 32 个字符';
  return null;
}

/**
 * 邀请码字表排除易混字符（0/O、1/I/l），输出形如 `A3KM-9PQR-7XTY`，分段便于朗读核对。
 *
 * ⚠️ 与图译空间的一处刻意分歧：它的字表**含小写字母**，且比对是大小写敏感的 ——
 * 对方把码全打成小写就会被判「邀请码无效」。这里只用大写，
 * 配合 `normalizeInviteCode` 统一转大写，做到大小写不敏感。
 * 邀请码是要靠人念、靠手抄转发的，不该在大小写上卡人。
 */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) {
    raw += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

/** 用户输入的邀请码统一大写并去空格，避免「看起来一样却对不上」。 */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}
