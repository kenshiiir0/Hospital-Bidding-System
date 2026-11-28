// The waiting scanned PS-PhilGEPS files not on this server's disk yet, fetched from PS-PhilGEPS (lib/sourceFetch.mjs),
// by hand from Coolify's Terminal (the OCR job does the same at its start). Run from frontend/:
//   node scripts/fetch-waiting.mjs --dry-run    how many files and MB, Screened first; nothing downloaded
//   node scripts/fetch-waiting.mjs              fetch them (stops after 20 minutes; run again to continue)
import { admin } from '../src/lib/ocrQueue.mjs';
import { fetchWaitingFromSource } from '../src/lib/sourceFetch.mjs';

const supabase = admin();
if (!supabase.storage?.local) {
  console.log('The documents are not kept on this computer (STORAGE_BACKEND=disk and DOCUMENTS_DIR are not set). Nothing to do.');
  process.exit(0);
}
const dryRun = process.argv.includes('--dry-run');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const notices = (await supabase.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').maybeSingle()).data?.notices || {};
const r = await fetchWaitingFromSource(supabase, notices, { dryRun, maxMs: 20 * 60 * 1000, log });
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nTo fetch: ${r.planned?.files ?? 0} files (${mb(r.planned?.bytes || 0)}), ${r.planned?.screened ?? 0} of them from Screened tenders.`);
if (!dryRun) {
  if (r.skipped) console.log(`Not started: ${r.skipped}.`);
  else console.log(`Fetched ${r.fetched} (${mb(r.bytes || 0)}), failed ${r.failed}, left ${r.left}.${r.stopped ? ` Stopped: ${r.stopped}.` : ''}`);
  for (const e of r.errors || []) console.log(`  ${e}`);
  if (r.fetched) console.log('Their tenders are read again with OCR at the next OCR run.');
}
process.exit(0);
