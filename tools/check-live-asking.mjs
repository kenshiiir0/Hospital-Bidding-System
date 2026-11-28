// Proves the pages' live updates without Supabase Realtime (frontend/src/lib/liveAsk.mjs, used by lib/live.js with
// the private database) report what changed and nothing else. Uses our own PostgreSQL client on a test table
// zz_live_check (made here, dropped at the end), then, with --watch-readings, watches the real ps_tender_analysis for a
// minute (read only) to see readings saved meanwhile (e.g. by OCR) arrive.
//   node --env-file=.env tools/check-live-asking.mjs [--watch-readings]
import { createPgClient, createPool } from '../frontend/src/lib/db/pgClient.mjs';
import { createAsker } from '../frontend/src/lib/liveAsk.mjs';

const pool = createPool(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
const db = createPgClient(pool);
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => (cond ? passed++ : (failed++, console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

await pool.query('DROP TABLE IF EXISTS zz_live_check');
await pool.query(`CREATE TABLE zz_live_check (id BIGSERIAL PRIMARY KEY, v TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
try {
  await pool.query(`INSERT INTO zz_live_check (v) VALUES ('before 1'), ('before 2')`);
  const seen = [];
  const byTime = createAsker(db, { table: 'zz_live_check', since: 'updated_at', everyMs: 0, onChange: (p) => seen.push(p.new) });
  await byTime.ask(true);
  ok('start: rows already there are not reported', seen.length === 0, JSON.stringify(seen));
  await byTime.ask(true);
  ok('nothing changed: nothing reported', seen.length === 0);
  await pause(5);
  await pool.query(`INSERT INTO zz_live_check (v) VALUES ('new')`);
  await byTime.ask(true);
  ok('a new row is reported', seen.length === 1 && seen[0].v === 'new', JSON.stringify(seen));
  await pause(5);
  await pool.query(`UPDATE zz_live_check SET v = 'changed', updated_at = clock_timestamp() WHERE v = 'before 1'`);
  await byTime.ask(true);
  ok('a changed row is reported', seen.length === 2 && seen[1].v === 'changed', JSON.stringify(seen));
  await byTime.ask(true);
  ok('reported once only', seen.length === 2);
  await pause(5);
  await pool.query(`INSERT INTO zz_live_check (v) SELECT 'many ' || g FROM generate_series(1, 5) g`);
  await byTime.ask(true);
  ok('several at once, in order', seen.length === 7 && seen.slice(2).every((r, i) => r.v === `many ${i + 1}`), JSON.stringify(seen.slice(2).map((r) => r.v)));

  const byId = [];
  const ids = createAsker(db, { table: 'zz_live_check', since: 'id', everyMs: 0, select: 'id, v', onChange: (p) => byId.push(p.new) });
  await ids.ask(true);
  await pool.query(`INSERT INTO zz_live_check (v) VALUES ('by id')`);
  await ids.ask(true);
  ok('by id: the new row, only the asked columns', byId.length === 1 && byId[0].v === 'by id' && !('updated_at' in byId[0]), JSON.stringify(byId));

  const whole = [];
  const one = createAsker(db, { table: 'zz_live_check', everyMs: 0, select: 'id, v', filter: (q) => q.eq('v', 'changed'), onChange: (p) => whole.push(p.new) });
  await one.ask(true);
  await one.ask(true);
  ok('one-row table: unchanged, nothing reported', whole.length === 0);
  await pool.query(`UPDATE zz_live_check SET v = 'changed' WHERE v = 'changed'`);
  await one.ask(true);
  ok('one-row table: same content, nothing reported', whole.length === 0);
  await pool.query(`INSERT INTO zz_live_check (v) VALUES ('changed')`);
  await one.ask(true);
  ok('one-row table: a difference is reported', whole.length === 2, JSON.stringify(whole));

  const slow = [];
  const timed = createAsker(db, { table: 'zz_live_check', since: 'id', everyMs: 60_000, onChange: (p) => slow.push(p.new) });
  await timed.ask(true);
  await pool.query(`INSERT INTO zz_live_check (v) VALUES ('later')`);
  await timed.ask();
  ok('not asked again before its time', slow.length === 0);
  await timed.ask(true);
  ok('asked when shown again (forced)', slow.length === 1);
} finally {
  await pool.query('DROP TABLE IF EXISTS zz_live_check');
}

if (process.argv.includes('--watch-readings')) {
  const readings = [];
  const watcher = createAsker(db, { table: 'ps_tender_analysis', since: 'analyzed_at', select: 'ref, status, analyzed_at', everyMs: 0, onChange: (p) => readings.push(p.new) });
  await watcher.ask(true);
  for (let i = 0; i < 6; i++) {
    await pause(10_000);
    await watcher.ask(true);
  }
  console.log(`Readings saved during the minute: ${readings.length}${readings.length ? ` (${readings.map((r) => r.ref).join(', ')})` : ''}`);
}

await pool.end();
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
