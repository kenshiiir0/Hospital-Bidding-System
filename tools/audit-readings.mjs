// Reading audit, both portals, Screened Tenders first: every molecule line read from the documents, checked the way
// the team checks it by hand (user, 2026-10-27/28: "check every tender when we are correcting one"). Read-only.
//   cd frontend && node --env-file=../.env ../tools/audit-readings.mjs [out.json]
// Reports:
// 1. tenders with SOME lines complete (Qty + ABC/Unit or ABC Total) and others empty: a reading gap, never "the
//    document has no prices" (those tenders have no complete line at all and are counted apart)
// 2. lines whose own text no longer passes our Product List (strength, pack volume, dosage form): a reading made
//    with older rules, or a product archived since
// 3. unusual readings: numbers left in the name, quantity x ABC/Unit != ABC Total, Qty 0, amounts out of range
// Each with the tender, the line as written and the file and page it came from.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const root = process.cwd();
const req = createRequire(`${root}/package.json`);
const { createClient } = req('@supabase/supabase-js');
const { loadMatcher } = await import(pathToFileURL(`${root}/src/lib/products.mjs`).href);
const { rowAhead } = await import(pathToFileURL(`${root}/src/lib/psDocs.mjs`).href);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
const match = await loadMatcher(sb);

// Every open tender's document lines, both portals
const lines = [];
const { data: snap } = await sb.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').single();
const { data: readings } = await sb.from('ps_tender_analysis').select('ref, result');
for (const r of readings || []) if (snap?.notices?.[r.ref]) for (const i of r.result?.items || []) lines.push({ side: 'PS-PhilGEPS', ref: r.ref, i });
const bids = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from('philgeps_opportunities').select('ref_no, closing_date, details->documents_items').not('matched_molecules', 'eq', '{}').range(from, from + 999);
  bids.push(...(data || []));
  if (!data || data.length < 1000) break;
}
for (const o of bids) if (!o.closing_date || new Date(o.closing_date) > new Date()) for (const i of o.documents_items || []) lines.push({ side: 'PhilGEPS', ref: o.ref_no, i });
const { data: screenedRows } = await sb.from('screened_tenders').select('source, ref');
const screened = new Set((screenedRows || []).map((s) => `${s.source === 'ps' ? 'PS-PhilGEPS' : 'PhilGEPS'} ${s.ref}`));
const isScreened = (x) => screened.has(`${x.side} ${x.ref}`);
const complete = (i) => i.quantity != null && (i.unit_price != null || i.total != null);
const written = (i) => String(i.written || i.line || '').slice(0, 120);

// 1. Partly empty tables
const byTender = new Map();
for (const x of lines) {
  const key = `${x.side} ${x.ref}`;
  if (!byTender.has(key)) byTender.set(key, []);
  byTender.get(key).push(x);
}
const partly = [];
let noPrices = 0;
for (const [, group] of byTender) {
  const done = group.filter((x) => complete(x.i)).length;
  const gaps = group.filter((x) => !complete(x.i));
  if (!gaps.length) continue;
  if (!done) noPrices++;
  else partly.push({ screened: isScreened(group[0]), side: group[0].side, ref: group[0].ref, complete: done, empty: gaps.map((x) => ({ line: written(x.i), file: x.i.source })) });
}

// 2. Lines that no longer pass our Product List (strength, pack volume, form)
const notOurs = [];
for (const x of lines) {
  const text = x.i.written || x.i.line || '';
  const ahead = rowAhead(String(x.i.context || '').split(' / '), 0);
  const now = match.line(text, ahead);
  const lost = (x.i.our_products || []).filter((p) => !now.includes(p));
  if (lost.length) notOurs.push({ screened: isScreened(x), side: x.side, ref: x.ref, products: lost, line: written(x.i), file: x.i.source });
}

// 3. Unusual readings
const unusual = [];
for (const x of lines) {
  const { i } = x;
  const why = [];
  const unit = i.computed === 'unit_price' ? null : i.unit_price;
  const name = String(i.description || '');
  if (i.quantity === 0) why.push('Qty 0');
  if (unit != null && unit < 0.1) why.push(`ABC/Unit ₱${unit}`);
  if (unit != null && unit >= 100000) why.push(`ABC/Unit ₱${unit.toLocaleString()}`);
  if (i.quantity != null && unit != null && i.total != null && i.computed !== 'total' && Math.abs(i.quantity * unit - i.total) > Math.max(1, i.total * 0.01)) why.push('Qty × ABC/Unit ≠ ABC Total');
  if (/\d[\d,]*\.\d{2}\b/.test(name)) why.push('amount in the name');
  if (i.quantity != null && (unit != null || i.total != null) && !complete(i)) why.push('incomplete');
  if (why.length) unusual.push({ screened: isScreened(x), side: x.side, ref: x.ref, why: why.join('; '), line: written(i), file: i.source });
}

const first = (a, b) => Number(b.screened) - Number(a.screened);
partly.sort((a, b) => first(a, b) || b.empty.length - a.empty.length);
notOurs.sort(first);
unusual.sort(first);
const report = {
  checked_at: new Date().toISOString(),
  lines: lines.length,
  complete: lines.filter((x) => complete(x.i)).length,
  tenders_without_prices: noPrices,
  partly_empty: partly,
  not_ours: notOurs,
  unusual,
};
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 1));

const tag = (x) => `${x.screened ? 'SCREENED ' : ''}${x.side} ${x.ref}`;
console.log(`Lines ${report.lines}, complete ${report.complete}; tenders whose documents have no prices: ${noPrices}`);
console.log(`\n1. Partly empty tables: ${partly.length} tenders, ${partly.reduce((s, p) => s + p.empty.length, 0)} lines`);
for (const p of partly) console.log(`   ${tag(p)}: ${p.complete} complete, ${p.empty.length} empty, e.g. "${p.empty[0].line.slice(0, 80)}" (${p.empty[0].file})`);
console.log(`\n2. Not our strength/form any more: ${notOurs.length} lines`);
for (const n of notOurs.slice(0, 40)) console.log(`   ${tag(n)}: ${n.products.join(', ')} | "${n.line.slice(0, 80)}" (${n.file})`);
console.log(`\n3. Unusual: ${unusual.length} lines`);
for (const u of unusual.slice(0, 40)) console.log(`   ${tag(u)}: ${u.why} | "${u.line.slice(0, 80)}" (${u.file})`);
process.exit(0);
