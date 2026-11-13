// How well a tender's documents were read, as a percentage (user, 2026-11-13: "an accuracy percentage of how the
// read goes ... an alert on the tender if it goes 70% and below so we know which tender have a low accuracy reading
// to check"). Worked out with the reading (lib/psDocs.mjs readDocuments) and saved with it, both portals:
// PS-PhilGEPS ps_tender_analysis.result.accuracy, PhilGEPS details.documents_accuracy. The number itself is not shown;
// a tender at LOW_ACCURACY or below gets the "Check reading" alert (components/ReadingAlert.js) with the reasons.
// The same checks the team makes by hand (tools/audit-readings.mjs uses lineIssues too):
// - lines: every line of our products read from a table counts 1 when its Qty and ABC are there and add up, 1/2 when
//   they are there but don't fit (lineIssues: Qty x ABC/Unit != ABC Total, Qty 0, an ABC/Unit out of range), 0.9 when
//   the numbers fit and only an amount was left in the product's name (cosmetic), 0 when the line has no Qty or no ABC while other lines of the
//   tender have theirs ("they are in a one table": a half-filled table is a reading gap). Documents with no prices
//   at all (RFQs, Price Schedules left blank for bidders) are not a misreading and don't lower it.
// - files: each readable file counts 1 when its text was read, 1/2 when scanned pages in it are still unread (OCR
//   waiting or failed) or OCR found no text in it, 0 when it could not be read at all.
// percent = lines share x files share (a tender read perfectly from half its files is read at 50%).
// Plain .mjs (no Next imports): also used by node scripts.
export const LOW_ACCURACY = 70;
// Bumped when the way it is worked out changes (tools/backfill-accuracy.mjs recomputes saved readings)
export const ACCURACY_VERSION = 1;

const NAME_AMOUNT = 'amount left in the name';
const complete = (i) => i.quantity != null && (i.unit_price != null || i.total != null);

// What looks wrong in a read line that has its numbers (empty list = nothing)
export function lineIssues(i) {
  const why = [];
  const unit = i.computed === 'unit_price' ? null : i.unit_price;
  const name = String(i.description || '');
  if (i.quantity === 0) why.push('Qty 0');
  if (unit != null && unit < 0.1) why.push(`ABC/Unit ₱${unit}`);
  if (unit != null && unit >= 100000) why.push(`ABC/Unit ₱${unit.toLocaleString('en-US')}`);
  if (i.quantity != null && unit != null && i.total != null && i.computed !== 'total' && Math.abs(i.quantity * unit - i.total) > Math.max(1, i.total * 0.01)) why.push('Qty × ABC/Unit ≠ ABC Total');
  if (/\d[\d,]*\.\d{2}\b/.test(name)) why.push(NAME_AMOUNT);
  return why;
}

const where = (source) => {
  const s = String(source || '').split(', ').slice(-2).join(', ');
  return s ? ` (${s})` : '';
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// { percent, reasons: [text], version } for a reading; null when nothing was read (no files, not read yet)
// items: the priced lines (result.items / documents_items); outside: result.outside_table / documents_outside_table
// (lines of our products set aside for having no Qty or ABC carry `why`); read: documents_read
export function readingAccuracy({ items = [], outside = [], read = [] } = {}) {
  const files = (read || []).filter((d) => d.kind !== 'unsupported');
  if (!files.length) return null;
  const reasons = [];

  // Lines
  const priced = (items || []).filter(complete);
  const empty = (outside || []).filter((x) => x.why && x.our_products?.length);
  let lineShare = 1;
  if (priced.length) {
    const odd = priced.map((i) => ({ i, why: lineIssues(i) })).filter((x) => x.why.length);
    const cosmetic = (x) => x.why.every((w) => w === NAME_AMOUNT);
    const lost = odd.reduce((s, x) => s + (cosmetic(x) ? 0.1 : 0.5), 0);
    const total = priced.length + empty.length;
    lineShare = (priced.length - lost) / total;
    if (empty.length) {
      const e = empty[0];
      reasons.push(`${empty.length} of ${plural(total, 'line')} of our products have no Qty or ABC, e.g. "${String(e.line || '').slice(0, 70)}"${where(e.source)}`);
    }
    if (odd.length) {
      const o = odd[0];
      reasons.push(`${plural(odd.length, 'line')} to check (${[...new Set(odd.flatMap((x) => x.why))].join('; ')}), e.g. "${String(o.i.written || o.i.line || o.i.description || '').slice(0, 70)}"${where(o.i.source)}`);
    }
  }

  // Files
  const score = (d) => {
    if (d.kind === 'text') return d.ocr_waiting || d.ocr_error ? 0.5 : 1;
    if (d.kind === 'scanned') return d.ocr && !d.ocr_error ? 0.5 : 0;
    return 0;
  };
  const fileShare = files.reduce((s, d) => s + score(d), 0) / files.length;
  const unreadable = files.filter((d) => score(d) === 0);
  const partly = files.filter((d) => score(d) === 0.5);
  if (unreadable.length) reasons.push(`${plural(unreadable.length, 'file')} of ${files.length} could not be read: ${unreadable.map((d) => d.name).slice(0, 3).join(', ')}`);
  if (partly.length) reasons.push(`${plural(partly.length, 'file')} of ${files.length} with scanned pages not read (OCR): ${partly.map((d) => d.name).slice(0, 3).join(', ')}`);

  const percent = Math.round(100 * lineShare * fileShare);
  return { percent, reasons, version: ACCURACY_VERSION };
}

export const isLowAccuracy = (accuracy) => accuracy != null && accuracy.percent <= LOW_ACCURACY;
