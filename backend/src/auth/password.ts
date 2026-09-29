import { pbkdf2 as pbkdf2Cb, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;
const pbkdf2 = promisify(pbkdf2Cb);

const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * 存储格式：`scrypt$<saltHex>$<hashHex>`。
 * 前缀带算法名，是为了将来能平滑升级到 argon2id —— 校验时按前缀分派即可。
 *
 * 另外**只读地**认得 moeflow（werkzeug 3）的两种格式，让迁移过来的账号能用原密码登录：
 *   `scrypt:<N>:<r>:<p>$<salt>$<hex>`、`pbkdf2:<hash>:<iterations>$<salt>$<hex>`
 * 登录成功后由调用方用 `needsRehash()` 判断并换成本站格式 —— 旧格式只进不出。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [algo, salt, hashHex] = parts;
  if (!algo || !salt || !hashHex || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  const derived =
    algo === 'scrypt'
      ? await scrypt(password, Buffer.from(salt, 'hex'), expected.length)
      : await deriveWerkzeug(algo, password, salt, expected.length);

  // 长度不等时 timingSafeEqual 会抛，先挡掉。
  if (!derived || derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** 不是本站当前格式（例如迁移来的 werkzeug 哈希）→ 登录成功后应重新哈希。 */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith('scrypt$');
}

/** 给 `users.password_algo` 用的算法标签。 */
export function passwordAlgoOf(stored: string): string {
  const head = stored.split('$')[0] ?? '';
  if (head === 'scrypt') return 'scrypt';
  if (head.startsWith('scrypt:')) return 'werkzeug-scrypt';
  if (head.startsWith('pbkdf2:')) return 'werkzeug-pbkdf2';
  return 'unknown';
}

// 参数上限：库里的哈希串理论上可被篡改，不能让一条记录把登录接口拖成 DoS。
// werkzeug 3 的默认值是 scrypt N=2^15 r=8 p=1、pbkdf2 60 万轮，上限留足余量即可。
const MAX_SCRYPT_N = 1 << 20;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const PBKDF2_DIGESTS = new Set(['sha1', 'sha224', 'sha256', 'sha384', 'sha512']);

/**
 * 复刻 werkzeug `_hash_internal`：salt 按 **UTF-8 字符串**参与运算（不做 hex 解码），
 * 摘要以 hex 存储。无法识别或参数越界 → 返回 null（按校验失败处理）。
 */
async function deriveWerkzeug(
  method: string,
  password: string,
  salt: string,
  keylen: number,
): Promise<Buffer | null> {
  const [name, ...args] = method.split(':');
  const ints = args.map((a) => (/^\d+$/.test(a) ? Number(a) : Number.NaN));

  if (name === 'scrypt') {
    const [n = 2 ** 15, r = 8, p = 1] = ints;
    if (args.length > 3 || ![n, r, p].every(Number.isSafeInteger)) return null;
    if (n < 2 || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0) return null;
    if (r < 1 || r > MAX_SCRYPT_R || p < 1 || p > MAX_SCRYPT_P) return null;
    // Node 默认 maxmem 只有 32 MiB，而 N=2^15、r=8 恰好需要 32 MiB 出头；按实际需求放宽。
    const maxmem = 128 * n * r * p + 32 * 1024 * 1024;
    return scrypt(password, salt, keylen, { N: n, r, p, maxmem });
  }

  if (name === 'pbkdf2') {
    const digest = args[0] ?? 'sha256';
    const iterations = args.length >= 2 ? ints[1] : 600_000;
    if (args.length > 2 || !PBKDF2_DIGESTS.has(digest)) return null;
    if (!iterations || !Number.isSafeInteger(iterations) || iterations > MAX_PBKDF2_ITERATIONS) return null;
    return pbkdf2(password, salt, iterations, keylen, digest);
  }

  return null;
}
