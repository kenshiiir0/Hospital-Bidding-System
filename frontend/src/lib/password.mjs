import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Password hashing for our own dashboard sign-in (ownAuth.mjs). New passwords: scrypt (Node built-in) with a
// random salt per password, stored as "scrypt$N$r$p$salt$hash" (base64url). Accounts copied from Supabase
// keep their bcrypt hash ($2a$...), so nobody needs a new password; it is replaced by scrypt at the next
// sign-in. Plain .mjs so tools/ (CommonJS) can import() it too.
const scrypt = promisify(scryptCallback);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
// scrypt needs 128 * N * r bytes (32 MiB here); Node's default limit is exactly that, so allow some room
const MAX_MEMORY = 64 * 1024 * 1024;
// Hashing a very long input costs time: refuse anything beyond this before hashing
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`);
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

// { ok, rehash }: rehash = the password was right but is stored in an older form (bcrypt, weaker scrypt)
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH || typeof stored !== 'string') return { ok: false, rehash: false };
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash || '', 'base64url');
    if (!expected.length) return { ok: false, rehash: false };
    const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEMORY,
    });
    const ok = timingSafeEqual(actual, expected);
    return { ok, rehash: ok && (Number(n) < N || Number(r) !== R || Number(p) !== P) };
  }
  // Supabase (GoTrue) stores bcrypt; it hashes the password as typed, without normalising
  if (/^\$2[aby]\$\d\d\$/.test(stored)) {
    const { default: bcrypt } = await import('bcryptjs');
    const ok = await bcrypt.compare(password, stored);
    return { ok, rehash: ok };
  }
  return { ok: false, rehash: false };
}

// Spends the same time as checking a real password, for a sign-in to an account that doesn't exist, so the
// answer time doesn't tell which accounts exist
const DUMMY = hashPassword(randomBytes(12).toString('base64url')).catch(() => null);
export async function verifyNothing(password) {
  const stored = await DUMMY;
  if (stored) await verifyPassword(String(password || 'x').slice(0, MAX_PASSWORD_LENGTH), stored);
  return { ok: false, rehash: false };
}
