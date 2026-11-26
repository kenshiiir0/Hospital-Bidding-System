import { createClient } from '@supabase/supabase-js';
import { createPgClient, createPool } from './pgClient.mjs';

// The server's database client, for every part of the code (API routes, Sync, reading, tools).
// DATA_BACKEND=pg: our own PostgreSQL client (pgClient.mjs) on DATABASE_URL, for the private server without
// Supabase. Otherwise: Supabase with the secret key, as before. Both answer the same way, so the code
// doesn't need to know which one it has. Returns null when the settings are missing (callers already handle it).
// Plain .mjs so tools/ (CommonJS) can import() it too.

export const USES_PG = process.env.DATA_BACKEND === 'pg';

// One client per server process; kept on globalThis so Next's reloads in development don't open new pools
const shared = globalThis.__serverDb || (globalThis.__serverDb = {});

export function serverDb() {
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
