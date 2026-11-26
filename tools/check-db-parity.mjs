// Proves our own PostgreSQL client (frontend/src/lib/db/pgClient.mjs) answers exactly like Supabase's API: the same
// requests go through both, against the same Supabase database, and every answer is compared.
// Reads: a few rows of every table, and the filters the code uses. Writes: on a test table zz_db_parity that is
// created here and dropped at the end (real tables are never written). Small reads only (Supabase egress).
//   node --env-file=.env tools/check-db-parity.mjs
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { createPgClient, createPool } from '../frontend/src/lib/db/pgClient.mjs';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const pool = createPool(process.env.SUPABASE_DB_URL);
const ours = createPgClient(pool);
let failed = 0;
let passed = 0;

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
// Compares data, count and whether there was an error (error texts differ between the two, codes should not)
async function same(name, build) {
  const [a, b] = await Promise.all([build(sb), build(ours)]);
  const pick = (r) => sortKeys({ data: r.data, count: r.count ?? null, error: r.error ? r.error.code || 'error' : null });
  const x = pick(a);
  const y = pick(b);
  if (sameJson(x, y)) {
    passed++;
    return;
  }
  failed++;
  console.log(`FAIL ${name}`);
  const show = (v) => JSON.stringify(v).slice(0, 400);
  console.log(`  supabase: ${show(x)}`);
  console.log(`  ours:     ${show(y)}`);
  if (a.error) console.log(`  supabase error: ${a.error.message}`);
  if (b.error) console.log(`  our error: ${b.error.message}`);
}

const admin = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await admin.connect();
try {
  // --- every table: first rows in key order, and a row count ---
  const { rows: tables } = await admin.query(`
    SELECT c.relname AS t, (SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum))
      FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'zz_%' ORDER BY 1`);
  for (const { t, pk } of tables) {
    const heavy = ['document_text', 'ps_tender_analysis', 'philgeps_opportunities', 'ps_philgeps_snapshot'].includes(t);
    await same(`${t}: first rows`, (db) => {
      let q = db.from(t).select('*');
      for (const k of pk || []) q = q.order(k);
      return q.limit(heavy ? 2 : 5);
    });
    await same(`${t}: count`, (db) => db.from(t).select('*', { count: 'exact', head: true }));
  }

  // --- the kinds of reads the code does ---
  const now = new Date().toISOString();
  await same('or(closing_date is null / later) + not(matched eq {}) + json path', (db) =>
    db.from('philgeps_opportunities').select('ref_no, closing_date, matched_molecules, docs:details->documents')
      .not('matched_molecules', 'eq', '{}').or(`closing_date.is.null,closing_date.gt.${now}`).order('ref_no').limit(3));
  await same('->> path with alias', (db) => db.from('ps_sync_status').select('jid:job->>id, status:job->>status').limit(3));
  await same('not is null + order desc', (db) => db.from('activity_log').select('id, created_at').not('created_at', 'is', null).order('id', { ascending: false }).limit(4));
  await same('in() + order nulls last', (db) => db.from('hospitals').select('agency_key, name').in('agency_key', ['x-none', 'y-none']).order('name'));
  await same('range', (db) => db.from('activity_log').select('id').order('id').range(3, 6));
  await same('maybeSingle no row', (db) => db.from('hospitals').select('agency_key').eq('agency_key', '__none__').maybeSingle());
  await same('single no row (error)', (db) => db.from('hospitals').select('agency_key').eq('agency_key', '__none__').single());
  await same('maybeSingle many rows (error)', (db) => db.from('activity_log').select('id').limit(2).maybeSingle());
  await same('missing table (error)', (db) => db.from('zz_no_such_table').select('*'));
  await same('default 1000-row cap', (db) => db.from('activity_log').select('id').order('id'));

  // --- writes, on a test table ---
  await admin.query(`DROP TABLE IF EXISTS zz_db_parity;
    CREATE TABLE zz_db_parity (id INT PRIMARY KEY, name TEXT, big BIGINT, price NUMERIC, at TIMESTAMPTZ DEFAULT '2026-01-02T03:04:05.123456Z',
      day DATE, tags TEXT[], info JSONB, flag BOOLEAN DEFAULT true, note TEXT DEFAULT 'none');
    NOTIFY pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 4000));
  // Each client works on its own ids (offset 0 / 1000); answers are compared with the offset taken out
  const off = (db) => (db === ours ? 1000 : 0);
  const strip = (r) => ({ ...r, data: Array.isArray(r.data) ? r.data.map((x) => ({ ...x, id: x.id % 1000 })) : r.data && r.data.id ? { ...r.data, id: r.data.id % 1000 } : r.data });
  const w = (name, build) => same(name, async (db) => strip(await build(db, off(db))));
  const row = (o, id, extra = {}) => ({ id: id + o, name: `row ${id}`, big: 9007199254740, price: 12.5, day: '2026-11-27', tags: ['a', 'b c'], info: { list: [1, { x: 'y' }], n: null }, ...extra });

  await w('insert one, returning', (db, o) => db.from('zz_db_parity').insert(row(o, 1)).select());
  await w('insert list (missing keys become null)', (db, o) => db.from('zz_db_parity').insert([row(o, 2), { id: 3 + o, name: 'short' }]).select('id, name, note, flag, at'));
  await w('insert without select', (db, o) => db.from('zz_db_parity').insert({ id: 4 + o, info: [1, 2, 3] }));
  await w('duplicate key (error)', (db, o) => db.from('zz_db_parity').insert({ id: 1 + o }));
  await w('upsert updates', (db, o) => db.from('zz_db_parity').upsert({ id: 1 + o, name: 'changed', tags: [] }).select('id, name, tags, price'));
  await w('upsert ignoreDuplicates', (db, o) => db.from('zz_db_parity').upsert([{ id: 2 + o, name: 'kept?' }, { id: 5 + o, name: 'new' }], { onConflict: 'id', ignoreDuplicates: true }).select('id, name'));
  await w('update with filter', (db, o) => db.from('zz_db_parity').update({ note: 'edited', info: { a: 1 } }).gte('id', 2 + o).lte('id', 3 + o).select('id, note, info').order('id'));
  await w('update without filter (refused)', (db) => db.from('zz_db_parity').update({ note: 'x' }));
  await w('delete without filter (refused)', (db) => db.from('zz_db_parity').delete());
  await w('read back all', (db, o) => db.from('zz_db_parity').select('*').gte('id', o).lt('id', o + 1000).order('id'));
  await w('match + is + ilike', (db, o) => db.from('zz_db_parity').select('id').match({ flag: true }).is('day', null).ilike('name', 'SHORT').gte('id', o).lt('id', o + 1000));
  await w('delete returning', (db, o) => db.from('zz_db_parity').delete().eq('id', 3 + o).select('id'));
  await w('count after delete', (db, o) => db.from('zz_db_parity').select('id', { count: 'exact', head: true }).gte('id', o).lt('id', o + 1000));

  // --- database functions (read-only call: add 0 bytes to a test month, then remove it) ---
  await same('rpc add_read_bytes', (db) => db.rpc('add_read_bytes', { m: db === ours ? 'zz-test-b' : 'zz-test-a', b: 0 }));
} finally {
  await admin.query("DROP TABLE IF EXISTS zz_db_parity; DELETE FROM usage_meter WHERE month LIKE 'zz-test-%'; NOTIFY pgrst, 'reload schema';").catch(() => {});
  await admin.end();
  await pool.end();
}
console.log(`\n${passed} answers the same, ${failed} different.`);
process.exit(failed ? 1 : 0);
