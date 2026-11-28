// Proves our own sign-in (AUTH_MODE=own, frontend/src/lib/ownAuth.mjs and the pages' lib/ownAuthClient.js) works end to
// end on a running dashboard: sign in, who is signed in, the pages' data through /api/data with the cookie, Screened
// Tenders' "added by", a request passed on from another address of the dashboard (ALLOWED_ORIGINS), refusals, sign-out.
// A temporary account and a test Screened row are made in DATABASE_URL and removed at the end.
//   node --env-file=.env tools/check-own-signin.mjs http://127.0.0.1:3110 [allowed other origin]
// (the dashboard started with AUTH_MODE=own, DATA_BACKEND=pg and the same DATABASE_URL)
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connectionOptions } from '../frontend/src/lib/db/pgClient.mjs';
import { hashPassword } from '../frontend/src/lib/password.mjs';

const base = process.argv[2] || 'http://127.0.0.1:3110';
const forwarded = process.argv[3] || 'https://forwarded.example.app';
const pool = new pg.Pool(connectionOptions(process.env.DATABASE_URL));
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => (cond ? passed++ : (failed++, console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`)));

const login = `zz-own-${randomBytes(4).toString('hex')}@users.opportunity-radar.invalid`;
const password = randomBytes(15).toString('base64url');
const ref = `zz-own-${randomBytes(3).toString('hex')}`;
const { rows } = await pool.query('INSERT INTO app_users (login, password_hash, team) VALUES ($1, $2, true) RETURNING id', [login, await hashPassword(password)]);
const userId = rows[0].id;

const call = (path, { method = 'GET', body, cookie, origin = base } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' && origin ? { origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
const data = (table, steps, cookie, origin) => call('/api/data', { method: 'POST', body: { table, steps }, cookie, origin });

try {
  const wrong = await call('/api/auth/login', { method: 'POST', body: { login, password: 'not-the-password' } });
  ok('wrong password refused', wrong.status === 401 || wrong.status === 400, String(wrong.status));

  const res = await call('/api/auth/login', { method: 'POST', body: { login, password } });
  const set = res.headers.get('set-cookie') || '';
  const cookie = set.split(';')[0];
  const body = await res.json();
  ok('sign in', res.status === 200 && body.user?.app_metadata?.team === true && cookie.startsWith('gbs_session='), `${res.status} ${JSON.stringify(body)}`);
  ok('cookie is httpOnly', /HttpOnly/i.test(set));

  const me = await (await call('/api/auth/me', { cookie })).json();
  ok('who is signed in', me.user?.email === login, JSON.stringify(me));
  const nobody = await (await call('/api/auth/me')).json();
  ok('no cookie: nobody', nobody.user === null);

  const read = await (await data('hospitals', [['select', 'name'], ['limit', 2]], cookie)).json();
  ok('pages read with the cookie', Array.isArray(read.data) && read.data.length > 0, JSON.stringify(read).slice(0, 200));
  const noCookie = await data('hospitals', [['select', 'name'], ['limit', 2]]);
  ok('no cookie: refused', noCookie.status === 401, String(noCookie.status));

  const fromForwarded = await (await data('hospitals', [['select', 'name'], ['limit', 1]], cookie, forwarded)).json();
  ok('request passed on from the other address (allowed)', Array.isArray(fromForwarded.data), JSON.stringify(fromForwarded).slice(0, 200));
  const fromElsewhere = await data('hospitals', [['select', 'name'], ['limit', 1]], cookie, 'https://evil.example.com');
  ok('request from an unknown site: refused', fromElsewhere.status === 401 || fromElsewhere.status === 403, String(fromElsewhere.status));

  const added = await (await data('screened_tenders', [['upsert', { source: 'ps', ref, title: 'zz test', tender: {} }, { onConflict: 'source,ref', ignoreDuplicates: true }]], cookie)).json();
  ok('screened tender added', !added.error, JSON.stringify(added.error));
  const { rows: row } = await pool.query('SELECT added_by FROM screened_tenders WHERE source = $1 AND ref = $2', ['ps', ref]);
  ok('"added by" is the signed-in person', row[0]?.added_by === login, JSON.stringify(row));
  const removed = await (await data('screened_tenders', [['delete'], ['eq', 'source', 'ps'], ['eq', 'ref', ref]], cookie)).json();
  ok('screened tender removed', !removed.error, JSON.stringify(removed.error));

  const products = await call('/api/products', { cookie });
  ok('server route with the cookie (products)', products.status === 200, String(products.status));

  const out = await call('/api/auth/logout', { method: 'POST', cookie });
  ok('sign out', out.status === 200);
  const after = await data('hospitals', [['select', 'name'], ['limit', 1]], cookie);
  ok('after sign-out the old cookie is refused', after.status === 401, String(after.status));
} finally {
  await pool.query('DELETE FROM screened_tenders WHERE ref = $1', [ref]);
  await pool.query('DELETE FROM app_users WHERE id = $1', [userId]);
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
