// Copies the tables from Supabase (SUPABASE_DB_URL) into the private PostgreSQL (DATABASE_URL, the Coolify
// database). Run it in Coolify → the dashboard → Terminal (it opens in /app/frontend), where both are reachable:
//   node ../tools/copy-to-private-db.mjs              shows what would happen, changes nothing
//   node ../tools/copy-to-private-db.mjs --apply      first copy (stops if the private database already has rows)
//   node ../tools/copy-to-private-db.mjs --replace    copy again, replacing what the private database has (switch day)
//   node ../tools/copy-to-private-db.mjs --check      only compares both sides, table by table
// Supabase is only read, never written. Everything runs from one consistent moment of Supabase, and the private
// database gets it all in one transaction: if anything fails, nothing is kept there.
// Steps: (1) small stand-ins for Supabase's own parts that schema.sql mentions (auth.jwt(), realtime, storage, the
// API roles), so its access rules load on a plain PostgreSQL; (2) schema.sql; (3) every column compared;
// (4) the rows; (5) the id counters moved past the copied rows; (6) row count and fingerprint of every table compared.
// Supabase egress: one full read of the tables (about 50 MB). Don't run --replace again and again.
// Testing only: --sample N copies N rows per table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REPLACE = args.includes('--replace');
const CHECK = args.includes('--check');
const sampleAt = args.indexOf('--sample');
const SAMPLE = sampleAt >= 0 ? Number(args[sampleAt + 1]) : 0;
const CHUNK_BYTES = 4_000_000;
const LEFT_OUT = ['bid_document_tracker', 'hospital_contacts'];

// Same rule as frontend/src/lib/db/pgClient.mjs connectionOptions: sslmode in the address decides; without it a
// dotless host (Docker's internal names) or localhost is plain, anything else encrypted
function connect(url) {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  const local = !parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  parsed.searchParams.delete('sslmode');
  return new pg.Client({ connectionString: parsed.toString(), ssl: (mode ? mode === 'disable' : local) ? false : { rejectUnauthorized: false } });
}

const STUBS = `
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN CREATE PUBLICATION supabase_realtime; END IF;
END $$;
-- Nobody signs in through Supabase here: the access rules see no sign-in, and the dashboard connects as the owner
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$ SELECT NULL::jsonb $f$;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
CREATE TABLE IF NOT EXISTS realtime.messages (id BIGSERIAL PRIMARY KEY, topic TEXT, payload JSONB);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id TEXT PRIMARY KEY, name TEXT, public BOOLEAN DEFAULT false);
CREATE TABLE IF NOT EXISTS storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`;

const q = (name) => `"${name.replaceAll('"', '""')}"`;

async function tables(db) {
  const { rows } = await db.query(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name
       FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Map());
    out.get(r.table_name).set(r.column_name, `${r.data_type}/${r.udt_name}`);
  }
  return out;
}

// Row count and a fingerprint of all rows (order-free), over the columns both sides have
async function fingerprint(db, table, drop) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS f
       FROM (SELECT md5((to_jsonb(t) - $1::text[])::text) AS h FROM public.${q(table)} t) x`,
    [drop],
  );
  return rows[0];
}

async function main() {
  const from = process.env.SUPABASE_DB_URL;
  const to = process.env.DATABASE_URL;
  if (!from || !to) {
    console.log('Needs SUPABASE_DB_URL (Supabase, read only) and DATABASE_URL (the private database) in the settings.');
    process.exit(1);
  }
  const fromHost = new URL(from).hostname;
  const toHost = new URL(to).hostname;
  if (fromHost === toHost || /supabase\.(co|com)$/.test(toHost)) {
    console.log(`DATABASE_URL points at Supabase (${toHost}); it must be the private database. Nothing done.`);
    process.exit(1);
  }

  const src = connect(from);
  const dst = connect(to);
  for (const db of [src, dst]) db.on('error', (e) => console.error(`Connection lost: ${e.message}`));
  await src.connect();
  await dst.connect();
  for (const db of [src, dst]) await db.query("SET TimeZone = 'UTC'; SET statement_timeout = 0");
  // One moment of Supabase for everything read below
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const srcVersion = (await src.query('SHOW server_version')).rows[0].server_version;
  const dstVersion = (await dst.query('SHOW server_version')).rows[0].server_version;
  console.log(`Supabase: PostgreSQL ${srcVersion}   private database (${toHost}): PostgreSQL ${dstVersion}`);

  const srcTables = await tables(src);
  const counts = new Map();
  for (const t of srcTables.keys()) counts.set(t, (await src.query(`SELECT count(*)::int AS n FROM public.${q(t)}`)).rows[0].n);
  // Old tables made by hand on Supabase, never in schema.sql and not used by any code: left out while empty
  for (const t of LEFT_OUT) {
    if (counts.get(t) === 0) srcTables.delete(t), counts.delete(t), console.log(`Left out (empty, not used): ${t}`);
  }
  let dstTables = await tables(dst);
  const dstRows = new Map();
  for (const t of dstTables.keys()) dstRows.set(t, (await dst.query(`SELECT count(*)::int AS n FROM public.${q(t)}`)).rows[0].n);
  const filled = [...dstRows].filter(([, n]) => n > 0);

  if (!APPLY && !REPLACE && !CHECK) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log(`\nSupabase has ${srcTables.size} tables, ${total} rows:`);
    for (const [t, n] of counts) console.log(`  ${t.padEnd(34)} ${String(n).padStart(8)}`);
    console.log(`\nPrivate database: ${dstTables.size} of our tables, ${filled.length} with rows.`);
    console.log(filled.length ? 'It already has rows: --replace would replace them, --apply would stop.' : 'Empty: --apply will copy everything.');
    console.log('Nothing was changed.');
    await src.query('COMMIT');
    await Promise.all([src.end(), dst.end()]);
    return;
  }

  if (!CHECK) {
    if (APPLY && !REPLACE && filled.length) {
      console.log(`The private database already has rows (${filled.map(([t, n]) => `${t} ${n}`).join(', ')}).`);
      console.log('Use --replace to replace them with a fresh copy. Nothing done.');
      process.exit(1);
    }
    await dst.query('BEGIN');
    try {
      // Without it, the copy would run each table's triggers (updated_at stamps) and foreign-key checks
      await dst.query("SET LOCAL session_replication_role = 'replica'");
      console.log('\n1. Stand-ins for Supabase-only parts');
      await dst.query(STUBS);
      console.log('2. schema.sql');
      await dst.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
      dstTables = await tables(dst);

      console.log('3. Columns');
      const problems = [];
      for (const [t, cols] of srcTables) {
        const theirs = dstTables.get(t);
        if (!theirs) { problems.push(`table ${t} is not in schema.sql`); continue; }
        for (const [c, type] of cols) {
          if (!theirs.has(c)) problems.push(`${t}.${c} is not in schema.sql`);
          else if (theirs.get(c) !== type) problems.push(`${t}.${c}: ${type} on Supabase, ${theirs.get(c)} here`);
        }
      }
      if (problems.length) throw new Error(`schema.sql doesn't match Supabase:\n  ${problems.join('\n  ')}`);

      console.log(`4. Rows${SAMPLE ? ` (sample: ${SAMPLE} per table)` : ''}`);
      // Also with --apply: schema.sql puts starting rows in some tables (ocr_status, ps_sync_status, ...); Supabase's rows replace them
      await dst.query(`TRUNCATE ${[...srcTables.keys()].map((t) => `public.${q(t)}`).join(', ')}`);
      for (const [t, cols] of srcTables) {
        const extra = [...dstTables.get(t).keys()].filter((c) => !cols.has(c));
        const res = await src.query(`SELECT to_jsonb(t)::text AS r FROM public.${q(t)} t${SAMPLE ? ` LIMIT ${SAMPLE}` : ''}`);
        let chunk = [];
        let size = 0;
        const flush = async () => {
          if (!chunk.length) return;
          // Target's own column list: columns only it has keep their defaults
          const names = [...cols.keys()].map(q).join(', ');
          await dst.query(
            `INSERT INTO public.${q(t)} (${names}) OVERRIDING SYSTEM VALUE
             SELECT ${names} FROM jsonb_populate_recordset(NULL::public.${q(t)}, $1::jsonb)`,
            [`[${chunk.join(',')}]`],
          );
          chunk = [];
          size = 0;
        };
        for (const { r } of res.rows) {
          chunk.push(r);
          size += r.length;
          if (size >= CHUNK_BYTES) await flush();
        }
        await flush();
        console.log(`   ${t.padEnd(34)} ${String(res.rows.length).padStart(8)}${extra.length ? `   (only here: ${extra.join(', ')})` : ''}`);
      }

      console.log('5. Id counters');
      const serials = await dst.query(
        `SELECT table_name, column_name, pg_get_serial_sequence(format('public.%I', table_name), column_name) AS seq
           FROM information_schema.columns WHERE table_schema = 'public' AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
      );
      for (const { table_name: t, column_name: c, seq } of serials.rows) {
        if (seq) await dst.query(`SELECT setval($1, coalesce((SELECT max(${q(c)}) FROM public.${q(t)}), 0) + 1, false)`, [seq]);
      }
      await dst.query('COMMIT');
    } catch (e) {
      await dst.query('ROLLBACK').catch(() => {});
      console.log(`\nStopped, nothing kept in the private database: ${e.message}`);
      process.exit(1);
    }
    await dst.query('ANALYZE');
  }

  console.log(`\n6. Compare${SAMPLE ? ' (sample: row counts only)' : ''}`);
  dstTables = await tables(dst);
  let bad = 0;
  for (const [t, cols] of srcTables) {
    const theirs = dstTables.get(t);
    if (!theirs) { bad++; console.log(`   MISSING ${t}`); continue; }
    const onlyHere = [...theirs.keys()].filter((c) => !cols.has(c));
    const onlyThere = [...cols.keys()].filter((c) => !theirs.has(c));
    const a = SAMPLE ? { n: Math.min(SAMPLE, counts.get(t)) } : await fingerprint(src, t, onlyThere);
    const b = SAMPLE ? { n: (await dst.query(`SELECT count(*)::int AS n FROM public.${q(t)}`)).rows[0].n } : await fingerprint(dst, t, onlyHere);
    const ok = a.n === b.n && a.f === b.f;
    if (!ok) bad++;
    console.log(`   ${ok ? 'same     ' : 'DIFFERENT'} ${t.padEnd(34)} ${String(a.n).padStart(8)} | ${String(b.n).padStart(8)}`);
  }
  console.log(bad ? `\n${bad} table(s) differ.` : `\nAll ${srcTables.size} tables are the same on both sides.`);
  await src.query('COMMIT');
  await src.end();
  await dst.end();
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
