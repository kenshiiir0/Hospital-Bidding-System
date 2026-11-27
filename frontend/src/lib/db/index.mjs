import { createClient } from '@supabase/supabase-js';
import { createPgClient, createPool } from './pgClient.mjs';
import { createDiskStorage } from './diskStorage.mjs';
import { createRemoteClient, readAnswer } from './remoteClient.mjs';
import { countDownload, downloadsOverBudget } from '../usageMeter.mjs';

// The server's database client, for every part of the code (API routes, Sync, reading, tools).
// DATA_BACKEND=pg: our own PostgreSQL client (pgClient.mjs) on DATABASE_URL, for the private server without
// Supabase. DATA_BACKEND=dashboard: through the dashboard (DASHBOARD_URL + /api/data, signed with CRON_SECRET), for
// programs outside the server (office log-in laptop, GitHub jobs) so the private database stays closed to the
// internet; the dashboard allows them only their own tables (app/api/data/route.js). Otherwise: Supabase with the
// secret key, as before. All three answer the same way, so the code doesn't need to know which one it has. Returns null when the settings are missing (callers already handle it).
// Plain .mjs so tools/ (CommonJS) can import() it too.

export const USES_PG = process.env.DATA_BACKEND === 'pg';

// One client per server process; kept on globalThis so Next's reloads in development don't open new pools
const shared = globalThis.__serverDb || (globalThis.__serverDb = {});

// STORAGE_BACKEND=disk: the bid documents are on this server's disk (DOCUMENTS_DIR, diskStorage.mjs) instead of Supabase
// Storage, whichever database is used; client.storage answers the same way, so callers don't change. Files from before
// the move are fetched from Supabase Storage the first time they are needed and kept on disk (diskStorage.mjs
// fallback), within the month's reading budget; STORAGE_FALLBACK=off once everything is on disk.
export const USES_DISK = process.env.STORAGE_BACKEND === 'disk';
const wrapped = new WeakMap();
function withStorage(client) {
  if (!client || !USES_DISK) return client;
  if (!wrapped.has(client)) {
    const root = process.env.DOCUMENTS_DIR;
    const missing = { error: { name: 'StorageError', message: 'DOCUMENTS_DIR is not set (STORAGE_BACKEND=disk).', statusCode: '500' }, data: null };
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const old = process.env.STORAGE_FALLBACK !== 'off' && url && process.env.SUPABASE_KEY
      ? (shared.storageFallback ||= createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }))
      : null;
    // The budget is kept in this database's usage_meter, as before
    const fallback = old && { storage: old.storage, overBudget: () => downloadsOverBudget(client), count: (bytes) => countDownload(client, bytes) };
    const storage = root ? createDiskStorage(root, fallback) : { local: true, from: () => new Proxy({}, { get: () => async () => missing }) };
    wrapped.set(client, new Proxy(client, {
      get(target, prop) {
        if (prop === 'storage') return storage;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
  }
  return wrapped.get(client);
}

export function serverDb() {
  return withStorage(pickDb());
}

function pickDb() {
  if (process.env.DATA_BACKEND === 'dashboard') {
    const base = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
    const secret = process.env.CRON_SECRET;
    if (!base || !secret) return null;
    shared.remote ||= createRemoteClient((body, signal) =>
      fetch(`${base}/api/data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
        signal,
      }).then(readAnswer),
    );
    return shared.remote;
  }
  if (USES_PG) {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    shared.pg ||= createPgClient(createPool(url));
    return shared.pg;
  }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) return null;
  shared.supabase ||= createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return shared.supabase;
}

// For tools and tests: closes the PostgreSQL pool so the process can end
export async function closeServerDb() {
  await shared.pg?.pool.end();
  shared.pg = null;
}
