import { Session, STALE_RUN_MS, fetchFile } from './psSync.mjs';
import { noticeClosed } from './readAgain.mjs';
import { scannedWaiting } from './ocrQueue.mjs';
import { wakeDocs } from './docsIdle.mjs';

// The scanned PS-PhilGEPS documents waiting for OCR whose files are not on this server's disk yet (they were saved in
// Supabase Storage before the move, STORAGE_BACKEND=disk) are fetched again from PS-PhilGEPS itself, with the saved
// session, as a Sync downloads them, and kept on the disk. No Supabase download (egress) is needed to read them.
// Run by the OCR job before it reads (scripts/ocr-job.mjs).
// - Only open tenders (a closed one is never read again, readAgain.mjs) with a scanned file waiting; all of the
//   tender's files that are missing, since its reading opens every one. Screened tenders first.
// - The file must have the size it had when first downloaded, and the log-in page is never saved as a file.
// - Never while a Sync runs (one user of the session at a time), and the session's cookies are kept in step with
//   the saved copy before and after each file (the keep-alive uses it too).
// - Stops at maxMs; the next run continues.

const BUCKET = 'ps-documents';
const PAUSE_MS = 500;

// Same rule as psSync.keepAlive: a running Sync has the session
async function syncRunning(supabase) {
  const { data } = await supabase.from('ps_sync_status').select('status, started_at').eq('id', 'latest').single();
  return data?.status === 'running' && Date.now() - new Date(data.started_at).getTime() < STALE_RUN_MS;
}

// The files to fetch: [{ ref, doc, screened }], Screened tenders first
export async function filesToFetch(supabase, notices) {
  const storage = supabase.storage;
  if (!storage?.local) return [];
  const waiting = (await scannedWaiting(supabase)).filter((w) => w.side === 'ps');
  const refs = [...new Set(waiting.map((w) => String(w.ref)))];
  const { data: screened } = await supabase.from('screened_tenders').select('ref').eq('source', 'ps');
  const isScreened = new Set((screened || []).map((s) => String(s.ref)));
  const out = [];
  for (const ref of refs) {
    const notice = notices?.[ref];
    if (!notice || noticeClosed(notice)) continue;
    for (const doc of notice.documents || []) {
      if (doc.path && doc.url && !doc.removed && !storage.exists(BUCKET, doc.path)) out.push({ ref, doc, screened: isScreened.has(ref) });
    }
  }
  return out.sort((a, b) => Number(b.screened) - Number(a.screened));
}

// One file: downloaded with the session, checked, kept on disk. Throws on any problem (nothing saved then).
export async function fetchOne(storage, session, doc) {
  const body = await fetchFile(session, doc.url);
  if (doc.size && body.length !== doc.size) throw new Error(`got ${body.length} bytes, the file had ${doc.size}: not saved`);
  const { error } = await storage.from(BUCKET).upload(doc.path, body, { upsert: true });
  if (error) throw new Error(`saving: ${error.message}`);
  return body.length;
}

export async function fetchWaitingFromSource(supabase, notices, { maxMs = 10 * 60 * 1000, dryRun = false, log = () => {} } = {}) {
  if (!supabase.storage?.local) return { skipped: 'the documents are not on this server' };
  const started = Date.now();
  const todo = await filesToFetch(supabase, notices);
  const planned = { files: todo.length, bytes: todo.reduce((n, t) => n + (t.doc.size || 0), 0), screened: todo.filter((t) => t.screened).length };
  if (dryRun || !todo.length) return { fetched: 0, left: todo.length, planned };
  if (await syncRunning(supabase)) return { skipped: 'a Sync is running', left: todo.length, planned };

  const readSaved = async () => (await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle()).data?.cookies;
  const first = await readSaved();
  if (!first?.length) return { skipped: 'PS-PhilGEPS is not connected', left: todo.length, planned };
  const session = new Session(first);
  let savedPrint = session.fingerprint();

  let fetched = 0;
  let failed = 0;
  let bytes = 0;
  let stopped = null;
  const errors = [];
  for (const { ref, doc } of todo) {
    if (Date.now() - started > maxMs) {
      stopped = 'time limit';
      break;
    }
    if ((fetched + failed) % 10 === 0 && (await syncRunning(supabase))) {
      stopped = 'a Sync started';
      break;
    }
    // The keep-alive may have saved newer cookies meanwhile: carry on with those
    const now = await readSaved();
    if (!now?.length) {
      stopped = 'PS-PhilGEPS was disconnected';
      break;
    }
    if (new Session(now).fingerprint() !== savedPrint) {
      session.load(now);
      savedPrint = session.fingerprint();
    }
    try {
      const n = await fetchOne(supabase.storage, session, doc);
      fetched++;
      bytes += n;
      log(`fetched ${ref}/${doc.name} (${Math.round(n / 1024)} KB)`);
    } catch (e) {
      // The session ended or the site is down: stop (the next run tries again); one missing file: go on
      if (e.code === 'NOT_CONNECTED' || e.code === 'SITE_DOWN' || e.code === 'HTTP_ERROR') {
        stopped = e.message;
        break;
      }
      failed++;
      errors.push(`${ref}/${doc.name}: ${e.message}`);
      log(`not fetched ${ref}/${doc.name}: ${e.message}`);
    }
    if (session.fingerprint() !== savedPrint) {
      await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current');
      savedPrint = session.fingerprint();
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  // Their tenders are read again with the files now here (the document run otherwise stops early when nothing changed)
  if (fetched) await wakeDocs(supabase);
  return { fetched, failed, bytes, left: todo.length - fetched, stopped, errors: errors.slice(0, 5), planned };
}
