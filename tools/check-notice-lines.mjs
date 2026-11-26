// The PS-PhilGEPS notice page's "Line Item Details" table is read for our lines (psSync.mjs readLineItems; user
// 2026-11-21, PS 153359: the only file was a template without an item list, the tracker was empty although the
// notice lists our lines). Rows from that notice, cut down. Nothing real is touched.
//   node tools/check-notice-lines.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const front = path.resolve('frontend');
const { parse } = createRequire(`${front}/package.json`)('node-html-parser');
const { readLineItems } = await import(pathToFileURL(`${front}/src/lib/psSync.mjs`).href);
const { buildMatcher } = await import(pathToFileURL(`${front}/src/lib/products.mjs`).href);
const match = buildMatcher([
  { generic_name: 'Heparin Sodium', brand_name: 'x', dosage: '1000 IU / ml (25000 IU / 5ml)' },
  { generic_name: 'Folic acid (Vitamin B9)', brand_name: 'x', dosage: '5 mg', dosage_form: 'Tablet' },
  { generic_name: 'Cefoxitin', brand_name: 'x', dosage: '1g' },
]);
const row = (...c) => `<tr>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`;
const html = `<b> Line Item Details</b><table><tr><th>Item No.</th><th>UNSPSC</th><th>Lot Name</th><th>Lot Description</th><th>Quantity</th><th>Unit of Measure</th><th>ABC(Estimated Budget)</th></tr>
${row(30, 51191705, 'Citric acid and potassium citrate combination', 'Cefoxitin Sodium 1 g', 15000, 'Vial', '1,236,600.00')}
${row(238, 51191706, 'Citric acid and sodium citrate combination', 'Heparin (as sodium) 1000 IU/ml , 5ml', 400, 'Vial', '27,200.00')}
${row(239, 51191706, 'x', 'Heparin (as sodium) 1000 IU/ml , 10ml', 100, 'Vial', '9,000.00')}
${row(517, 51191706, 'x', 'Folic Acid 5mg', 1500, 'Tablet', '3,975.00')}
${row(518, 51191706, 'x', 'Folic Acid 5mg', 300, 'Capsule', '900.00')}
${row(1, 51191704, 'Multiple electrolyte solutions', 'D5 LR 1000ML.', 28000, 'Bottle', '1,076,320.00')}</table>`;
const items = readLineItems(parse(html), match);
const by = Object.fromEntries(items.map((i) => [i.item_no, i]));
assert.deepEqual(Object.keys(by).sort(), ['238', '30', '517'], 'our lines only: not 10 mL Heparin, not Folic Acid capsules, not D5 LR');
assert.deepEqual([by[30].quantity, by[30].unit, by[30].total, by[30].unit_price], [15000, 'Vial', 1236600, 82.44]);
assert.equal(by[238].unit_price, 68);
assert.deepEqual(by[517].products, ['Folic Acid']);
console.log('  ok    our lines read with Qty, unit, ABC and ABC/Unit (ABC ÷ Qty)');
console.log('  ok    another pack volume and another form are left out');
assert.deepEqual(readLineItems(parse('<table><tr><th>Name</th></tr><tr><td>Heparin 1000 IU/ml, 5ml</td></tr></table>'), match), []);
console.log('  ok    a table without Description and Quantity columns is not read');
// PS 161025 (Western Visayas Medical Center, user 2026-11-26): the hospital's own tables pasted in the notice's
// Description, one per category, their header a plain row ("Sr.No. | Item Code | Lot Name | Lot Description | Quantity
// | Unit of Measure | Estimated Budget"); the notice showed every line with its budget, the dashboard none
{
  const head = row('Sr.No.', 'Item Code', 'Lot Name', 'Lot Description', 'Quantity', 'Unit of Measure', 'Estimated Budget');
  const pasted = `<div>Description:</div><table>
<tr><td colspan="7">Category 4 - Antibacterials</td></tr>${head}
${row(2, 51284603, 'Ertapenem', 'Ertapenem (as sodium salt) Inj.: 1 g powder, vial (IM/IV)', 500, 'Vial', '750,000.00')}
${row(3, 51282702, 'Cefoxitin', 'Cefoxitin 1g vial (IM, IV)', '45,000', 'Vial', '2,250,000.00')}
<tr><td colspan="5"></td><td>Total Approved Budget</td><td>3,000,000.00</td></tr>
<tr><td colspan="7">Category 11 - Blood products</td></tr>${head}
${row(2, 51131602, 'Heparin', 'Heparin 1000 IU/mL 5 mL vial (IV infusion, SC) (bovine origin)', '5,000', 'Vial', '340,000.00')}
</table>`;
  const lines = readLineItems(parse(pasted), match);
  assert.deepEqual(lines.map((i) => [i.products[0], i.item_no, i.quantity, i.unit, i.total, i.unit_price]), [['Cefoxitin', '3', 45000, 'Vial', 2250000, 50], ['Heparin', '2', 5000, 'Vial', 340000, 68]], 'our lines of both categories, each with its budget');
  console.log('  ok    tables pasted in the Description (plain header rows, one per category) are read');
  // The same table inside a layout table is read once
  assert.equal(readLineItems(parse(`<table><tr><td>${pasted}</td></tr></table>`), match).length, 2, 'a table inside another: each row once');
  console.log('  ok    a table inside a layout table gives each row once');
}
console.log('\nNotice line items check passed (5 checks).');
