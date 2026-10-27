// Layer 1 of reading scanned documents: run hourly by GitHub Actions (.github/workflows/ocr.yml), where
// computing time is free; the deployed server (Vercel) has too little for OCR. Reads with OCR (tesseract,
// lib/ocr.mjs) every tender whose scanned documents haven't been read with OCR yet, on both sides, using the
// same readers as the server (OCR is on here because this isn't Vercel), and saves the results like they do:
// - PS-PhilGEPS: psDocs.analyzePending → ps_tender_analysis,
// - PhilGEPS: philgepsSync.readTenderDocuments → philgeps_opportunities.details.
// The OCR text is cached in Storage (_ocr/...), so a run cut short continues where it stopped.
// Needs SUPABASE_URL and SUPABASE_KEY (GitHub repository secrets). Run from frontend/: node scripts/ocr-job.mjs
import { analyzePending, loadMatcher } from '../src/lib/psDocs.mjs';
import { needsReading, readTenderDocuments, screenedFirst } from '../src/lib/philgepsSync.mjs';
import { admin, saveOcrStatus } from '../src/lib/ocrQueue.mjs';

const RUN_MS = Number(process.env.OCR_RUN_MINUTES || 45) * 60 * 1000; // the workflow allows 60 minutes; OCR_RUN_MINUTES for a short test
const started = Date.now();
const supabase = admin();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  // The dashboard shows "Reading scanned documents" while this is set (cleared below when the run ends)
  await supabase.from('ocr_status').update({ github_running_since: new Date().toISOString() }).eq('id', 'latest');
  // PS-PhilGEPS: at most half the time, so PhilGEPS gets its turn too
  const ps = await analyzePending({ maxMs: RUN_MS / 2, onProgress: (done, total) => log(`PS-PhilGEPS tender ${done} of ${total}`) });
  log('PS-PhilGEPS:', JSON.stringify(ps));

  // PhilGEPS: downloaded documents not read yet, or scanned and not read with OCR yet
  const matchProducts = await loadMatcher();
  const { data, error } = await supabase
    .from('philgeps_opportunities')
    .select('ref_no, title, items_text, matched_molecules, details')
    .not('details->documents', 'is', null);
  if (error) throw new Error(`Reading PhilGEPS tenders: ${error.message}`);
  // Screened tenders first
  const unread = await screenedFirst(supabase, (data || []).filter((o) => needsReading(o, matchProducts.key)));
  let read = 0;
  let failed = 0;
  for (const o of unread) {
    if (Date.now() - started > RUN_MS) break;
    try {
      const update = await readTenderDocuments(supabase, matchProducts, o, o.details);
      const { error: saveError } = await supabase.from('philgeps_opportunities').update(update).eq('ref_no', o.ref_no);
      if (saveError) throw new Error(saveError.message);
      read++;
    } catch (e) {
      // e.g. OCR time ran out for a long scan: the cache keeps the pages read, the next run continues
      failed++;
      log('PhilGEPS', o.ref_no, e.message);
    }
  }
  log(`PhilGEPS: read ${read}, not finished ${failed}, waiting ${unread.length - read - failed}`);
  return `PS-PhilGEPS read ${ps.read ?? 0}, PhilGEPS read ${read}`;
}

main()
  .then(async (result) => {
    const waiting = await saveOcrStatus(supabase, { github_last_run_at: new Date().toISOString(), github_last_result: result, github_running_since: null });
    log(`Done: ${result}. Scanned documents still waiting: ${waiting.length}`);
  })
  .catch(async (e) => {
    console.error(e);
    await saveOcrStatus(supabase, { github_last_run_at: new Date().toISOString(), github_last_result: `Failed: ${e.message}`.slice(0, 300), github_running_since: null }).catch(() => {});
    process.exit(1);
  });
