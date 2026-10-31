// Item line check, part of the safety gate (tools/safety-gate.sh) and runnable by hand:
//   node tools/check-item-lines.mjs
// Real tender rows (PhilGEPS and PS-PhilGEPS documents and notice pages) against the quantity, unit and
// row number the molecule tracker must show. The row number must never be read as the quantity (user,
// 2026-10-26: PS 111622 showed Cetirizine 25 box where the document asks for 250). Any wrong answer blocks the push.
import assert from 'node:assert/strict';
import { PACKAGE_ROW, isPackageTender } from '../frontend/src/lib/packageTender.js';
import { carryHeader, dropRepeatedRows, expandVariants, isVariantParent, parseItemLine, parseItemRow, isTableRow, keepBestReading, lotSchedule, columnRows, manyLots, lotHeading, wholeLot, completeLots, lotRowKey, readBidDataSheet, rowAhead, withBothAmounts, withPageMeaning } from '../frontend/src/lib/psDocs.mjs';

const pick = ({ item_no, quantity, unit, unit_price, total, computed, description }) => ({ item_no, quantity, unit, unit_price, total, computed, description });
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
// Read through to its quantity on the next line: 1 g, 50 vials (not 1)
expect(parseItemRow(PS102904, 1), { item_no: '69', quantity: 50 }, '"1" / "g": a strength');
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

// A molecule with its strengths as sub-rows (Philippine Heart Center 13265275/13265216, as the team screened them:
// Amikacin 2,000 ampule, Propofol 2,000 and 200; totals over 12 months, so quantity x price != total)
const PHC = ['AMINOGLYCOSIDE', '33 Amikacin sulfate', '.01 250mg/ml, 2ml ampule 2,000 235.00 5,640,000.00', '34 Gentamicin sulfate', '.01 40mg/ml, 2ml ampule 30 29.00 10,440.00', '12 Propofol', '.01 10mg/ml, 20ml ampule or vial 2,000 445.00 10,680,000.00', '.02 10mg/ml, 50ml vial 200 1,150.00 2,760,000.00'];
const PHC_ROWS = expandVariants(PHC);
assert.equal(PHC_ROWS[2], '33.01 Amikacin sulfate 250mg/ml, 2ml ampule 2,000 235.00 5,640,000.00', 'sub-row: molecule name added');
assert.ok(isVariantParent(PHC, 1) && !isVariantParent(PHC, 2), 'sub-rows: the molecule line is not a row');
expect(parseItemRow(PHC_ROWS, 2), { item_no: '33.01', quantity: 2000, unit: 'ampule', unit_price: 235, total: 5640000 }, 'sub-row: Amikacin 2,000');
expect(parseItemRow(PHC_ROWS, 6), { item_no: '12.01', quantity: 2000, unit_price: 445 }, 'sub-row: Propofol 20ml 2,000');
expect(parseItemRow(PHC_ROWS, 7), { item_no: '12.02', quantity: 200, unit: 'vial', unit_price: 1150 }, 'sub-row: Propofol 50ml 200');

// A long table over several pages (PhilGEPS 13309076, Adela Serra Ty MMC): header over four lines on page 70, rows
// of up to nine lines (description, then "<qty> <unit> ₱ <unit cost> ₱ <total>", then the delivery split), and
// page 71 going on without the header
const P70 = ['8. PURCHASE ORDER', 'Item', 'No. Description Quantity Unit Unit Cost Total Cost', 'Delivery Schedule', '1st Delivery 2nd Delivery 3rd Delivery', '1 ALPRAZOLAM 250MCG', 'TABLET', '100 Tablet ₱ 4.65 ₱ 465.00', '100 - -', '3 BUPIVACAINE (AS', 'HYDROCHLORIDE) 0.5%,', '5ML ISOBARIC POLYAMP', '1,500 Ampule ₱ 500.00 ₱ 750,000.00', '1,500 - -'];
let carried = carryHeader(P70, null);
expect(parseItemRow(P70, 9), { item_no: '3', quantity: 1500, unit: 'Ampule', unit_price: 500, total: 750000 }, 'long table: row over four lines, ₱ signs');
const P71 = ['Department of Health', 'Effectivity Date July 23, 202571', '4 BUPIVACAINE', 'HYDROCLORIDE 0.5%,', '4ML W/ 8%', '(SENPIVAC)DEXTROSE', 'HEAVY BUPIVACAINE', 'HYDROCLORIDE 0.5%,', '4ML W/ 8% DEXTROSE', 'HEAVY', '700 Ampule ₱ 200.00 ₱ 140,000.00', '700', '- -', '30 PLAIN NSS 1 LITER', '94,920 Bottle ₱ 60.00 ₱ 5,695,200.00 50,000 44,920 50,000', '31 PROPOFOL 10MG/ML,', '20ML AMPULE', '2,100 Ampule ₱ 90.00 ₱ 189,000.00'];
carried = carryHeader(P71, carried);
expect(parseItemRow(P71, 2), { item_no: '4', quantity: 700, unit_price: 200, total: 140000 }, 'long table: next page without a header, nine-line row');
expect(parseItemRow(P71, 13), { item_no: '30', quantity: 94920, unit_price: 60, total: 5695200 }, 'delivery split columns are not the quantity');
expect(parseItemRow(P71, 15), { item_no: '31', quantity: 2100, unit: 'Ampule', unit_price: 90, total: 189000 }, 'long table: Propofol 2,100 (not its Item No. 31)');
// A page starting another table (Technical Specifications) doesn't take the header
const P75 = ['Technical Specifications', 'Item Specification Statement of Compliance', '3 BUPIVACAINE (AS HYDROCHLORIDE)'];
assert.equal(carryHeader(P75, carried), null, 'a new table stops the carried header');
// A text column after the numbers (PhilGEPS 13308657, Tarlac Provincial Hospital: "Item Number | Description |
// Quantity | Total | Delivery Schedule"; the row on page 65, the header on page 64)
const P64 = ['Item', 'Number Description Quantity Total Delivery', 'Schedule', '1 0.9% Sodium chloride, breakable 1000 ml 100 6,500.00 Fifteen (15)', 'calendar days'];
const P65 = ['calendar days', '54 Rocuronium bromide 10mg/ml, 5ml vial 200 70,000.00 Fifteen (15)', 'calendar days'];
carryHeader(P65, carryHeader(P64, null));
expect(parseItemRow(P65, 1), { item_no: '54', quantity: 200, total: 70000 }, 'Delivery Schedule text after the numbers');
assert.equal(parseItemRow(P65, 1).description, 'Rocuronium bromide 10mg/ml, 5ml vial', 'the delivery text is not in the name');
// The same product listed again without a quantity is dropped when its row was read
const ITEMS = [
  { our_products: ['Rocuronium'], item_no: '54', quantity: 200, written: '54 Rocuronium bromide 10mg/ml, 5ml vial 200 70,000.00 Fifteen (15)', description: 'Rocuronium bromide 10mg/ml, 5ml vial' },
  { our_products: ['Rocuronium'], written: 'Rocuronium bromide 10mg/ml, 5ml' },
  { our_products: ['Bupivacaine'], item_no: '4', written: '4 BUPIVACAINE (AS HYDROCHLORIDE)' },
];
dropRepeatedRows(ITEMS);
assert.equal(ITEMS.length, 2, 'repeated Rocuronium line dropped, Bupivacaine (no row with a quantity) kept');

// One amount after the quantity (audit of all tenders, 2026-10-27): the unit price for injectables, the total when it
// comes to ₱100 or less a tablet/piece; delivery text ("Fifteen (15) calendar") and "-do-" set aside
const ONE = [
  ['12 Sugammadex 100mg/ml,2ml solution for injection CPR & COD 40 vial 5,818.00', { quantity: 40, unit: 'vial', unit_price: 5818, total: undefined }],
  ['1 Amikacin, 125mg/mL (as sulfate), 2ml 100 vial 215.00', { quantity: 100, unit_price: 215 }],
  ['18 Cetirizine 10mg tablet 3000 pcs 2,100.00', { quantity: 3000, unit: 'pcs', total: 2100, unit_price: undefined }],
  ['34 Cetirizine 10mg 18800 6,392.00', { quantity: 18800, total: 6392 }],
  ['15 Epoetin (4000IU) vial 1400 1,050,000.00', { quantity: 1400, total: 1050000 }],
  ['85 Cetirizine 10mg CPR & COD 2,500 tablet 3.00', { quantity: 2500, unit: 'tablet', unit_price: 3 }],
  ['1 Anastrozole 1 mg tablet 25,000 18.50 462,500.00 Fifteen (15)', { quantity: 25000, unit_price: 18.5, total: 462500 }],
  ['13 Cetirizine 10 mg Tablet tablet 15,000 9.20 138,000.00 Fifteen (15) calendar', { quantity: 15000, unit: 'tablet', unit_price: 9.2, total: 138000 }],
  ['4 Propofol ampule 10mg/ml, 20ml 50 amp 50 amp -do-', { quantity: 50 }],
];
for (const [line, want] of ONE) expect(parseItemRow([line], 0), want, line);

// An ABC/unit can't be hundreds of thousands: always the ABC total (user, 2026-10-27), whatever the layout
// A description going on with a strength ("100 mg tablet") is not the next row (PhilGEPS 13309534 Imatinib row 48)
const SOR = ['Item', 'No. ITEM DESCRIPTION QTY Unit UNIT COST TOTAL ABC DELIVERY', 'SCHEDULE', '48 IMATINIB (as mesilate) Oral:', '100 mg tablet', 'VAT-exempt', '8,000 tablet 36.00 288,000.00 As stated in the', 'Delivery', 'Schedule', '49 IMATINIB (as mesilate) Oral:', '400 mg tablet'];
expect(parseItemRow(SOR, 3), { item_no: '48', quantity: 8000, unit: 'tablet', unit_price: 36, total: 288000 }, 'strength on the next line is not a new row');
expect(parseItemRow(['5 vial Rocuronium 10mg/ml 5ml 10 150,000.00'], 0), { quantity: 10, total: 150000, unit_price: undefined }, 'one amount of 150,000.00 is the total');
expect(parseItemRow(['Item No. Description Quantity Unit Cost', '7 Propofol 10mg/ml, 20ml 200 189,000.00'], 1), { quantity: 200, total: 189000, unit_price: undefined }, 'header "Unit Cost" of 189,000.00 is the total');

// The missing amount worked out as the sheet does (user, 2026-10-27): ABC/Unit = Total ÷ Qty, Total = Qty × ABC/Unit
expect(withBothAmounts(parseItemRow(['54 Rocuronium bromide 10mg/ml, 5ml vial 200 70,000.00 Fifteen (15)'], 0)), { quantity: 200, unit_price: 350, total: 70000 }, 'ABC/Unit from the total');
expect(withBothAmounts({ quantity: 3000, unit_price: 2.59 }), { total: 7770 }, 'total from the ABC/Unit');
// No header, the description over lines and its numbers some lines below (PS 107172)
const BELOW = ['6 Dabigatran 150mg capsule 3,000 92.65 277,950.00', '7', 'Epoetin alfa 4000iu/0.4ml OR', '4000iu/1ml,IV,SC (Recombinant Human', 'Erythropoetin), prefilled syringe', 'prefilled', 'syringe/vial 10,000 450.00 4,500,000.00', '8 Epoetin alfa 10,000 iu/ml (Recombinant', 'Human Erythropoetin), prefilled syringe', 'prefilled', 'syringe 3,500 1,388.00 4,858,000.00', '9'];
expect(parseItemRow(BELOW, 2), { item_no: '7', quantity: 10000, unit_price: 450, total: 4500000 }, 'numbers lines below, number above');
expect(parseItemRow(BELOW, 7), { item_no: '8', quantity: 3500, unit_price: 1388, total: 4858000 }, 'numbers lines below, number on the row');
// Item | Description | Unit | Quantity with a pack unit (PS 107903, 112846); "Within twenty (20)" delivery (13270448)
expect(parseItemRow(['ANTI-HISTAMINE', '', '16.Cetirizine, 10mg, tablet, 100’s box 50', ''], 2), { item_no: '16', quantity: 50, unit: 'box' }, 'pack unit then quantity');
expect(parseItemRow(['73 x', "74 Loratadine 10mg/ tab, 100's/ box box 21", '75 y'], 1), { item_no: '74', quantity: 21 }, 'pack unit twice then quantity');
expect(parseItemRow(['32 a', '33 Cetirizine 10mg/tab,100s 30 boxes 30 boxes Within twenty (20)', '34 b'], 1), { quantity: 30 }, 'delivery "Within twenty (20)"');

expect(withBothAmounts({ quantity: 200, total: 70000 }), { unit_price: 350, computed: 'unit_price' }, 'computed amount is marked');
// "Unit PR Price" with the bidder's empty "Unit Bid Price | Total Bid Price" and an empty Brand column (PhilGEPS 13309750)
const BID = ['ITEM QTY. UNIT DESCRIPTION BRAND (IF APPLICABLE) UNIT PR PRICE (PHP) UNIT BID PRICE (PHP) TOTAL BID PRICE (PHP)', '19 10 Box x', "20 2000 Box Cetirizine Dihydrochloride 10 mg Tablet, Box of 100's 1,125.00", '21 5 Box y'];
expect(parseItemRow(BID, 2), { quantity: 2000, unit_price: 1125, total: undefined, description: "Cetirizine Dihydrochloride 10 mg Tablet, Box of 100's" }, 'unit PR price, empty bid columns');
expect(parseItemRow(["41 4 Box Etoricoxib 60mg Film-Coated Tablet, Box of 100's 4,500.00"], 0), { quantity: 4, unit_price: 4500 }, 'qty first with an amount at the end');
// Quantity-first scan with the quantity on the row's second line and dots in amounts (PS 107166)
const EPA = ['Quantity Unit ! Item Description Souree Unit Cost Total Cost Bid Docs Price', 'x', 'oo BUPIVACAINE 0.5% a . HN', 'as hydrochlordey 4 ml.', '6.000 amp-vial (spinal) with 8% 69.18 413.074.00 |', 'dextrose'];
expect(parseItemRow(EPA, 2), { quantity: 6000, unit_price: 69.18, total: 413074 }, 'quantity on the second line');
// The quantity written twice on its own line (PS 105627)
expect(parseItemRow(['41 Cefalexin 500mg. Capsule 10,625 10,62', '5', '42 Cefazolin 1g. Vl. contains 90.0% - 115.0% calculated on the', 'labeled amount of Cefazolin preferrably (101.3%) complies with', 'USP43', '500 500', '43 Cefepime 500mg Powder for Injection Vial 400 400'], 2), { item_no: '42', quantity: 500 }, 'quantity twice');

// A row with its quantity whose description wraps and whose price ends the next line, with and without the header
// (PhilGEPS 13309780 Heparin, Iohexol)
const WRAP = ['47 3000 Ampoule Gentamicin (as sulfate) 80 mg/2mL (40 mg/mL) Solution for Injection', '(I.M./I.V.), 2 mL Ampoule 29.00', '48 200 Vial Heparin Sodium 1000 IU/mL (5,000 IU/5 mL) Solution for Injection', '(IV/SC), 5mL Vial 316.80', '49 8025 Vial Hydrocortisone (as sodium succinate) 100 mg Powder for Injection', "(IM/IV), Vial Box of 10's 165.00"];
expect(parseItemRow(WRAP, 2), { item_no: '48', quantity: 200, unit_price: 316.8 }, 'price on the wrapped line');
expect(parseItemRow(['ITEM QTY. UNIT DESCRIPTION BRAND (IF', 'APPLICABLE)', 'UNIT PR PRICE', '(PHP)', ...WRAP], 6), { item_no: '48', quantity: 200, unit_price: 316.8 }, 'price on the wrapped line, by header');

// Only a table's rows are fetched (user, 2026-10-27; PS 112460): not terms, specifications or bullet points
const TERMS = ['Terms and conditions:', '', 'ATRACURIUM BESYLATE 10mg/ml in 2.5ml ampule:onset: at intubating dose of 0.5mg/kg', '', '- Intravenous solution does not leak through the infusion set or stopper'];
assert.equal(isTableRow(TERMS, 2, parseItemRow(TERMS, 2)), false, 'terms paragraph is not a table row');
assert.equal(isTableRow(TERMS, 4, parseItemRow(TERMS, 4)), false, 'bullet point is not a table row');
assert.equal(isTableRow(['7', 'Epoetin alfa 4000iu/0.4ml OR'], 1, {}), true, 'row numbered on the line above');
// A header starts at its own first line, not the title above it (PS 107166: "BAC No." is not an Item No. column)
const TITLED = ['BAC No. EPA 2027-002', 'Supply and Delivery of Anesthetic Medications and Agents', 'Quantity Unit ! Item Description Souree Unit Cost Total Cost Bid Docs Price', '(Award by Item) RAF 4. 875.160.54 5,000.00', 'oo BUPIVACAINE 0.5% a . HN', 'as hydrochlordey 4 ml.', '6.000 amp-vial (spinal) with 8% 69.18 413.074.00 |', 'dextrose'];
expect(parseItemRow(TITLED, 4), { quantity: 6000, unit_price: 69.18 }, 'header below a title');

// The user's corrections (2026-10-27)
// One amount that big is the ABC total: "Amikacin ... 2mL 700 49,000.00" under "Approved Budget Cost" (PS 102904)
expect(parseItemRow(['56 Amikacin 125mg/mL Solution for Injection, 2mL Vial 700 49,000.00'], 0), { quantity: 700, total: 49000, unit_price: undefined }, 'big single amount is the total');
// A scan's misread unit price: quantity and total stand, the ABC/Unit worked out (PS 107166 Sugammadex 1645.60)
expect(withBothAmounts({ quantity: 800, unit_price: 1043, total: 1316480 }), { unit_price: 1645.6, computed: 'unit_price' }, 'unit price from the total when they disagree');
// A garbled amount set aside, the total worked out (PS 108640 Sevelamer 35,000 x 11.00 = 385,000.00)
const EPA6 = ['Quantity Unit Item Description Source Unit Cost Total Cost', '.. IP SLVELAMLR 800 mg (as Ces', '35.000 tah carbonate! 11.00 3IRS.000.00'];
expect(withBothAmounts(parseItemRow(EPA6, 1)), { quantity: 35000, unit_price: 11, total: 385000, computed: 'total' }, 'garbled total');
// The next row run onto the line is cut (PS 94918, PhilGEPS 13300871)
expect(parseItemRow(['9 Bupivacaine 0.5%, 5ml Solution for 350.00 2,000 700,000.00 10 CalciumCarbonate 6.00 30,000 180,000.00'], 0), { quantity: 2000, unit_price: 350, total: 700000 }, 'next row on the line');
expect(parseItemRow(['22 Carboplatin - lot bidding 10 mg/mL (IV) 45 mL vial 600 23 Carvedilol 6.25 mg tablet 564,000'], 0), { quantity: 600 }, 'next row on the line, no prices');
// "mL ampoule 596.00" goes on the row, it doesn't start one (PhilGEPS 13309762)
expect(parseItemRow(['16 1010 Ampoule Bupivacaine Hydrochloride 5mg/mL (0.5% ) Solution for Injection, 10', 'mL ampoule 596.00', '17 3000 Box Calcium'], 0), { quantity: 1010, unit_price: 596 }, 'strength unit starting the wrapped line');
// The next row's "0.12%" is no amount; delivery text set aside under a header without its column (PhilGEPS 13299419)
const DDH = ['Item Description Unit Quantity Unit Cost Total Cost', '13 Cetirizine 10 mg Tablet tablet 15,000 9.20 138,000.00 Fifteen (15) calendar', 'days upon receipt of', 'an advice for', 'delivery.', '14 Chlorhexidine 0.12%, 120', 'mL Oral Solution Bottle'];
expect(parseItemRow(DDH, 1), { quantity: 15000, unit_price: 9.2, total: 138000 }, 'delivery text, next row with a percent');
// The same row from several files: the complete one kept, the Technical Specifications first
const SAME = [
  { our_products: ['Carboplatin'], item_no: '22', description: 'Carboplatin 10 mg/mL (IV) 45 mL vial', quantity: 600, source: 'Section VI. Schedule of Requirements.pdf, page 1' },
  { our_products: ['Carboplatin'], item_no: '22', description: 'Carboplatin 10 mg/mL (IV) 45 mL vial', quantity: 600, unit_price: 1712, total: 1027200, source: 'Section VII. Technical Specifications.pdf, page 1' },
  { our_products: ['Carboplatin'], item_no: '21', description: 'Carboplatin 10 mg/mL (IV) 15 mL vial', quantity: 200, source: 'Section VII. Technical Specifications.pdf, page 1' },
];
keepBestReading(SAME);
assert.deepEqual(SAME.map((i) => `${i.item_no} ${i.unit_price ?? '-'}`), ['22 1712', '21 -'], 'best reading kept per row');

// Package or lot tenders aren't fetched (user, 2026-10-27): a "1 Package" / "1 Lot" row in the description or the
// documents' Schedule of Requirements; never the tender's name or a file name (Adela "PACKAGE 1", Taguig "Lot F")
assert.equal(isPackageTender('Description / Supply and Delivery of Medicines - Lot F'), false, 'lot in the name alone is not a lot');
assert.equal(isPackageTender('PROCUREMENT OF DRUGS AND MEDICINES: PACKAGE 3 - EARLY PROCUREMENT ACTIVITY'), false, 'package in the name alone is not a package');
assert.equal(isPackageTender('Item\n1 Package Drugs and Medicines 1 30 Calendars Days'), true, 'package row in the description');
assert.equal(isPackageTender('Item\n1 Lot Various Drugs and Medicines 1'), true, 'lot row in the description');
assert.equal(isPackageTender('', true), true, 'package in the documents');
assert.equal(PACKAGE_ROW.test('1 Package Drugs and Medicines 1 30 Calendars Days'), true, 'package row');
assert.equal(PACKAGE_ROW.test('1 box Cetirizine 10mg 1'), false, 'a row of one box is not a package');

// PhilGEPS 13300232 Price Schedule: the bidder's fields under each row end it; a row's dosage is never the next row's;
// a delivery plan's copy of a row goes when the Price Schedule has it
const PSCHED = ['45 Aztreonam 1g, powder for injection,', 'with Bio-Assay/Bio-Equivalence 400 vial 1,274.00 509,600.00', 'brand', 'packaging/model'];
expect(parseItemRow(PSCHED, 0), { quantity: 400, unit_price: 1274, total: 509600 }, 'bidder fields end the row');
assert.equal(rowAhead(['80 500 Bottle Cetirizine 2.5mg/ml, 10ml-', '81 5470 Bottle Cetirizine 5mg/5ml syrup'], 0), '', 'next row is not this row');
const PLAN = [
  { our_products: ['Sevelamer'], item_no: '277', quantity: 350000, unit_price: 34.63, total: 12120500, written: '277 Sevelamer Carbonate 800mg 350000 Tablet 34.63 12,120,500.00', source: 'Price Schedule and Technical Specifications.pdf, page 67' },
  { our_products: ['Sevelamer'], item_no: '277', quantity: 350000, written: '277 350,000 Tablet Sevelamer Carbonate', source: 'Delivery Plans.pdf, page 10' },
];
keepBestReading(PLAN);
assert.equal(PLAN.length, 1, 'delivery plan copy dropped');

// User, 2026-10-28: "they are in a one table" - every row of one table read the same way, both portals
// PhilGEPS 13312124 (Rizal): numbers on a line starting with the unit, delivery text after them
const RIZAL = ['ITEM NO. DESCRIPTION Preparation UNIT QTY UNIT COST (PhP) TOTAL ABC (PhP) DELIVERY SCHEDULE', '1 Atracurium 10', 'mg/mL, 2.5 mL', 'Solution for', 'Injection', 'ampule 7,000 154.00 1,078,000.00 Fifteen', '(15)', 'calendar', '2 Bupivacaine +'];
carryHeader(RIZAL, null);
expect(parseItemRow(RIZAL, 1), { item_no: '1', quantity: 7000, unit_price: 154, total: 1078000 }, 'Rizal numbers line starting with the unit');
// PS 114476 (Tondo): the next row's number alone on its line ends the row
const TONDO = ['Item No. Description Qty Unit of', 'Issue Total ABC', '1 ATRACURIUM BESILATE 10', 'mg/mL, 2.5mL AMPULE 200 amp 18,800.00', '2', 'BUPIVACAINE HCl Heavy', '0.5% , 4mL AMPULE', '1,800 amp 136,800.00'];
carryHeader(TONDO, null);
expect(parseItemRow(TONDO, 2), { quantity: 200, total: 18800 }, 'Tondo row ends before the next row number');
assert.equal(rowAhead(['BUPIVACAINE HCl Heavy 0.5% ,', '4mL AMPULE (SPINAL) with 8%', 'dextrose'], 0).includes('dextrose'), true, '"4mL AMPULE" goes on the row');
// PS 114450: the Item No. alone on the line above, one amount under "Total ABC"
const TONDO2 = ['Item No. Description Qty Unit of', 'Issue Total ABC', '19', 'FLUOROURACIL 50mg/mL,', '10mL VIAL 200 Vial 13,600.00', '20', 'HYDROXYUREA 500mg'];
carryHeader(TONDO2, null);
expect(parseItemRow(TONDO2, 3), { item_no: '19', quantity: 200, total: 13600 }, 'Tondo Item No. on the line above');
// PS 114538: no header, numbers ending the description's last line
expect(parseItemRow(['TABLET 500 Tab 4,500.00', '55', 'SEVELAMER CARBONATE', '800mg TABLET 10,000 Tab 140,000.00', '56'], 2), { quantity: 10000, total: 140000 }, 'numbers ending the last line');
// PhilGEPS 13309069 (Ilocos Sur): sub-numbered rows are rows of their own
expect(parseItemRow(['8.2 Bupivacaine (as hydrochloride) 0.5%', '(isobaric), 5 mL ampul (spinal) Ampule 20 605.00 12,100.00', '8.3 PROPOFOL 10 mg/mL, 20 mL vial (IV) Vial 200 445.00 89,000.00'], 0), { quantity: 20, unit_price: 605, total: 12100 }, 'sub-numbered next row');
// PhilGEPS 13311929 / 13311841 (Gallares): No. | Stock No. | Description | Unit Price | Qty | Unit
expect(parseItemLine('1 3100000 Amikacin Sulfate, 250mg/ml, 2ml (500mg/2ml) 97.00 4,800 ampule/vial'), { quantity: 4800, unit_price: 97, unit: 'ampule/vial' }, 'stock no. is not the quantity');
expect(parseItemRow(['2 25200000 Folic Acid, 5mg 5.00 10,000', 'tablet/capsule 50,000.00'], 0), { quantity: 10000, unit_price: 5, total: 50000 }, 'unit and total on the next line');
const GALLARES = ['Item Description Quantity Unit Price Total', 'x', '2 25200000 Folic Acid, 5mg 5.00 10,000', 'tablet/capsule 50,000.00'];
carryHeader(GALLARES, null);
expect(parseItemRow(GALLARES, 2), { quantity: 10000, unit_price: 5, total: 50000 }, 'a header that leaves an amount in the name does not fit');
expect(parseItemRow(['1 23800000 FILGRASTIM 300 mcg/ 0.5 ml 1,225.00 259 pre-filled', 'syringes 317,275.00'], 0), { quantity: 259, unit_price: 1225, description: 'FILGRASTIM 300 mcg/ 0.5 ml' }, 'name without amounts and stock no.');
// PhilGEPS 13280005: an amount broken over two lines
const SPLIT = ['Item No. Description Unit Quantity Unit Cost Total Cost', '44 ATRACURIUM (as besilate),10', 'mg/mL, 2.5 mL (IV) ampule 3,850 80.39 309,50', '1.50', '45 ATROPINE'];
carryHeader(SPLIT, null);
expect(parseItemRow(SPLIT, 1), { quantity: 3850, unit_price: 80.39, total: 309501.5 }, 'amount split over lines');
// PhilGEPS 13292520: "800 vial" in one Quantity column; a row without amounts on its line keeps its words
const QTYUNIT = ['Item Number Description Quantity Total Delivery', '68 Amikacin 250 mg/mL, 2 mL', 'Solution for Injection Vial 800 vial 25,600.00', 'Within thirty (30)'];
carryHeader(QTYUNIT, null);
expect(parseItemRow(QTYUNIT, 1), { quantity: 800, unit: 'vial', total: 25600 }, 'quantity cell with its unit');
// PhilGEPS 13299243: delivery text with a number after the amounts
expect(parseItemRow(['for delivery.', '18 Filgrastim (G-CSF) 300', 'mcg/0.5 mL, 0.5 mL', 'Solution for Injection Pre-', 'filled Syringe', 'piece 350 758.00 265,300.00 Fifteen (15) calendar'], 1), { quantity: 350, unit_price: 758, total: 265300 }, 'delivery text after the amounts');
// PhilGEPS 13282441 / 13282466: a third amount column, the unit broken around "/"
expect(parseItemRow(['22 Fluorouracil 50mg/ml, 10ml', 'ampule/vial (IV, IV infusion) 400 ampule /', 'vial 72.00 28,800.00 14,400.00', '23 Gefitinib 250mg'], 0), { quantity: 400, unit_price: 72, total: 28800 }, 'third amount, split unit');
expect(parseItemRow(['x 100 vial 50.49 5,049.00 2,524.50', '5 Propofol 10mg/ml, 20ml vial/ampule (IV) 4,000', 'vial /', 'ampule 250.00 1,000,000.00 500,000.00'], 1), { quantity: 4000, unit_price: 250, total: 1000000 }, 'quantity, then the unit on the next lines');
// PS 101007: "Packaging: ..." continues the description; the quantity and unit split over lines ("3,100 pre-filled" / "syringe ...")
expect(parseItemRow(['12', 'Propofol 10 mg/mL solution', 'for (IV) injection', 'Packaging: 20 mL x glass', 'ampule or vial', '1,050 ampule 62.89 66,034.50', '13'], 1), { quantity: 1050, unit_price: 62.89, total: 66034.5 }, 'packaging line inside the row');
expect(parseItemRow(['65', 'Epoetin Alfa (Recombinant', 'Human Erythropoietin) 4,000', 'IU/mL solution for (IV,SC)', 'injection', 'Packaging: 1 mL pre-filled', 'syringe', '3,100 pre-filled', 'syringe 264.71 820,601.00', '66'], 1), { quantity: 3100, unit_price: 264.71, total: 820601 }, 'pre-filled / syringe split');
// PS 101007: a concentration is never a quantity and unit ("Rocuronium 10 mg/mL")
const CONC = ['Item No. Description Quantity Unit Unit Price Total', '146', 'Rocuronium 10 mg/mL', 'solution for (IV) injection (as', 'bromide)', 'Packaging: 5 mL glass vial', '730 vial 330.00 240,900.00'];
carryHeader(CONC, null);
expect(parseItemRow(CONC, 2), { quantity: 730, unit_price: 330, total: 240900 }, 'concentration is not a quantity');
// PS 106363: each cell on a line of its own
expect(parseItemRow(['64,000.00', '20 Cefazolin 1g (IM,IV) (as', 'Sodium salt)', 'vial', '40,000', '132.00', '5,280,000.00', '21 Cefepime 1g'], 1), { quantity: 40000, unit_price: 132, total: 5280000 }, 'one cell per line');
// PhilGEPS 13286049: rows starting with their unit end the lines ahead
assert.equal(rowAhead(['tablet/capsule Ferrous Salt 60mg elemental iron + Folic Acid 400 mcg 55,000 55,000', 'tablet Ferrous Salt (equiv to 60mg elemental iron) 5,000 5,000', 'tablet/capsule Folic Acid 5mg 1,000 1,000'], 0), '', 'unit-first next row');
// PS 106895: one amount after "<qty> ampule" is the unit price, whatever other tables in the file do
expect(parseItemLine('10 Propofol 10mg/ml,20ml Emulsion for injection CPR & COD 500 ampule 200.00'), { quantity: 500, unit_price: 200 }, 'unit price kept');
const ABCLINE = ['Item', 'No. Description Requirements Qty Unit ABC Per Line', 'Item Unit Cost Total Cost', '1 Divalproex Sodium 500mg CPR & COD 8,000 tablet 23.00', '10 Propofol 10mg/ml,20ml Emulsion for injection CPR & COD 500 ampule 200.00'];
carryHeader(ABCLINE, null);
expect(parseItemRow(ABCLINE, 4), { quantity: 500, unit_price: 200 }, 'ABC per line item holding unit prices; the bidder columns stay empty');
// PhilGEPS 13300773: the same kind of column holding the lines' totals; one meaning for the whole table
const ABCITEM = ['Item', 'No Qty. Unit of', 'Measurement Description ABC per Item', '2 20 Liter (L) Nitrous Oxide 70% ₱207,000.00', '3 90 Vial (vial) Rocorunium 10mg/mL,5mL ₱62,100.00', '19 80 ampules Pyridoxine 1mg ₱4,600.00', '21 8 vial Suggammadex, 100mg/mL,2mL ₱55,200.00'];
carryHeader(ABCITEM, null);
expect(parseItemRow(ABCITEM, 6), { quantity: 8, total: 55200 }, 'ABC per item holding totals');
expect(parseItemRow(ABCITEM, 4), { quantity: 90, total: 62100 }, 'ABC per item holding totals (2)');
// PhilGEPS 13298236: "ABC Unit Price" is one column, the unit price
const ABCUNIT = ['TECHNICAL SPECIFICATION', 'Item', 'No. Quantity unit Item Description ABC Unit Price', '1. 360 bot D5 IMB 500ml 120.00', '24. 150 vials Cefoxitin 1g 680.00'];
carryHeader(ABCUNIT, null);
expect(parseItemRow(ABCUNIT, 4), { quantity: 150, unit_price: 680 }, 'ABC Unit Price is the unit price');
// Item | Qty | Unit | ABC | Description: the amount before the description is the line's total unless only a unit
// price makes sense (PhilGEPS 13296270, 13295470, 13298283)
expect(parseItemLine('42 30,000 tablet 555,000.00 Capecitabine 500 mg Tablet'), { quantity: 30000, total: 555000 }, 'amount before the description (total)');
expect(parseItemLine('17 400 vial 23,400.00 Cefepime Hydrochloride 1g injection (IM, IV)'), { quantity: 400, total: 23400 }, 'amount before the description (vial total)');
expect(parseItemLine('1 12,000 pfs 4,560,000.00 Epoetin Alfa 4000 IU/ 0.4ml pre filled syringe (IM, SC)'), { quantity: 12000, total: 4560000 }, 'amount before the description (pfs)');
// A tender bought as one lot: its Schedule of Requirements' Quantity says so (PhilGEPS 13307875, 13270736, 13274749),
// or its price list is headed by the whole as one lot (PhilGEPS 13299815), or its Bid Data Sheet says one lot even with
// priced items (user, 2026-10-30, PS 107468); never the schedule's entry in a table of contents, nor two or more lots
assert.equal(lotSchedule(['Section VI. Schedule of Requirements', 'Item', 'No. Description Quantity Total Delivery', 'Schedule', '1 Supply and Delivery of Drugs', 'and Medicines 1 lot', '(160', 'items', 'only)']), true, 'SoR quantity 1 lot');
assert.equal(lotSchedule(['Section VI. Schedule of Requirements', 'Item', 'Number Description Quantity Total Delivery Schedule', '1.', 'SUPPLY AND DELIVERY', 'OF 258 PACK CESAREAN', 'PACK', '1 LOT', 'Delivery of items']), true, 'SoR quantity 1 LOT on its own line');
assert.equal(lotSchedule(['ITEM CEILING UNIT TOTAL', 'NO. PRICE PRICE PRICE', '1 LOT VARIOUS DRUG AND MEDICINES 6,282,909.00', '1 Vial 0.9% Sodium Chloride 100ml Plastic Vial for IV Infusion Bag 75.00']), true, 'price list headed by one lot');
assert.equal(lotSchedule(['1.1 The Procuring Entity is the MUNICIPALITY OF TANGALAN.', '1.2 The number of lot(s): 1 lot', 'Section VI. Schedule of Requirements', '1 Cetirizine 10mg tablet 40 box']), true, 'Bid Data Sheet 1 lot');
assert.equal(lotSchedule(['The identification number of the Contract is PhilGEPS IB No. 107468.', '1.2 The number of lot(s): One (1)', '2 The Funding Source is:']), true, 'Bid Data Sheet One (1), PS 107468');
assert.equal(lotSchedule(['1.2 The number of lot(s):', 'One (1)']), true, 'Bid Data Sheet One (1) on the next line');
assert.equal(lotSchedule(['1.2 The number of lot(s): Two (2)', '2 The Funding Source is:']), false, 'two lots is not one lot');
assert.equal(lotSchedule(['1.2 The Project is composed of number of lots or items as provided in the BDS, the']), false, 'template sentence is not a lot');
assert.equal(lotSchedule(['Section VI. Schedule of Requirements ........................ 67', 'Section VII. Technical Specifications ..... 68', '1 lot']), false, 'table of contents');
assert.equal(lotSchedule(['Section VI. Schedule of Requirements', '5 Oxygen refill 20 tank 1,200.00 24,000.00', '6 Cetirizine 10mg 1,000 tablet 0.80 800.00']), false, 'itemised schedule');
// A cut-off name's row ends at the next row's number alone on its line (PhilGEPS 13305194: row 11's 10 mg is not row 10's)
assert.equal(rowAhead(['10', 'Cetirizi', 'ne', 'syrup', '288', '11', 'Dapagli', 'flozin', '10mg', 'tab'], 1), 'ne\nsyrup\n288', 'next row number ends the look-ahead');
// A scan's dots between thousands, and its loose mark after a row number (PhilGEPS 13279404)
expect(parseItemRow(['18 box Cetirizine 10 rna tabrl00tab/box) 300 61.00 18.300.00'], 0), { quantity: 300, unit_price: 61, total: 18300 }, 'dots between thousands');
expect(parseItemRow(['21 DC IV Infuslon set /macroset) 100 log.50 10,850.00', '22 . IV Infusion (microset) 100 112.00 11,200.00'], 1), { quantity: 100, unit_price: 112, total: 11200 }, 'loose mark after the row number');
// A row's numbers after its bidder field ("CPR & COD 15,000 pcs 158.00", PS 106895); a lot heading is never a row's numbers
const CPRROW = ['Item', 'No. Description Requirements Qty Unit ABC Per Line', 'Item Unit Cost Total Cost', 'CPR & COD 4,000 pcs 115.00', '126', 'IV Infusion set adult (20gtts) needleless with anti-', 'run dry technology, auto prime capacity at least', '1.5meters kink resistant tubing roller clamp', 'precise, stable flow control, capable of full', 'occlusion,Luer lock connector, Injection port(Y-', 'site) with self sealing rubber', 'CPR & COD 15,000 pcs 158.00', '127'];
carryHeader(CPRROW, null);
expect(parseItemRow(CPRROW, 5), { quantity: 15000, unit_price: 158 }, 'numbers after the bidder field');
expect(parseItemRow(['19 Sevelamer 800 mg Tablet tablet 54,000 18.15 980,100.00', 'LOT 2 2,395,500.00', '1 Sevoflurane, 250 mL Volatile'], 0), { quantity: 54000, unit_price: 18.15, total: 980100 }, 'lot heading is not the row');
// The next row's number before marks ("18 **Butamirate ...") ends the row (PhilGEPS 13269780)
const STARS = ['Item No. Description Quantity Total Delivery', '17 **Bupivacaine hydrochloride 0.5% 4ml heavy 570 370,500.00 Fifteen (15)', 'calendar days', '18 **Butamirate Citrate 50mg tab 100 700.00 Fifteen (15)'];
carryHeader(STARS, null);
expect(parseItemRow(STARS, 1), { quantity: 570, total: 370500 }, 'next row after marks');
assert.ok(!/Butamirate/.test(parseItemRow(STARS, 1).written), 'next row after marks is not part of the row');
// One amount meaning per page never turns a row into a reading that makes no sense for it: a box of 100 tablets at
// ₱1,125 stays ₱1,125 a box (PhilGEPS 13309776); ₱11 a tablet whose total the scan garbled stays ₱11 (PS 108640)
const BOXES = ["48 450 Box Cetirizine Dihydrochloride 10 mg Tablet, Box of 100's 1,125.00", "87 2100 Box Etoricoxib 60mg Film-Coated Tablet, Box of 30's 2,700.00", "90 300 Box Loratadine 10mg Tablet, Box of 100's 600.00"];
expect(withPageMeaning(BOXES, 0, parseItemRow(BOXES, 0)), { quantity: 450, unit_price: 1125 }, 'box price stays a box price');
const TOTALS = ['1 Amlodipine 5mg tablet 30,000 15,000.00', '2 Losartan 50mg tablet 20,000 60,000.00', '3 Metformin 500mg tablet 40,000 80,000.00', 'Sevelamer 800 mg tablet'];
expect(withPageMeaning(TOTALS, 3, { quantity: 35000, unit_price: 11, description: 'Sevelamer 800 mg tablet' }), { quantity: 35000, unit_price: 11 }, 'never a total that makes no sense');
// A quantity-first next row ends the row ("23 4 sox ..."), PhilGEPS 13308352
const QTYNEXT = ['ITEM NO. QTY UNIT DESCRIPTION UNIT COST TOTAL COST', '22 30 PCS MICROSET (PEDIA) 35.00 1,050.00', '23 4 sox Thypolleenic. paper Succ tape, (3M) 4 950.00 3.800.00'];
carryHeader(QTYNEXT, null);
expect(parseItemRow(QTYNEXT, 1), { quantity: 30, unit_price: 35, total: 1050 }, 'quantity-first next row ends the row');
// Bid dates: never a form's revision date, nor a date from the next sentence, nor "1-lot/792" (PhilGEPS 13316995, 13296270)
const VSMMC = 'Note: May be submitted during the opening of bids or during the post-qualification evaluation) FINANCIAL DOCUMENTS HOPSS-PROC-F-23 Rev.2 July 8, 2024 Page 6 of 7 at least five (5) days before the bid opening. 2) The VSMMC now invites bids for Supply and Delivery of DRUGS AND MEDICINES 5. Delivery of the Goods is required until December 31, 2027. 9) Bid opening shall be on November 19, 2026; 9:00 am at Room 9, Training Center.';
assert.match(readBidDataSheet(VSMMC).bid_opening || '', /November 19, 2026/, 'bid opening from its own sentence, not a revision or delivery date');
assert.equal(readBidDataSheet('PRE-BID CONFERENCE (Virtual) ELIGIBILITY CHECK and BID OPENING Non- Refundable Fee (in pesos) 11 Collection of General Waste (1-lot/792,000 kg)').prebid_conference, null, '1-lot/792 is no date');
// The team's screened list of 2026-10-29: rows the reader missed
// Bicol 13300127: description over lines, then "ABC/unit qty total" alone
expect(parseItemRow(['80.00 3220 257,600.00', '170. Epoetin Alfa (recombinant human', 'erythropoietin) 4000 IU/0.4 mL, pre‐filled', 'syringe (IV, SC), piece', '552.68 201 111,088.68', '171. Ertapenem (as sodium salt) 1 g powder,'], 1), { quantity: 201, unit_price: 552.68, total: 111088.68 }, 'price-first numbers line ends the row');
// Valenzuela PS 115220: the row's number and unit two lines above the molecule
expect(parseItemRow(['12 Prefilled', 'Syringe', 'Filgrastim (G-CSF)', '300mcg/0.5ml,', '0.5mL Solution for', 'Injection', '1,300 598.00 777,400.00', '13 vial'], 2), { item_no: '12', quantity: 1300, unit_price: 598, total: 777400 }, 'row number and unit above the molecule');
// JFMH 13316949: the peso sign scanned as £ and $, stray marks at the end
expect(parseItemRow(['1. Cefazolin 1g as sodium salt vial (IM,1V) 2,000 bottles £275.00 $550,000.00 ~ |'], 0), { quantity: 2000, unit_price: 275, total: 550000 }, 'scanned peso signs and stray marks');
expect(parseItemRow(['1. Cefazolin 1g as sodium salt vial (IM,1V) 2,000 bottles £275.00 $550'], 0), { quantity: 2000, unit_price: 275 }, 'total cut short by the scan');
// PS 114413 (AFP scan): a unit price whose decimal point the scan dropped, only when it gives the total exactly
expect(parseItemLine('99 Carboplatin 10mg/ ml 15 ml 5 vial 75000 3,750.00'), { quantity: 5, unit_price: 750, total: 3750 }, 'dropped decimal point');
expect(parseItemLine('100 Carboplatin 10mg/ ml 45 ml 660 vial 171200 1,129,920.00'), { quantity: 660, unit_price: 1712, total: 1129920 }, 'dropped decimal point (2)');
// Copies of a row without amounts (delivery schedule, compliance form) go when a priced reading has it (PS 114538)
const COPIES = [
  { our_products: ['Sevelamer'], quantity: 10000, total: 140000, written: 'SEVELAMER CARBONATE 800mg TABLET 10,000 Tab 140,000.00', source: 'NGPA.pdf, page 48' },
  { our_products: ['Sevelamer'], quantity: 10000, written: 'SEVELAMER CARBONATE 800mg TABLET 10,000 Tab', source: 'NGPA.pdf, page 74' },
  { our_products: ['Sevelamer'], quantity: 10000, written: 'Item No. 55 SEVELAMER CARBONATE 800mg TABLET Qty/Unit: 10,000 Tab', source: 'NGPA.pdf, page 133' },
];
keepBestReading(COPIES);
assert.equal(COPIES.length, 1, 'copies without amounts dropped');

// PhilGEPS 13316606: the peso sign scanned as the letter P, a loose "P" before the total, stray marks between cells
expect(parseItemRow(['241 Heparin (unfractionated) 5000 IU/ml, 5ml vial vial 5,100 P185.79 P 947,529.00'], 0), { quantity: 5100, unit_price: 185.79, total: 947529 }, 'peso sign read as P');
expect(parseItemRow(['98 Capecitabine 500mg tablet tablet ~~ 60,000 P17.00 P 1,020,000.00'], 0), { quantity: 60000, unit_price: 17, total: 1020000 }, 'stray marks between cells');
// ... and pages scanned column by column: descriptions, then quantities, unit prices, totals (or numbered rows with
// their quantity, then the two amount columns); put back together only when the columns add up
const NAMES = ['361', '362', '363', '364', '365', '', 'Ondansetron 2mg/ml, 4 ml ampule ampule', 'Ondansetron 8 mg {ablet tablet', 'Oftoxacin 0.3% , Sm bottle {ear drops solution) bottle', 'Methotrexate 100mg/ml , 10ml vial (iM, [V,', 'Intrathecal)', 'Paliperidone 100mg/ml prolonged-release', 'suspension for injection prs', ''];
const QUANTITIES = ['2,000', '500', '150', 'a0', '45'];
const COLUMN_PAGE = [...NAMES, ...QUANTITIES, '$41.34', 'P58.00', '$120.00', 'P 102.00', '$6,066.07', 'P 82,680.00', 'P 29,000.00', 'P 18,000.00', 'P 3,060.00', 'P 272,973.15'];
const columns = columnRows(COLUMN_PAGE);
assert.deepEqual(columns?.rows.get(6), { text: 'Ondansetron 2mg/ml, 4 ml ampule ampule', quantity: 2000, unit_price: 41.34, total: 82680 }, 'column page: first row');
assert.equal(columns.rows.get(7).total, 29000, 'column page: second row');
assert.equal(columns.rows.has(9), false, 'column page: a garbled quantity gives no row');
assert.ok(columns.inside.has(10), 'column page: "Intrathecal)" goes on the row above');
assert.equal(columns.rows.get(11).total, 272973.15, 'column page: a row over two lines');
const NUMBERED_PAGE = ['490 Vancomycin 500mg vial vial 6,500', '491 Vasopressin 201U/ml ampule ampule 1,800', '495 Vincristine (as sulfate) 1mg/ml, 2ml vial vial 100', 'J 480 Tranexamic 100mg/mL, 5ml ampule 30,500', '501 Zinc solution (equiv to 20mg elemental zinc /5ml) bottle', 'syrup , 60 ml (as sulfate monohydrate) 690', 'Chairperson, Bids and Awards Committee', '$54.89', 'P243.84', '$850.00', 'P16.44', 'P31.50', 'P 356,785.00', 'P 438,912.00', 'P 85,000.00', 'P 501,420.00', 'P 21,735.00', 'Php 143,911,099.22'];
assert.deepEqual(columnRows(NUMBERED_PAGE)?.rows.get(0), { text: '490 Vancomycin 500mg vial vial 6,500', quantity: 6500, unit_price: 54.89, total: 356785 }, 'numbered rows with amount columns');
assert.equal(columnRows(NUMBERED_PAGE).rows.get(4).quantity, 690, 'numbered row with its quantity on its second line');
assert.equal(columnRows(['1 Amlodipine 5 mg tablet 100 2.00 200.00', '2 Losartan 50 mg tablet 100 3.00 300.00']), null, 'an ordinary table is not a column page');
assert.equal(columnRows([...NAMES, ...QUANTITIES, '$1.00', 'P58.00', '$120.00', 'P 102.00', '$6,066.07', 'P 82,680.00', 'P 9.00', 'P 18.00', 'P 3,060.00', 'P 2.15']), null, 'columns that do not add up are not put together');

expect(parseItemRow(['212 Filgrastim (G-CSF) 300mcg/0.5mi solution for', '', 'injection in prefilled syringe pfs 100 P514.56 P 51,456.00', '213 Finasteride 5mg tablet tablet 3,500 P11.67 P 40,845.00'], 0), { quantity: 100, unit_price: 514.56, total: 51456 }, 'a row cut mid-phrase goes on past a blank line');
expect(parseItemRow(['212 Filgrastim (G-CSF) 300mcg/0.5mi vial', '', '100 514.56 51,456.00'], 0), { quantity: undefined }, 'a finished row does not take the numbers after a blank line');

// PS 119066-119074: an Excel list's amounts without centavos, by its header and without one; only when they multiply out
expect(parseItemRow(['Item No. General Description Maximum Quantity Cost per Item Total Cost per Item', '5 Propofol 10 mg/ml, 20ml (IV) MCT/LCT Ampule ampule 3900 220 858000'], 1), { quantity: 3900, unit_price: 220, total: 858000 }, 'plain amounts under a header');
expect(parseItemRow(['8 Iohexol 350mg iodine/ml, 50ml vial 800 1100 880000'], 0), { quantity: 800, unit_price: 1100, total: 880000 }, 'plain amounts without a header');
expect(parseItemRow(['8 Iohexol 350mg iodine/ml, 50ml vial 800 1100 880'], 0), { unit_price: undefined, total: undefined }, 'three numbers that do not multiply out are not amounts');

// Only one whole lot is hidden (user, 2026-10-31, PS 119068): several lots, or line items with lots, are read
assert.equal(manyLots(['1.2 The number of items: Seventy-Six (76) line items', 'Six (6) lots']), true, 'line items and lots');
assert.equal(manyLots(['1.2 The number of lot(s): 3 LOTS']), true, 'three lots');
assert.equal(manyLots(['1.2 The number of lot(s): Three Lots']), true, 'three lots in words');
assert.equal(manyLots(['1.2 The number of lot(s): One (1)']), false, 'one lot');
assert.equal(manyLots(['1.2 The number of lot(s): 1 lot/ Eighty Six (86) items']), false, 'one lot of 86 items stays one lot');
assert.equal(manyLots(['1.2 The Project is composed of number of lots or items as provided in the BDS']), false, 'the form sentence counts nothing');
assert.equal(lotSchedule(['1.2 The number of lot(s): One (1) item only']), false, 'one item is not a lot');
assert.equal(lotSchedule(['Schedule of Requirements', 'MEDICINES FOR JANUARY 2027 (EPA) 1 LOT', 'MEDICINES FOR FEBRUARY 2027 (EPA) 1 LOT']), false, 'several rows of 1 lot are several lots');
assert.equal(isPackageTender('1 Package Drugs and Medicines 1', false), false, 'the documents saying several lots win over the description');
assert.deepEqual(lotHeading('LOT 1 - (Item Nos. 6 & 7) the offered products must be of the same brand'), { lot: 'Lot 1', items: [6, 7] }, 'a lot naming its two rows');
assert.deepEqual(lotHeading('LOT 4 - (Item Nos. 22 to 25) the offered products must be of the same brand'), { lot: 'Lot 4', items: [22, 23, 24, 25] }, 'a lot naming its range');
assert.deepEqual(lotHeading('Lot 3: ORAL MEDICINES'), { lot: 'Lot 3' }, 'a lot heading');
assert.equal(lotHeading('Lot 1 shall be delivered within 30 days'), null, 'a sentence is no heading');

// One lot with line items is shown; one lot with none is hidden; several lots are shown (user, 2026-10-31)
assert.equal(wholeLot(true, false, [{ quantity: 2000, unit: 'tablet' }]), false, 'one lot with a line item');
assert.equal(wholeLot(true, false, [{ quantity: 2000 }]), false, 'one lot with a line item, no ABC');
assert.equal(wholeLot(true, false, []), true, 'one lot only');
assert.equal(wholeLot(true, false, [{ quantity: null, line: 'Paclitaxel 6 mg/ml' }]), true, 'a name in a list is no line item');
assert.equal(wholeLot(true, false, [{ quantity: 1, unit: 'lot' }]), true, '1 lot is no line item');
assert.equal(wholeLot(true, true, []), false, 'several lots');

// Of several lots, only a lot with every molecule ours counts (user, 2026-10-31)
const LOT_ROWS = new Map([['Lot 1', new Set(['#1', '#2', '#3'])], ['Lot 5', new Set(['#13', '#14', '#15'])], ['Lot 6', new Set(['#16'])]]);
const row = (no, lot) => ({ item_no: String(no), lot, line: `${no} X`, our_products: ['X'] });
const lots = completeLots([row(1, 'Lot 1'), row(2, 'Lot 1'), row(3, 'Lot 1'), row(13, 'Lot 5'), row(14, 'Lot 5'), row(20)], LOT_ROWS);
assert.deepEqual(lots.kept.map((i) => i.item_no), ['1', '2', '3', '20'], 'complete lot and line item kept, incomplete lot left out');
assert.deepEqual(lots.left, [{ lot: 'Lot 5', ours: 2, of: 3, molecules: ['X'] }], 'the lot left out is said');
assert.equal(completeLots([{ lot: 'Lot 1', line: "Box of 100's Cetirizine 10mg tab 1000", our_products: ['Cetirizine'] }], new Map([['Lot 1', new Set([lotRowKey(null, "Box of 100's Cetirizine 10mg tab 1000"), lotRowKey(null, "Box of 100's Celecoxib 200mg Cap 300")])]])).kept.length, 0, 'rows without an Item No. are counted by their text');
assert.deepEqual(lotHeading('FIRST QUARTER 2027 – LOT 1: DRUGS AND MEDICINES FOR JANUARY 2027 (EPA)'), { lot: 'Lot 1' }, 'a lot in a title');

// A lot's rows are counted by Item No. when it has them, whatever a wrapped row's other lines look like (PhilGEPS 13321539)
assert.equal(completeLots([{ item_no: '111', lot: 'Lot 9', line: '111 Epoietin alpha 4000IU/0.4ml,', our_products: ['Epoetin Alfa'] }, { lot: 'Lot 9', line: 'Heparin Sodium 1000iu/ml,', our_products: ['Heparin'] }], new Map([['Lot 9', new Set(['#111', '#112', 'syringes317275'])]])).left.length, 0, 'a complete lot of two rows');

console.log(`Item line check passed (${LINES.length + ROWS.length + 72 + ONE.length + 3 + 7 + 5 + 2 + 4 + 10 + 5 + 3 + 58 + 17 + 13 + 6 + 4 + 1} rows).`);
