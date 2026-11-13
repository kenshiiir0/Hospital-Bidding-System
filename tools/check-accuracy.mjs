// Reading accuracy check (lib/readingAccuracy.mjs, the "Check reading" alert at 70% or below). Run by the safety gate.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const { readingAccuracy, isLowAccuracy } = await import(pathToFileURL(path.resolve('frontend/src/lib/readingAccuracy.mjs')).href);
const line = (quantity, unit_price, total, description = 'Paclitaxel 6 mg/mL, 50 mL vial') => ({ quantity, unit_price, total, description, source: 'Bid Docs.pdf, page 3' });
const empty = { our_products: ['Paclitaxel'], line: '24. Paclitaxel 6 mg/mL', why: 'no ABC', source: 'ToR.pdf, page 2' };
const text = { name: 'Bid Docs.pdf', kind: 'text' };
let failed = 0;
const check = (name, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};

check('every line priced and adding up, text files: 100%', readingAccuracy({ items: [line(10, 5, 50), line(2, 3, 6)], read: [text] }).percent, 100);
check('half the table empty: 50%, alert', readingAccuracy({ items: [line(10, 5, 50)], outside: [empty], read: [text] }), (a) => a.percent === 50 && isLowAccuracy(a));
check('the empty line is named with its file', readingAccuracy({ items: [line(10, 5, 50)], outside: [empty], read: [text] }).reasons[0], (r) => r.includes('24. Paclitaxel') && r.includes('ToR.pdf'));
check('documents with no prices at all are not a misreading', readingAccuracy({ items: [], outside: [empty], read: [text] }).percent, 100);
check('Qty × ABC/Unit ≠ ABC Total counts half', readingAccuracy({ items: [line(10, 5, 99)], read: [text] }).percent, 50);
check('amount left in the name only (numbers fit) counts lightly', readingAccuracy({ items: [line(300, 2, 600, 'Cefazolin 300.00 vial'), line(1, 2, 2)], read: [text] }).percent, 95);
check('one of two files unreadable: 50%', readingAccuracy({ items: [line(10, 5, 50)], read: [text, { name: 'scan.pdf', kind: 'unreadable' }] }).percent, 50);
check('scanned pages waiting for OCR count half', readingAccuracy({ items: [line(10, 5, 50)], read: [{ ...text, ocr_waiting: true }] }).percent, 50);
check('Word/Excel-only "unsupported" files are left out', readingAccuracy({ items: [line(10, 5, 50)], read: [text, { name: 'a.zip', kind: 'unsupported' }] }).percent, 100);
check('nothing read: no score, no alert', readingAccuracy({ read: [] }), (a) => a === null && !isLowAccuracy(a));
check('71% is not an alert, 70% is', !isLowAccuracy({ percent: 71 }) && isLowAccuracy({ percent: 70 }), true);

if (failed) {
  console.log(`\nReading accuracy check FAILED (${failed}).`);
  process.exit(1);
}
console.log('\nReading accuracy check passed (11 checks).');
