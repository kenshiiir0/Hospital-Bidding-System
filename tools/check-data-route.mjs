// Proves /api/data (the pages' reads through our own server, for the private database) answers like Supabase
// does for the pages today, and refuses what the database refuses them. A temporary team account is made for
// the test and deleted at the end; it only signs out locally. Reads are small (Supabase egress). No real rows
// are written: the write rules are checked with requests that must be refused.
//   node --env-file=.env tools/check-data-route.mjs http://localhost:3107
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const base = process.argv[2] || 'http://localhost:3107';
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, opts);
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
let passed = 0;
let failed = 0;

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

// Records a query like lib/supabase.js does in the browser
function recorder(table) {
  const steps = [];
  const q = new Proxy({}, { get: (_, name) => (...args) => (steps.push([name, ...JSON.parse(JSON.stringify(args))]), q) });
  return { q, steps, table };
}

const email = `zz-data-route-${randomBytes(4).toString('hex')}@users.opportunity-radar.invalid`;
const password = randomBytes(18).toString('base64url');
const { data: made, error: makeError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { team: true } });
if (makeError) throw makeError;
try {
  const { data: signed, error: signError } = await anon.auth.signInWithPassword({ email, password });
  if (signError) throw signError;
  const token = signed.session.access_token;
  const direct = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } });
  const viaServer = async (table, steps, auth = token) => {
    const res = await fetch(`${base}/api/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ table, steps }),
    });
    return { httpStatus: res.status, ...(await res.json()) };
  };

  async function same(name, table, build) {
    const r = recorder(table);
    build(r.q);
    const [a, b] = await Promise.all([build(direct.from(table)), viaServer(table, r.steps)]);
    const pick = (x) => sortKeys({ data: x.data ?? null, count: x.count ?? null, error: x.error ? x.error.code || 'error' : null });
    if (JSON.stringify(pick(a)) === JSON.stringify(pick(b))) return passed++;
    failed++;
    console.log(`FAIL ${name}\n  supabase: ${JSON.stringify(pick(a)).slice(0, 300)}\n  server:   ${JSON.stringify(pick(b)).slice(0, 300)}`);
    if (b.error) console.log(`  server error: ${b.error.message}`);
  }
  async function refused(name, table, steps, auth) {
    const b = await viaServer(table, steps, auth);
    if (b.error || b.httpStatus >= 400) return passed++;
    failed++;
    console.log(`FAIL ${name}: not refused (${JSON.stringify(b).slice(0, 200)})`);
  }

  // --- the pages' reads (same shapes as app/page.js, Sidebar, PsPortal, psData, screened, HistoryView, HospitalLinks) ---
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  await same('general tenders page', 'philgeps_opportunities', (q) =>
    q.select('id, ref_no, closing_date, title, notice_type:details->>notice_type').eq('matched_molecules', '{}').order('id', { ascending: false }).range(0, 4));
  await same('matched count (head)', 'philgeps_opportunities', (q) => q.select('id', { count: 'exact', head: true }).not('matched_molecules', 'eq', '{}'));
  await same('recent matched', 'philgeps_opportunities', (q) => q.select('id, created_at').not('matched_molecules', 'eq', '{}').gte('created_at', since).order('id').limit(5));
  await same('updated since', 'philgeps_opportunities', (q) => q.select('id, ref_no, updated_at').gt('updated_at', since).order('id').limit(3));
  await same('screened refs', 'screened_tenders', (q) => q.select('ref').eq('source', 'philgeps').order('ref'));
  await same('screened all', 'screened_tenders', (q) => q.select('source, ref, title').order('ref').limit(10));
  await same('ps sync status', 'ps_sync_status', (q) => q.select('status, error, stage, percent, started_at, started_by').eq('id', 'latest').maybeSingle());
  await same('snapshot stamp', 'ps_philgeps_snapshot', (q) => q.select('updated_at').eq('id', 'latest').maybeSingle());
  await same('readings', 'ps_tender_analysis', (q) => q.select('ref, status, documents_read, analyzed_at').order('ref').limit(5));
  await same('reading accuracy path', 'ps_tender_analysis', (q) => q.select('ref, accuracy:result->accuracy, documents_read').order('ref').limit(3));
  await same('hospital maybeSingle none', 'hospitals', (q) => q.select('*').eq('agency_key', '__none__').maybeSingle());
  await same('hospitals list', 'hospitals', (q) => q.select('agency_key, name, status').not('status', 'is', null).order('name').limit(5));
  await same('in()', 'philgeps_opportunities', (q) => q.select('ref_no').in('ref_no', ['__a__', '__b__']));
  await same('ocr status', 'ocr_status', (q) => q.select('*').limit(2));
  await same('abstracts', 'bid_abstracts', (q) => q.select('*').limit(2));
  const { data: one } = await admin.from('screened_tenders').select('ref').eq('source', 'ps').limit(1);
  if (one?.[0]) await same('quoted json key', 'ps_philgeps_snapshot', (q) => q.select(`documents:notices->"${one[0].ref}"->documents`).eq('id', 'latest').maybeSingle());

  // --- what the pages may not do ---
  await refused('not signed in', 'hospitals', [['select', 'name'], ['limit', 1]], null);
  await refused('wrong token', 'hospitals', [['select', 'name'], ['limit', 1]], 'not-a-token');
  await refused('table not readable (ps session cookies)', 'ps_session', [['select', '*']]);
  await refused('table not readable (accounts)', 'app_users', [['select', '*']]);
  await refused('embedding another table', 'hospitals', [['select', 'name, app_users(*)'], ['limit', 1]]);
  await refused('write to products', 'products', [['insert', { generic_name: 'zz' }]]);
  await refused('update screened tenders', 'screened_tenders', [['update', { title: 'zz' }], ['eq', 'ref', '__none__']]);
  await refused('upsert screened without ignoreDuplicates', 'screened_tenders', [['upsert', { source: 'ps', ref: '__none__' }]]);
  await refused('delete hospitals', 'hospitals', [['delete'], ['eq', 'agency_key', '__none__']]);
  await refused('delete without filter', 'screened_tenders', [['delete']]);
  await refused('unknown step', 'hospitals', [['select', '*'], ['csv']]);
  await anon.auth.signOut({ scope: 'local' });

  // --- programs outside the server (DATA_BACKEND=dashboard, signed with CRON_SECRET): the PS-PhilGEPS log-in ---
  process.env.DATA_BACKEND = 'dashboard';
  process.env.DASHBOARD_URL = base;
  const { serverDb } = await import('../frontend/src/lib/db/index.mjs');
  const program = serverDb();
  async function sameAsProgram(name, build) {
    const [a, b] = await Promise.all([build(admin), build(program)]);
    const pick = (x) => sortKeys({ data: x.data ?? null, count: x.count ?? null, error: x.error ? x.error.code || 'error' : null });
    if (JSON.stringify(pick(a)) === JSON.stringify(pick(b))) return passed++;
    failed++;
    console.log(`FAIL ${name}\n  supabase: ${JSON.stringify(pick(a)).slice(0, 300)}\n  program:  ${JSON.stringify(pick(b)).slice(0, 300)}`);
    if (b.error) console.log(`  program error: ${b.error.message}`);
  }
  const programRefused = async (name, build) => {
    const r = await build(program);
    if (r.error) return passed++;
    failed++;
    console.log(`FAIL ${name}: not refused (${JSON.stringify(r).slice(0, 200)})`);
  };
  await sameAsProgram('log-in asked (relay status fields)', (db) => db.from('philgeps_sync_relay').select('jid:job->>id, status:job->>status, host:job->>host').eq('id', 'ps-connect').maybeSingle());
  await sameAsProgram('connected at', (db) => db.from('ps_sync_status').select('connected_at').eq('id', 'latest').maybeSingle());
  const day = new Date(Date.now() - 86400_000).toISOString();
  await sameAsProgram('log-in attempts', (db) => db.from('login_attempts').select('at, outcome').eq('site', 'ps-philgeps').gte('at', day).order('at', { ascending: false }).limit(5));
  // The real log-in rules code, through the dashboard
  // (a paused log-in is a correct answer too; only a failed database read is not)
  const { checkLogin, LoginGuardError } = await import('../frontend/src/lib/loginGuard.mjs');
  await checkLogin('ps-philgeps').then(() => passed++, (e) => (e instanceof LoginGuardError ? passed++ : (failed++, console.log(`FAIL loginGuard: ${e.message}`))));
  // A write on a test row of the relay table (removed at the end)
  const testRow = { id: 'zz-relay-test', job: { status: 'test' }, updated_at: new Date().toISOString() };
  const w = await program.from('philgeps_sync_relay').upsert(testRow);
  const back = await admin.from('philgeps_sync_relay').select('job').eq('id', 'zz-relay-test').maybeSingle();
  if (!w.error && back.data?.job?.status === 'test') passed++;
  else failed++, console.log(`FAIL relay upsert: ${w.error?.message || 'row not written'}`);
  await admin.from('philgeps_sync_relay').delete().eq('id', 'zz-relay-test');

  await programRefused('read the saved session', (db) => db.from('ps_philgeps_session').select('*'));
  await programRefused('session upsert with rows back', (db) => db.from('ps_philgeps_session').upsert({ id: 'zz-none' }).select());
  await programRefused('read a page table (hospitals)', (db) => db.from('hospitals').select('name').limit(1));
  await programRefused('write hospitals', (db) => db.from('hospitals').insert({ agency_key: 'zz', name: 'zz' }));
  await programRefused('update status without filter', (db) => db.from('ps_sync_status').update({ connected_at: null }));
  await programRefused('delete relay rows', (db) => db.from('philgeps_sync_relay').delete().eq('id', 'zz-none'));
  const wrong = await fetch(`${base}/api/data`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: JSON.stringify({ table: 'philgeps_sync_relay', steps: [['select', 'id']] }) });
  if (wrong.status === 401) passed++;
  else failed++, console.log(`FAIL wrong secret: answered ${wrong.status}`);
} finally {
  await admin.auth.admin.deleteUser(made.user.id);
}
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
