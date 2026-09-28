import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * 存储格式：`scrypt$<saltHex>$<hashHex>`。
 * 前缀带算法名，是为了将来能平滑升级到 argon2id —— 校验时按前缀分派即可。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;

  const [algo, saltHex, hashHex] = parts;
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);

  // 长度不等时 timingSafeEqual 会抛，先挡掉。
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
