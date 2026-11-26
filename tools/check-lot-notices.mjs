// One-lot notice check, part of the safety gate (tools/safety-gate.sh), runnable by hand: node tools/check-lot-notices.mjs
// A PS-PhilGEPS notice whose Line Item Details give the purchase as "1 Lot" is not an opportunity: left out of Bid
// Match, Screened and the export (user, 2026-11-26: "I told u to not include if it says 1 lot"; PS 163216, 164641,
// 165710). Notices listing items one by one stay.
import assert from 'node:assert/strict';
import { noticeOneLot } from '../frontend/src/lib/packageTender.js';
import { readLotType } from '../frontend/src/lib/psSync.mjs';

const cases = [
  [{ matched_items: [{ line: '1 150 Pieces Ibuprofen 200mg Soft Gel 2 150 Pieces Paracetamol ... 4 150 Pieces Loratadine 10mg/tab', quantity: 1, unit: 'Lot' }] }, true, 'a whole list in one "1 Lot" line (PS 163216)'],
  [{ matched_items: [{ line: 'aluminum magnesium tablet ... cetirizine 10mg tablet ...', quantity: 1, unit: 'lot' }] }, true, 'unit written in small letters (PS 164641)'],
  [{ matched_items: [{ line: 'Drugs and medicines', quantity: 1, unit: 'Package' }] }, true, 'one package'],
  [{ matched_items: [{ line: 'Cetirizine 10mg tablet', quantity: 1000, unit: 'Tablet' }, { line: 'Loratadine 10mg tablet', quantity: 500, unit: 'Tablet' }] }, false, 'items one by one'],
  [{ matched_items: [{ line: 'Propofol 10mg/mL, 20mL vial', quantity: 1, unit: 'Vial' }] }, false, 'one vial is not a lot'],
  [{ matched_items: [{ line: 'Cefazolin lot of 10 vials', quantity: 5, unit: 'Lot' }] }, false, 'five lots are not one'],
  [{}, false, 'no line items'],
  [{ lot_type: 'Single Lot', matched_items: [{ line: 'Cetirizine 10mg tablet', quantity: 1000, unit: 'Tablet' }] }, true, 'the notice says "Lot Type: Single Lot" (PS 166581)'],
  [{ lot_type: 'Multiple Lot' }, false, 'several lots stay'],
  [{ lot_type: 'Per Item' }, false, 'per item stays'],
];
for (const [notice, want, label] of cases) {
  assert.equal(noticeOneLot(notice), want, label);
  console.log(`  ok    ${label}`);
}
// The field as the notice page gives it: label and value on their own lines, or run together on one line
assert.equal(readLotType('Bid Validity Period:\n120\nControl Number:\n20261125001\nLot Type:\nSingle Lot\nApproved Budget of the Contract:\n6,673,840.00'), 'Single Lot', 'Lot Type on its own line (PS 166581)');
assert.equal(readLotType('Control Number: 20261125001 Lot Type: Single Lot Approved Budget of the Contract: 6,673,840.00'), 'Single Lot', 'labels run together on one line');
assert.equal(readLotType('Lot Type: Multiple Lot'), 'Multiple Lot', 'several lots');
assert.equal(readLotType('Approved Budget of the Contract: 100.00'), null, 'no Lot Type field');
console.log(`One-lot notice check passed (${cases.length + 4} checks).`);
