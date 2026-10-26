// Item line check, part of the safety gate (tools/safety-gate.sh) and runnable by hand:
//   node tools/check-item-lines.mjs
// Real tender rows (PhilGEPS and PS-PhilGEPS documents and notice pages) against the quantity, unit and
// row number the molecule tracker must show. The row number must never be read as the quantity (user,
// 2026-10-26: PS 111622 showed Cetirizine 25 box where the document asks for 250). Any wrong answer blocks the push.
import assert from 'node:assert/strict';
import { parseItemLine, parseItemRow } from '../frontend/src/lib/psDocs.mjs';

const pick = ({ item_no, quantity, unit, unit_price, total }) => ({ item_no, quantity, unit, unit_price, total });
const expect = (got, want, label) => {
  const shown = pick(got);
  for (const [key, value] of Object.entries(want)) assert.equal(shown[key], value, `${label}: ${key} is ${shown[key]}, should be ${value}`);
};

// One-line rows
const LINES = [
  // Item | Unit | Description | Quantity (PS 111622, City of Biñan)
  ["40 box Loratidine 10 mg Tablet 100's 150", { item_no: '40', unit: 'box', quantity: 150 }],
  ["25 box Cetirizine 10mg Tablet 100's 250", { item_no: '25', unit: 'box', quantity: 250 }],
  // Item | Quantity | Unit | Description | Unit Price | Total
  ['3 450 vials Carboplatin 450mg/45mL 1,828.40 822,780.00', { quantity: 450, unit_price: 1828.4, total: 822780 }],
  // Item | Quantity | Unit | Description
  ['21. 5000 TAB LOSARTAN 100 MG', { item_no: '21', quantity: 5000, unit: 'TAB' }],
  // Item | Description | Quantity | Unit
  ['9 MIDAZOLAM 5MG/ML AMPULE 10’S 40 BX', { item_no: '9', quantity: 40, unit: 'BX' }],
  // Quantity | Unit | Description (no row number)
  ['500 tablets Amlodipine 5mg', { quantity: 500, unit: 'tablets' }],
  // Layouts ending in "<unit price> <total>"
  ['500 TABLET Amlodipine 5 mg Tablet 2 1,000.00', { quantity: 500, unit_price: 2, total: 1000 }],
  ['55100000 vial Vancomycin 500mg, 1gram 3000 450.00 1,350,000.00', { item_no: '55100000', quantity: 3000, unit_price: 450 }],
];
for (const [line, want] of LINES) expect(parseItemLine(line), want, line);

// Rows broken over lines (the text layer or OCR puts the quantity column on the next line)
const PAGE = [
  "24 box Celecoxib 400mg 100's 100",
  '25 box Cetirizine',
  "10mg Tablet 100's 250",
  '26 bottle Cetirizine 5mg/5ml 60ml Syrup 200',
  '35 box Folic Acid 5mg tablet 1',
  "OO's",
  '100',
  "36 box Gliclazide 30 mg Modified Release Tablet 100's 100",
];
const ROWS = [
  [1, { item_no: '25', quantity: 250 }],
  [3, { item_no: '26', quantity: 200 }],
  [4, { item_no: '35', quantity: 100 }],
  [7, { item_no: '36', quantity: 100 }],
];
for (const [n, want] of ROWS) expect(parseItemRow(PAGE, n), want, PAGE[n]);

// The next row's number on a line of its own is not this row's quantity (PS 111622)
expect(parseItemRow(['25 box Cetirizine', "10mg Tablet 100's 250", '26'], 0), { item_no: '25', quantity: 250 }, 'row number on its own line');
// 88 is the Item No. (87 before, 89 after), so the row shows no quantity rather than 88 (user, 2026-10-26)
expect(parseItemRow(['87 box Levocetirizine 5mg/tab x 100 20', '88 box | Loratadine 10mg/tab x 100', '89'], 1), { item_no: '88', quantity: undefined }, 'next row number after a pack size');
// A priced row keeps its own reading, whatever follows it
expect(parseItemRow(['3 450 vials Carboplatin 450mg/45mL 1,828.40 822,780.00', 'Total 822,780.00'], 0), { quantity: 450 }, 'priced row');
// A row with its quantity on its own line doesn't take the next rows' (PhilGEPS 13296768, a list without row numbers)
const LIST = ['Cetirizine 5mg/5ml, 30ml syrup 100 Bottles', 'Cetirizine 2.5mg/ml, 0 ml Oral Drops 100 Bottles', 'Cetirizine 10 mg 500 Tablets', 'Cinnarizine 25 mg 3000 Tablets'];
[100, 100, 500].forEach((quantity, n) => expect(parseItemRow(LIST, n), { quantity }, LIST[n]));
// A row whose quantity is on the next line (PhilGEPS 13301146, 13277104)
expect(parseItemRow(['12 cetirizine tablet 10mg (as', 'dihydrochloride) 40 box', '13 cetirizine drops 10mg/ml (as'], 0), { quantity: 40, unit: 'box' }, 'quantity on the next line');
expect(parseItemRow(['42 Cefoxitin 1 g Powder for Injection', 'Vial 100 vials', '43 Ceftaxidime (Ceftazidime) 1 g'], 0), { quantity: 100 }, 'unit and quantity on the next line');
// The next row's quantity line is not taken ("5,000 tablet" / "10 30,000 Tablet" start rows)
expect(parseItemRow(['Filgrastim 300 mcg/0.5 mL solution for injection', 'in pre-filled syringe (IV, SC) 1,500.00', '5,000 tablet'], 0), { quantity: undefined }, 'next row quantity');
// OCR'd scans (PS 111619, Biñan City Hospital): a smudged next row, a two-word unit, table rules left in, a lone ","
const SCAN = ["14 boxes Cetirizine 10mg Tablet 100's 10", "© 1s boxes Cefuroxime 500mg 10's 3570", "16 box Cinnarizine 25mg Tablet 100's 10"];
expect(parseItemRow(SCAN, 0), { item_no: '14', quantity: 10 }, 'smudged next row');
expect(parseItemRow(['97 prefilled syringe Enoxaparin 100mg/ml ,0.4ml 50', '98 prefilled syringe Enoxaparin 100mg/mL 0.6m 60'], 0), { quantity: 50, unit: 'prefilled syringe' }, 'two-word unit');
expect(parseItemRow(['| 75 | vials | Propofol 10mg/ml,20ml | 420 |'], 0), { item_no: '75', quantity: 420, unit: 'vials' }, 'table rules');
expect(parseItemRow(['58 vials Ceftriaxone 1g powder for Inj. 2000', '59 vials Cefuroxime 750mg powder for Inj. 500 |', '| 60 | vials] Cefoxitin 1g powder forv In], I.'], 2), { item_no: '60', quantity: undefined }, 'no quantity on the row');
// The form under the table is not part of the last row
const LAST = ['58 vials Ceftriaxone 1g powder for Inj. 2000', '59 vials Cefuroxime 750mg powder for Inj. 500', '60 vials Cefoxitin 1g powder for Inj.', 'Purpose: Purchase of Drugs and Medicine of Binan City Hospital', 'Requested By: Approved by:'];
const lastRow = parseItemRow(LAST, 2);
expect(lastRow, { item_no: '60', quantity: undefined }, 'last row');
assert.ok(!/Purpose/.test(lastRow.description || ''), `last row: the form's "Purpose" is in its description: ${lastRow.description}`);
// Rows numbered in order: the first number is the Item No., never the quantity (PhilGEPS 13291631, Cajidiocan:
// "ITEM NO. | UNIT | ITEM DESCRIPTION | QUANTITY"; was read as 2 and 3)
const NUMBERED = ['ITEM NO. UNIT ITEM DESCRIPTION QUANTITY', '1 Boxes Metformin 500mg/tab 100’s, Retimed 100', '2 Boxes Losartan 50mg/tab (60’s), Retimed 105', '3 Boxes Amlodipine 5mg/tab (100’s), Retimed 131', 'SIGNED'];
[[1, '1', 100], [2, '2', 105], [3, '3', 131]].forEach(([n, item_no, quantity]) => expect(parseItemRow(NUMBERED, n), { item_no, quantity, unit: 'Boxes' }, NUMBERED[n]));
// A row numbered in order whose quantity cell is empty shows none (not its Item No.)
expect(parseItemRow(['4 vials Ceftriaxone 1g powder', '5 vials Cefoxitin 1g powder', '6 vials Cefuroxime 750mg powder'], 1), { item_no: '5', quantity: undefined }, 'numbered row without quantity');
// A lone row on its own (no numbering around it) keeps "<qty> <unit> <description>"
expect(parseItemRow(['500 tablets Amlodipine 5mg'], 0), { quantity: 500 }, 'quantity first, no numbering');
// A quantity-first list with repeated or close quantities is not numbering (PhilGEPS 13302304, 13288387)
const QTY_LIST = ['500 tab Cetirizine 10 mg (as dihydrochloride)', '1 bot Cetirizine 2.5mg/ml (as dihydrochloride) drops in 10ml', '1 bot Cetirizine 10mg/ml (as dihydrochloride) drops in 10ml', '1 bot Cetirizine 1mg/ml solution in 30ml'];
expect(parseItemRow(QTY_LIST, 2), { quantity: 1, unit: 'bot' }, 'repeated quantities');
const QTY_LIST2 = ['25 box Cetirizen Dihydrochloride 10mg tablet 100s/box', '10 btl Cetirizen Dihydrochloride 10mg/ml drops, 10ml', '11 box Loratadine 10mg tablet, 100s/box', '25 box Mefanamic Acid 500mg'];
expect(parseItemRow(QTY_LIST2, 1), { quantity: 10, unit: 'btl' }, 'two close quantities');
// Numbered rows read normally keep their quantity (PS 106895, PS 107827, PhilGEPS 13277448, 13290623)
const PS106895 = ['36 Erythropoietin Alfa 2,000IU/0.5ml PFS 500 pfs', '37 Erythropoietin Alfa 4,000IU/0.4ml PFS CPR & COD 1000 pfs', '38 Esomeprazole 40mg tablet 300 tablet'];
expect(parseItemRow(PS106895, 1), { item_no: '37', quantity: 1000, unit: 'pfs' }, 'numbered row, quantity and unit at the end');
const PG13277448 = ['21. 500 Ampule/Vial ENALAPRILAT 1.25 mg/mL', '22. 1,200 PFS ENOXAPARIN 100 mg/mL, 0.4 mL pre-filled syringe (as sodium salt)', '23. 300 Ampule/Vial EPINEPHRINE 1 mg/mL'];
expect(parseItemRow(PG13277448, 1), { item_no: '22', quantity: 1200 }, 'Item | Quantity | Unit | Description');
const PG13290623 = ['30 200 Vial Cefotaxime, 1 gm', '31 500 Vial Cefoxitin, 1 gm', '32 300 Vial Ceftazidime, 1 gm'];
expect(parseItemRow(PG13290623, 1), { item_no: '31', quantity: 500, unit: 'Vial' }, 'strength unit "gm" is not the unit');
// Unit before the quantity (PhilGEPS 13262985) and a price before the quantity (PhilGEPS 13271780)
const PG13262985 = ['50 Tablet 1,000 Celecoxib 200mg', '51 Tablet 2,500 Cetirizine 10mg/tablet', '52 Tablet 500 Cinnarizine 25mg'];
expect(parseItemRow(PG13262985, 1), { item_no: '51', quantity: 2500, unit: 'Tablet' }, 'Item | Unit | Quantity | Description');
expect(parseItemRow(["1 092600000 Lapatinib 250mg tablet, bottle of 30’s 12,375.00 90 Bottle 1,113,750.00"], 0), { quantity: 90, unit_price: 12375, total: 1113750 }, 'price before quantity');
// An amount with centavos is never the quantity (PhilGEPS 13301894 Bicol Regional, 13295249)
const PG13301894 = ['2 186,600.00 Idarubicin 1 mg/ml, 10 ml vial 50 vial', '3 293,100.00 Oxaliplatin 5 mg/ml, 10 mi solution for injection vial 300 vial', '4 250,000.00 Paclitaxel 6 mg/ml, 16.7 ml vial (IV, IV infusion) 100 vial'];
expect(parseItemRow(PG13301894, 1), { quantity: 300, unit: 'vial' }, 'price after the Item No.');
expect(parseItemRow(PG13301894, 2), { quantity: 100, unit: 'vial' }, 'price after the Item No. (last row)');
expect(parseItemRow(['vial 242,560.00 Propofol 10mg/ml.,20ml. Injection'], 0), { quantity: undefined }, 'amount after the unit');
// Item | Quantity | Unit | Price | Description, a numbered row read again without its Item No. (PhilGEPS 13295249)
const PG13295249 = ['13 1,000 amp/vial 120,000.00 Propofol 10mg/ml, 20ml', '14 2,500 amp/vial 287,225.00 Rocuronium Bromide 10mg/ml, 5ml injection', '15 500 amp/vial 45,000.00 Sevoflurane'];
expect(parseItemRow(PG13295249, 1), { item_no: '14', quantity: 2500 }, 'quantity after the Item No., then a price');
// Unit "Ampule/Vial" (PhilGEPS 13277448)
const PG13277448b = ['2. 100 Ampule/Vial ADENOSINE 3 mg/mL, 2 mL', '3. 200 Ampule/Vial AMIKACIN 125 mg/mL (as sulfate), 2 mL ampule/vial 49.00', '4. 300 Ampule/Vial AMINOPHYLLINE 25 mg/mL'];
expect(parseItemRow(PG13277448b, 1), { item_no: '3', quantity: 200, unit: 'Ampule/Vial' }, 'unit with a slash');
// Quantity at the end of a numbered row after a pack size (PhilGEPS 13264900)
const PG13264900 = ['27 Cefuroxime 500mg/tablet X 100 200', '28 Cetirizine 10mg/tablet X 100 340', '29 Ciprofloxacin 500mg/tablet X 100 100'];
expect(parseItemRow(PG13264900, 1), { item_no: '28', quantity: 340 }, 'quantity after a pack size');
// A strength split over lines is not a quantity (PS 102904 "1" / "g", PS 105627 "4000" / "IU/Ml", PhilGEPS
// 13277104 "4" / "mL")
const PS102904 = ['68 Cefazolin sodium 1 g Vial 100 20,000.00', '69 Cefepime hydrochloride 1', 'g Vial 50 15,000.00', '70 Cefepime hydrochloride 500mg 1,000 500,000.00'];
expect(parseItemRow(PS102904, 1), { item_no: '69', quantity: undefined }, '"1" / "g": a strength');
const PG13277104 = ['30 Bupivacaine 0.5%, 10 mL Amp 100', '31 Bupivacaine + Dextrose 0.5% + 8%, 4', 'mL Solution for Injection Amp', '32 Butamirate 50 mg Modified Release'];
expect(parseItemRow(PG13277104, 1), { item_no: '31', quantity: undefined }, '"4" / "mL": a strength');
// A bare quantity checked by price x quantity = total stays (PS 99596)
expect(parseItemRow(['22 4870 bottle 55.36 269,603.20 Cetirizine 2.5mg/ml', '23 96986 tablet 8.00 775,888.00 Cetirizine 10mg tablet', '24 4870 bottle 55.36 269,603.20 Cetirizine drops'], 1), { quantity: 96986 }, 'quantity checked by its total');
// Item | Description | Quantity | Estimated Cost per Item (PhilGEPS 13262985): the quantity, not the cost
const PG13262985b = ['50 Celecoxib 200mg/cap 500 15', '51 Cetirizine 10mg/tablet 2,500 10', '52 Cetirizine 1mg/ml 60ml 500 100'];
expect(parseItemRow(PG13262985b, 1), { item_no: '51', quantity: 2500 }, 'quantity before the cost');
// A quantity without its unit at the end of the line stays this row's
expect(parseItemRow(['CETIRIZINE 10MG TABLET 15', 'SALBUTAMOL + IPRATROPIUM', "200MCG/1MG/ML NEBULE 30'S 40 BOX"], 0), { quantity: undefined }, 'bare quantity');
// OCR's dot between thousands, checked by price x quantity = total (PhilGEPS 13295969: 7,826 x 1,050.00)
expect(parseItemRow(["12 \\ bx Cetirizine Hydrochloride 10mg tab.100's . 7.826 1050.00 ~ 8,217,300.00"], 0), { quantity: 7826, unit_price: 1050, total: 8217300 }, 'dot between thousands');

// Rows the team screened by hand (PHILGEPS OPPORTUNITY sheet, 2026-10-26) with their quantity and ABC:
// Item | Description | Unit Price | Quantity | Unit (PhilGEPS 13298321 Bicol Medical Center: 27,100 tab, ABC 385,633)
expect(parseItemRow(['1 Capecitabine 500mg film coated/tablet (VAT EXEMPT) 14.23 27.100 tab'], 0), { quantity: 27100, unit: 'tab', unit_price: 14.23 }, 'unit price then quantity (dot between thousands)');
expect(parseItemRow(['2 Cytarabine 100mg/mL solution for injection 1ml 350.00 1000 vial'], 0), { quantity: 1000, unit: 'vial', unit_price: 350 }, 'unit price then quantity');
// Item | Unit | Description | Quantity | Unit Price (PhilGEPS 13303622 Jose B. Lingad: 3,000 tablets, ABC 57,000)
expect(parseItemRow(['10 Tablet Capecitabine 500Mg In Blister Or Foil Pack 3,000 19.00'], 0), { quantity: 3000, unit: 'Tablet', unit_price: 19 }, 'quantity then unit price');
// Item | ABC Total | Description | Quantity | Unit (PhilGEPS 13301894 Bicol Regional: Idarubicin 100 vials, ABC 650,000)
expect(parseItemRow(['1 650,000.00 Idarubicin (as hydrochloride) powder, 5 mg vial 100 vial'], 0), { quantity: 100, unit: 'vial', total: 650000 }, 'ABC total after the Item No.');
// QUANTITY | UNIT on the line above, ABC/unit after the description (PhilGEPS 13298769 Far North Luzon)
const FNL = ['QUANTITY UNIT DESCRIPTION ABC/unit BRAND UNIT PRICE', '200 PFS', 'Filgrastim 300 mcg/0.5 mL solution for injection', 'in pre-filled syringe (IV, SC) 1,500.00', '5,000 tablet', 'Letrozole 2.5mg tablet', '27.55', '400 tablet', 'Capecitabine 500mg tablet', '37.50'];
expect(parseItemRow(FNL, 2), { quantity: 200, unit: 'PFS', unit_price: 1500 }, 'quantity on the line above');
expect(parseItemRow(FNL, 5), { quantity: 5000, unit: 'tablet', unit_price: 27.55 }, 'quantity on the line above, price alone below');
expect(parseItemRow(FNL, 8), { quantity: 400, unit: 'tablet', unit_price: 37.5 }, 'quantity on the line above (last row)');

// A large amount after a sizeable quantity is the ABC total (PhilGEPS 13271506: 100 boxes, ₱336,000.00)
expect(parseItemRow(["32 box Cetirizine 10mg, tablet, (100's) 100 336,000.00"], 0), { quantity: 100, unit: 'box', total: 336000, unit_price: undefined }, 'ABC total after the quantity');
// A strength on the line above is not a quantity
expect(parseItemRow(['Paracetamol', '500 mg', 'Cetirizine 10mg tablet'], 2), { quantity: undefined }, 'strength on the line above');

// Read by the table's own header (user, 2026-10-26): each value from its column
const PR = ['Section: FPP :', 'Item No. Unit Item Description Quantity Unit Cost Total Cost', '1 btl Amoxicillin (as trihydrate) 250mg/5ml Powder for suspension 60ml/Oral 22,752 78.00 1,774,656.00', '2 vial Cefoxitin 1g powder for injection 500 300.00 150,000.00'];
expect(parseItemRow(PR, 2), { item_no: '1', unit: 'btl', quantity: 22752, unit_price: 78, total: 1774656 }, 'header: Item No. | Unit | Description | Quantity | Unit Cost | Total Cost');
expect(parseItemRow(PR, 3), { item_no: '2', unit: 'vial', quantity: 500, unit_price: 300, total: 150000 }, 'header: second row');
// Header broken over two lines, a description ending in a number, an empty Unit Cost cell
const PR2 = ['Item', 'No. Unit Description Quantity Unit Cost Total Cost', '27 box Cefuroxime 500mg/tablet X 100 200 22,000.00', '28 box Cetirizine 10mg/tablet X 100 340 37,400.00'];
expect(parseItemRow(PR2, 3), { item_no: '28', unit: 'box', quantity: 340, total: 37400 }, 'header over two lines, empty Unit Cost');
// Quantity before the description: "Qty | Unit | Description | ABC/unit"
const RFQ = ['QTY UNIT DESCRIPTION ABC/UNIT TOTAL ABC', '100 vials Propofol 10mg/ml, 20ml 240.00 24,000.00', '50 amp Amiodarone 50mg/ml, 3ml 120.00 6,000.00'];
expect(parseItemRow(RFQ, 2), { quantity: 50, unit: 'amp', unit_price: 120, total: 6000 }, 'header: Qty | Unit | Description | ABC/unit | Total');
// A row that doesn't fit its header falls back to the row rules (the Item No. is never the quantity)
const SHIFT = ['Item No. Unit Description Quantity', '58 vials Ceftriaxone 1g powder for Inj. 2000', '59 vials Cefuroxime 750mg powder for Inj. 11000', '60 vials Cefoxitin 1g powder forv Inj.', 'Purpose: Purchase of Drugs'];
expect(parseItemRow(SHIFT, 3), { item_no: '60', quantity: undefined }, 'header: row with an empty Quantity cell');

// An amount in a column it can't be (PhilGEPS 13300924: a header from another table names "Total")
const WRONG_HEADER = ['Item No. Description Quantity Total Delivery Schedule', '6. Aminophylline 25mg/ml 500 30.00', '7. Amikacin 250mg/ml, 2ml 1,500 65.00'];
expect(parseItemRow(WRONG_HEADER, 2), { quantity: 1500, unit_price: 65, total: undefined }, 'header: a "total" under ₱0.10 a unit is the unit price');
// "QTY UNIT ESTIMATED BUDGET": the amount is the total (PhilGEPS 13300226)
expect(parseItemRow(['Item Number Description QTY UNIT ESTIMATED BUDGET', '18 Cetirizine 10mg tablet 3000 pcs 2,100.00'], 1), { item_no: '18', quantity: 3000, unit: 'pcs', total: 2100 }, 'header: Description | Qty | Unit | Estimated Budget');

// Several rows on one line under a header: the first row's quantity (PhilGEPS 13296768)
const PG13296768 = ['Item Description Qty Unit Price', 'Cetirizine 10 mg 500 Tablets', 'Cinnarizine 25 mg 3000 Tablets', 'Epinephrine 1mg/ml, 1ml 100 Ampules'];
expect(parseItemRow(PG13296768, 1), { quantity: 500 }, 'header: rows under it not joined into one');
// The row's Item No. and Unit on the line above (PhilGEPS 13303642: 180 @ 99.78, not 1)
expect(parseItemRow(['Item No. Unit Description Quantity Unit Cost', '1 Ampule', 'or Vial Rocuronium Br 10Mg/Ml-5Ml Iv 180 99.78'], 2), { item_no: '1', quantity: 180, unit_price: 99.78 }, 'Item No. and Unit on the line above');
// "<qty> <unit>" above, under a header with the Quantity after the Description: the row before's (PhilGEPS 13283536)
expect(parseItemRow(['Item Description Quantity Unit', '7 Cefuroxime 500 mg tablet x 100', '144 bottles', '8 Cetirizine 10 mg tablet x'], 3), { quantity: undefined }, 'quantity above under a Description-first header');

console.log(`Item line check passed (${LINES.length + ROWS.length + 58} rows).`);
