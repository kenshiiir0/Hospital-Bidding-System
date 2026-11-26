// Screened one-lot check, part of the safety gate (tools/safety-gate.sh), runnable by hand:
//   node tools/check-screened-lots.mjs
// A screened tender bought as one lot leaves Screened Tenders by itself (lib/screenedLots.mjs; user 2026-11-26: "If
// there are marked one lot it's not important if dashboard or document. Automatically remove them"). The website's
// Multi Lot keeps a tender whatever its documents say (PS 161025).
import assert from 'node:assert/strict';
import { psOneLot } from '../frontend/src/lib/screenedLots.mjs';

const cases = [
  [{ lot_type: 'Single Lot' }, undefined, true, 'the notice says Single Lot (PS 163216)'],
  [{ matched_items: [{ quantity: 1, unit: 'Lot', line: 'a whole list' }] }, undefined, true, 'the notice lists it as 1 Lot'],
  [{}, true, true, 'the documents say one lot, the notice not read yet (PS 160151)'],
  [{ lot_type: 'Multi Lot' }, true, false, 'the website says Multi Lot: kept, whatever the documents say (PS 161025)'],
  [{ lot_type: 'Multi Lot' }, undefined, false, 'several lots stay'],
  [{}, false, false, 'itemised documents, no lot'],
  [{}, undefined, false, 'nothing known: stays'],
];
for (const [notice, pkg, want, label] of cases) {
  assert.equal(psOneLot(notice, pkg), want, label);
  console.log(`  ok    ${label}`);
}
console.log(`Screened one-lot check passed (${cases.length} checks).`);
