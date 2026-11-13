// Works out the reading accuracy (lib/readingAccuracy.mjs, "Check reading" alert) for readings saved before it
// existed or with an older ACCURACY_VERSION, from what is already saved: no document is downloaded or read again.
// Both portals: PS-PhilGEPS ps_tender_analysis.result.accuracy, PhilGEPS details.documents_accuracy (open tenders).
//   cd frontend && node --env-file=../.env ../tools/backfill-accuracy.mjs [--dry]
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = process.cwd();
const req = createRequire(`${root}/package.json`);
const { createClient } = req('@supabase/supabase-js');
const { readingAccuracy, ACCURACY_VERSION, LOW_ACCURACY } = await import(pathToFileURL(`${root}/src/lib/readingAccuracy.mjs`).href);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
const dry = process.argv.includes('--dry');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

let changed = 0;
let low = 0;
async function inBatches(list, n, fn) {
  for (let i = 0; i < list.length; i += n) await Promise.all(list.slice(i, i + n).map(fn));
}

// PS-PhilGEPS
const { data: ps, error: psError } = await sb.from('ps_tender_analysis').select('ref, result, documents_read').not('result', 'is', null);
if (psError) throw new Error(psError.message);
await inBatches(ps, 10, async (r) => {
  const accuracy = readingAccuracy({ items: r.result.items, outside: r.result.outside_table, read: r.documents_read });
  if (accuracy?.percent <= LOW_ACCURACY) low++;
  if (r.result.accuracy?.version === ACCURACY_VERSION && same(r.result.accuracy, accuracy)) return;
  changed++;
  if (!dry) {
    const { error } = await sb.from('ps_tender_analysis').update({ result: { ...r.result, accuracy } }).eq('ref', r.ref);
    if (error) console.log(`PS ${r.ref}: ${error.message}`);
  }
});
console.log(`PS-PhilGEPS: ${ps.length} readings`);

// PhilGEPS: open tenders with a reading (closed ones show nowhere)
const rows = [];
const now = new Date().toISOString();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from('philgeps_opportunities')
    .select('ref_no, documents_accuracy:details->documents_accuracy, documents_items:details->documents_items, documents_outside_table:details->documents_outside_table, documents_read:details->documents_read')
    .not('details->documents_read', 'is', null)
    .or(`closing_date.is.null,closing_date.gt.${now}`)
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...data);
  if (data.length < 1000) break;
}
await inBatches(rows, 10, async (o) => {
  const accuracy = readingAccuracy({ items: o.documents_items || [], outside: o.documents_outside_table || [], read: o.documents_read || [] });
  if (accuracy?.percent <= LOW_ACCURACY) low++;
  if (o.documents_accuracy?.version === ACCURACY_VERSION && same(o.documents_accuracy, accuracy)) return;
  changed++;
  if (dry) return;
  // The whole details is written back, read just before (the hourly update may have changed it meanwhile)
  const { data: fresh } = await sb.from('philgeps_opportunities').select('details').eq('ref_no', o.ref_no).maybeSingle();
  if (!fresh?.details) return;
  const { error } = await sb.from('philgeps_opportunities').update({ details: { ...fresh.details, documents_accuracy: accuracy } }).eq('ref_no', o.ref_no);
  if (error) console.log(`PhilGEPS ${o.ref_no}: ${error.message}`);
});
console.log(`PhilGEPS: ${rows.length} open tenders with a reading`);
console.log(`${dry ? 'Would update' : 'Updated'} ${changed}; at ${LOW_ACCURACY}% or below: ${low}`);
process.exit(0);
