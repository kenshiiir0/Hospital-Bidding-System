import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword, verifyNothing, verifyPassword, MAX_PASSWORD_LENGTH } from './password.mjs';
import { toLoginEmail } from './username.js';

// Our own dashboard sign-in, for a database without Supabase Auth (the private Coolify server). It is used
// only when AUTH_MODE=own; otherwise Supabase Auth stays in charge (auth.js) and none of this runs.
// Tables: app_users, app_sessions, app_login_attempts (schema.sql). Accounts: tools/add-user.js --own,
// or copied from Supabase with tools/import-auth-users.js (their passwords keep working).
//
// A session is a random 32-byte token in an httpOnly cookie; the database keeps only its SHA-256, so a copy
// of the database can't be used to sign in. Signing out deletes the row, which ends that session at once.
// Plain .mjs so tools/ (CommonJS) can import() it too.

export const OWN_AUTH = process.env.AUTH_MODE === 'own';
export const SESSION_COOKIE = 'gbs_session';
const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Wrong passwords: 5 for one account within 15 minutes pause that account's sign-in for 15 minutes; 20 from
// one address pause that address. A right password never counts.
const LIMITS = { windowMs: 15 * 60 * 1000, perLogin: 5, perIp: 20 };

let pool;
export function db() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('DATABASE_URL is not set: our own sign-in needs the database.');
  const { hostname, searchParams } = new URL(url);
  // Coolify's internal database (a host without dots) and localhost speak plain TCP; hosted ones need TLS
  const local = !hostname.includes('.') || hostname === 'localhost' || hostname === '127.0.0.1' || searchParams.get('sslmode') === 'disable';
  pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30_000 });
  return pool;
}

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const normalizeLogin = (login) => toLoginEmail(String(login || '').trim());

// The shape the API routes already use from Supabase: user.id, user.email, user.app_metadata.team
const asUser = (row) => ({ id: row.id, email: row.login, app_metadata: { team: row.team } });

// Pauses after too many wrong passwords; returns the minutes left, or 0
async function pausedMinutes(login, ip) {
  const { rows } = await db().query(
    `SELECT
       (SELECT array_agg(at ORDER BY at DESC) FROM app_login_attempts WHERE login = $1 AND NOT ok AND at > now() - $3::interval) AS by_login,
       (SELECT array_agg(at ORDER BY at DESC) FROM app_login_attempts WHERE ip = $2 AND NOT ok AND at > now() - $3::interval) AS by_ip`,
    [login, ip || '', `${LIMITS.windowMs} milliseconds`],
  );
  const left = (times, limit) => (times && times.length >= limit ? new Date(times[limit - 1]).getTime() + LIMITS.windowMs - Date.now() : 0);
  const ms = Math.max(left(rows[0].by_login, LIMITS.perLogin), ip ? left(rows[0].by_ip, LIMITS.perIp) : 0);
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

// { token, user, expires } on success, or { error, status }
export async function signIn(login, password, { ip = '', userAgent = '' } = {}) {
  const name = normalizeLogin(login);
  if (!name || typeof password !== 'string' || !password) return { error: 'Enter your username and password.', status: 400 };
  if (password.length > MAX_PASSWORD_LENGTH) return { error: 'Wrong username or password.', status: 401 };

  const minutes = await pausedMinutes(name, ip);
  if (minutes) return { error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, status: 429 };

  const { rows } = await db().query('SELECT id, login, password_hash, team, disabled FROM app_users WHERE login = $1', [name]);
  const row = rows[0];
  const check = row ? await verifyPassword(password, row.password_hash) : await verifyNothing(password);
  // A disabled account gets the same answer as a wrong password
  const ok = check.ok && !row.disabled;
  await db().query('INSERT INTO app_login_attempts (login, ip, ok) VALUES ($1, $2, $3)', [name, ip, ok]);
  if (!ok) return { error: 'Wrong username or password.', status: 401 };

  if (check.rehash) await db().query('UPDATE app_users SET password_hash = $2 WHERE id = $1', [row.id, await hashPassword(password)]);
  await db().query('UPDATE app_users SET last_sign_in_at = now() WHERE id = $1', [row.id]);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  await db().query('INSERT INTO app_sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5)', [
    tokenHash(token), row.id, expires, String(userAgent).slice(0, 300), ip,
  ]);
  cleanUp().catch(() => {});
  return { token, user: asUser(row), expires };
}

// The signed-in user behind a session token, or null. A session in use is renewed once less than half of it
// is left, so people who use the dashboard every week stay signed in.
export async function sessionUser(token) {
  if (!token || token.length > 100) return null;
  const hash = tokenHash(token);
  const { rows } = await db().query(
    `SELECT u.id, u.login, u.team, s.expires_at FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [hash],
  );
  if (!rows[0]) return null;
  if (new Date(rows[0].expires_at).getTime() - Date.now() < (SESSION_DAYS * DAY_MS) / 2) {
    await db().query('UPDATE app_sessions SET expires_at = $2, last_seen_at = now() WHERE token_hash = $1', [hash, new Date(Date.now() + SESSION_DAYS * DAY_MS)]);
  }
  return asUser(rows[0]);
}

export async function signOut(token) {
  if (token) await db().query('DELETE FROM app_sessions WHERE token_hash = $1', [tokenHash(token)]);
}

// Ends every session of an account (password reset, account disabled)
export async function signOutEverywhere(userId) {
  await db().query('DELETE FROM app_sessions WHERE user_id = $1', [userId]);
}

// Creates the account, or resets its password (and ends its sessions) when it exists. Returns 'created' | 'reset'.
export async function setPassword(login, password, { team = true } = {}) {
  const name = normalizeLogin(login);
  const hash = await hashPassword(password);
  const { rows } = await db().query(
    `INSERT INTO app_users (login, password_hash, team) VALUES ($1, $2, $3)
     ON CONFLICT (login) DO UPDATE SET password_hash = EXCLUDED.password_hash, team = EXCLUDED.team, disabled = false, password_changed_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [name, hash, team],
  );
  if (!rows[0].created) await signOutEverywhere(rows[0].id);
  return rows[0].created ? 'created' : 'reset';
}

// Old attempt rows and ended sessions are not needed (called on each sign-in, cheap with the indexes)
export async function cleanUp() {
  await db().query("DELETE FROM app_login_attempts WHERE at < now() - interval '30 days'");
  await db().query('DELETE FROM app_sessions WHERE expires_at < now()');
}

// --- Cookies and requests ---

export function readSessionToken(request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

// httpOnly: page scripts can't read it. SameSite=Lax: other sites can't send it with their requests.
// Secure everywhere except plain-http localhost (a team computer running the dashboard).
export function sessionCookie(request, token, expires) {
  const secure = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const parts = [`${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(token ? `Expires=${expires.toUTCString()}` : 'Max-Age=0');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clientIp = (request) => (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || '';

// A change (POST, PUT, ...) must come from the dashboard's own pages: a browser always sends Origin on those
export function sameOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
