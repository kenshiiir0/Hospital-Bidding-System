// Proves the bid documents on the server's disk (STORAGE_BACKEND=disk, frontend/src/lib/db/diskStorage.mjs) answer like
// Supabase Storage for what the code uses, and that the pages' route (/api/stored-files) serves them only to the team.
//   node --env-file=.env tools/check-disk-storage.mjs                         storage + reading checks
//   node --env-file=.env tools/check-disk-storage.mjs http://localhost:3107   also the route, on a dashboard started with
//       STORAGE_BACKEND=disk DOCUMENTS_DIR=<same folder as DOCUMENTS_DIR here> (a temporary team account is made and deleted)
// Supabase Storage gets one tiny test file (zz-check-*/), removed at the end. Reading uses a PDF from documents/.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { checkLink, createDiskStorage, filePath, signLink } from '../frontend/src/lib/db/diskStorage.mjs';

const base = process.argv[2];
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, opts);
const root = process.env.DOCUMENTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'docs-check-'));
const disk = createDiskStorage(root);
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => (cond ? passed++ : (failed++, console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`)));

// --- the same steps on Supabase Storage and on disk ---
const bucket = 'ps-documents';
const folder = `zz-check-${randomBytes(4).toString('hex')}`;
const key = `${folder}/Bid Form (1).txt`;
const bytes = Buffer.from('loratadine 10 mg tablet\n');
async function steps(storage) {
  const s = storage.from(bucket);
  const out = {};
  out.up = await s.upload(key, bytes, { contentType: 'text/plain', upsert: false });
  out.again = await s.upload(key, bytes, { contentType: 'text/plain', upsert: false });
  out.over = await s.upload(key, Buffer.from('replaced\n'), { contentType: 'text/plain', upsert: true });
  out.down = await s.download(key);
  out.text = out.down.data ? await out.down.data.text() : null;
  out.missing = await s.download(`${folder}/none.pdf`);
  out.list = await s.list(folder, { limit: 1000 });
  out.top = await s.list('', { limit: 1000, search: folder });
  out.emptyList = await s.list(`${folder}-none`, { limit: 10 });
  out.rm = await s.remove([key]);
  out.after = await s.list(folder, { limit: 1000 });
  return out;
}
const [sb, dk] = [await steps(admin.storage), await steps(disk)];
const row = (r) => r.list.data?.map((f) => ({ name: f.name, size: f.metadata?.size }));
ok('upload answers', !sb.up.error && !dk.up.error && dk.up.data.path === sb.up.data.path, JSON.stringify([sb.up, dk.up]));
ok('upload without upsert on an existing file fails "exists"', /exists/i.test(sb.again.error?.message) && /exists/i.test(dk.again.error?.message), JSON.stringify([sb.again.error, dk.again.error]));
ok('upsert replaces', !sb.over.error && !dk.over.error && sb.text === 'replaced\n' && dk.text === sb.text, JSON.stringify([sb.text, dk.text]));
ok('download gives a Blob', typeof dk.down.data?.arrayBuffer === 'function' && dk.down.data.size === sb.down.data.size);
ok('missing file: error, no data', sb.missing.error && !sb.missing.data && dk.missing.error && !dk.missing.data);
ok('list: names and sizes', JSON.stringify(row(sb)) === JSON.stringify(row(dk)), JSON.stringify([row(sb), row(dk)]));
ok('list: folder shown as a folder', sb.top.data?.some((f) => f.name === folder && f.id === null) && dk.top.data?.some((f) => f.name === folder && f.id === null), JSON.stringify([sb.top.data, dk.top.data]));
ok('list of a missing folder is empty', sb.emptyList.data?.length === 0 && dk.emptyList.data?.length === 0);
ok('remove', !sb.rm.error && !dk.rm.error && sb.rm.data.length === 1 && dk.rm.data.length === 1, JSON.stringify([sb.rm, dk.rm]));
ok('gone after remove', sb.after.data?.length === 0 && dk.after.data?.length === 0, JSON.stringify([sb.after.data, dk.after.data]));
await admin.storage.from(bucket).remove([key]);

// --- disk only: nothing outside the folder, links ---
for (const bad of ['../x.pdf', 'a/../../x', '/etc/passwd', 'a\\..\\x', 'a//b', '', 'a/./b', 'a/\0b']) ok(`refused path ${JSON.stringify(bad)}`, filePath(root, bucket, bad) === null);
ok('refused bucket', filePath(root, 'other', 'a/b.pdf') === null && filePath(root, '../ps-documents', 'a/b.pdf') === null);
ok('upload outside refused', (await disk.from(bucket).upload('../../escape.txt', bytes)).error && !fs.existsSync(path.join(root, '..', 'escape.txt')));
const link = new URL(signLink(bucket, 'a/b.pdf', 60, ''), 'http://x');
ok('signed link accepted', checkLink(link.searchParams)?.key === 'a/b.pdf');
const tampered = new URL(link);
tampered.searchParams.set('p', 'a/c.pdf');
ok('changed path refused', checkLink(tampered.searchParams) === null);
const asDownload = new URL(link);
asDownload.searchParams.set('d', 'x.pdf');
ok('added download name refused', checkLink(asDownload.searchParams) === null);
const late = new URL(signLink(bucket, 'a/b.pdf', 60, ''), 'http://x');
late.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 5));
ok('expired link refused', checkLink(late.searchParams) === null);

// --- files from before the move: still in Supabase Storage, fetched once and kept on disk (fallback) ---
{
  const oldKey = `${folder}-old/Old Bid.txt`;
  const oldBytes = Buffer.from('amikacin 250 mg/mL\n');
  await admin.storage.from(bucket).upload(oldKey, oldBytes, { upsert: true });
  let counted = 0;
  let over = false;
  let fetched = 0;
  const watched = { from: (b) => ({ ...admin.storage.from(b), download: (k) => (fetched++, admin.storage.from(b).download(k)), list: (...a) => admin.storage.from(b).list(...a), remove: (k) => admin.storage.from(b).remove(k) }) };
  const both = createDiskStorage(root, { storage: watched, overBudget: async () => over, count: async (n) => (counted += n) });
  const s = both.from(bucket);
  const listed = await s.list(`${folder}-old`);
  ok('fallback: listed while only in Supabase', listed.data?.some((f) => f.name === 'Old Bid.txt' && f.metadata?.size === oldBytes.length), JSON.stringify(listed));
  ok('fallback: not on disk yet', !both.exists(bucket, oldKey));
  over = true;
  const refused = await s.download(oldKey);
  ok('fallback: readers stopped at the budget', refused.error && /budget/.test(refused.error.message) && fetched === 0, JSON.stringify(refused.error));
  const forPage = await s.download(oldKey, { forPage: true });
  ok('fallback: a person opening it is not stopped', forPage.data && Buffer.from(await forPage.data.arrayBuffer()).equals(oldBytes));
  over = false;
  ok('fallback: kept on disk after the first fetch', both.exists(bucket, oldKey) && fetched === 1);
  ok('fallback: counted against the budget', counted === oldBytes.length, String(counted));
  const again = await s.download(oldKey);
  ok('fallback: second read from disk, no new fetch', again.data && fetched === 1);
  const twice = await s.list(`${folder}-old`);
  ok('fallback: listed once when in both places', twice.data?.filter((f) => f.name === 'Old Bid.txt').length === 1, JSON.stringify(twice.data));
  const none = await s.download(`${folder}-old/none.pdf`);
  ok('fallback: missing everywhere is an error', none.error && !none.data);
  await s.remove([oldKey]);
  const left = await admin.storage.from(bucket).list(`${folder}-old`);
  ok('fallback: removed from both', !both.exists(bucket, oldKey) && !left.data?.some((f) => f.name === 'Old Bid.txt'), JSON.stringify(left.data));
  await admin.storage.from(bucket).remove([oldKey]);
}

// --- reading a real document from disk (download + text + OCR cache lookup), no Supabase download or meter ---
const sample = 'documents/13264900/Invitation to Bid.pdf';
if (fs.existsSync(sample)) {
  const pdfKey = '13264900/Invitation to Bid.pdf';
  await disk.from(bucket).upload(pdfKey, fs.readFileSync(sample), { upsert: true });
  const { documentPages } = await import('../frontend/src/lib/psDocs.mjs');
  // A client whose database would fail if touched: reading from disk must not need it (no egress meter)
  const client = { storage: disk, from: () => { throw new Error('database touched'); }, rpc: () => { throw new Error('database touched'); } };
  const read = await documentPages(client, bucket, { name: 'Invitation to Bid.pdf', path: pdfKey, size: fs.statSync(sample).size }).catch((e) => ({ error: e.message }));
  const lines = read.pages?.flatMap((p) => p.lines).filter(Boolean).length || 0;
  ok('document read from disk', lines > 5, read.error || `${lines} lines`);
  await disk.from(bucket).remove([pdfKey]);
} else console.log(`(skipped reading check: ${sample} not on this computer)`);

// --- the pages' route ---
if (base) {
  const email = `zz-files-${randomBytes(4).toString('hex')}@users.opportunity-radar.invalid`;
  const password = randomBytes(18).toString('base64url');
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const { data: made, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { team: true } });
  if (error) throw error;
  try {
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    const token = signed.session.access_token;
    const fileKey = `${folder}/Price Schedule.pdf`;
    const content = Buffer.from('%PDF-1.4 test\n');
    await disk.from(bucket).upload(fileKey, content, { upsert: true });
    const ask = (body, auth = token) =>
      fetch(`${base}/api/stored-files`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    const view = await ask({ bucket, path: fileKey, seconds: 60 });
    const viewBody = await view.json();
    ok('link for a team member', view.status === 200 && viewBody.data?.signedUrl?.startsWith('/api/stored-files?'), JSON.stringify(viewBody));
    const got = await fetch(new URL(viewBody.data.signedUrl, base));
    ok('file served inline', got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(content) && got.headers.get('content-type') === 'application/pdf' && /^inline/.test(got.headers.get('content-disposition')), `${got.status} ${got.headers.get('content-disposition')}`);
    const save = await (await ask({ bucket, path: fileKey, download: 'Price Schedule.pdf' })).json();
    const saved = await fetch(new URL(save.data.signedUrl, base));
    ok('file served as a download', saved.status === 200 && /^attachment/.test(saved.headers.get('content-disposition')));
    ok('no link without sign-in', (await ask({ bucket, path: fileKey }, null)).status === 401);
    ok('no link with a wrong token', (await ask({ bucket, path: fileKey }, 'not-a-token')).status === 401);
    ok('no link outside the folder', (await ask({ bucket, path: '../../.env' })).status === 400);
    ok('no link for another bucket', (await ask({ bucket: 'secrets', path: 'a/b' })).status === 400);
    const changed = new URL(viewBody.data.signedUrl, base);
    changed.searchParams.set('p', `${folder}/other.pdf`);
    ok('changed link refused', (await fetch(changed)).status === 403);
    ok('unsigned request refused', (await fetch(`${base}/api/stored-files?b=${bucket}&p=${encodeURIComponent(fileKey)}`)).status === 403);
    const gone = await (await ask({ bucket, path: `${folder}/none.pdf` })).json();
    ok('missing file: 404 through its link', (await fetch(new URL(gone.data.signedUrl, base))).status === 404);
    await disk.from(bucket).remove([fileKey]);
    // A file still only in Supabase Storage opens too, and is on this disk afterwards
    const oldKey = `${folder}-route/Old Schedule.pdf`;
    await admin.storage.from(bucket).upload(oldKey, content, { upsert: true, contentType: 'application/pdf' });
    const oldLink = await (await ask({ bucket, path: oldKey })).json();
    const oldGot = await fetch(new URL(oldLink.data.signedUrl, base));
    ok('route: file from Supabase Storage served', oldGot.status === 200 && Buffer.from(await oldGot.arrayBuffer()).equals(content), String(oldGot.status));
    ok('route: and kept on disk', disk.exists(bucket, oldKey));
    await admin.storage.from(bucket).remove([oldKey]);
    await disk.from(bucket).remove([oldKey]);
    await anon.auth.signOut({ scope: 'local' });
  } finally {
    await admin.auth.admin.deleteUser(made.user.id);
  }
}

if (!process.env.DOCUMENTS_DIR) fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
