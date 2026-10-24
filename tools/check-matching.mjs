// Product matching check, part of the safety gate (tools/safety-gate.sh) and runnable by hand:
//   node tools/check-matching.mjs
// Real-style tender lines against our product rows (from the B2B price list / PRODUCT LIST): a tender counts only
// when it names our molecule in one of our dosages (user, 2026-10-23). Lines that must match and lines that must
// NOT match; any wrong answer blocks the push.
import assert from 'node:assert/strict';
import { buildMatcher, matchName } from '../frontend/src/lib/products.mjs';

const P = (generic_name, dosage, dosage_form = '') => ({ generic_name, brand_name: 'x', dosage, dosage_form });
const products = [
  P('Paclitaxel', '6 mg/ml (100 mg/16.7 ml)'),
  P('Paclitaxel*', '6 mg/ml (260 mg/43.4 ml)'),
  P('Paclitaxel', '6 mg/ml (300 mg/50 ml)'),
  P('Amlodipine', '5 mg'),
  P('Amlodipine', '10 mg'),
  P('Heparin Sodium', '5000 IU / ml (25000 IU / 5ml)'),
  P('Bupivacaine Hydrochloride in dextrose', '5mg/mL (0.5% w/v)'),
  P('Cefazolin (as sodium)', '1g'),
  P('Cefepime (as hydrochloride with arginine)', '1g'),
  P('Docetaxel RTU', '80 mg'),
  P('Bleomycin', '-', '15 Units Lyophilized Powder for Injection'),
  P('Intravenous Cannula Set', 'G20, G22'),
  P('Single Blood Bag', '450 ML'),
  P('Blood Transfusion Set', '-', '-'),
  P('Iodine (as Iohexol)', '350mg'),
  P('Teriparatide [COLD CHAIN]', '20 mcg/80 mcL (600 mcg/2.4 ml)'),
  P('Rocuronium', '10 mg/ml (50 mg/5 ml)'),
  P('Loratadine', '10 mg'),
  P('Epoetin Alfa', '4000 IU/0.4 ml'),
  P('Sugammadex', '100 mg/ml (200 mg/2 ml)'),
  P('Intravenous Infusion Set', '-', '-'),
];
const match = buildMatcher(products);

const MUST_MATCH = [
  ['Paclitaxel 300mg/50mL vial', 'Paclitaxel'],
  ['15 vials Paclitaxel 6mg/ml, 50 ml vial', 'Paclitaxel'],
  ['PACLITAXEL 100 MG', 'Paclitaxel'],
  ['Paclitaxel 6 mg/mL concentrate for infusion', 'Paclitaxel'],
  ['7 1000 tab Amlodipine 10mg tablet 2.50 2,500.00', 'Amlodipine'],
  ['Amlodipine besilate 5 mg', 'Amlodipine'],
  ['Heparin sodium 5,000 IU/mL, 5 mL vial', 'Heparin'],
  ['Bupivacaine 0.5% heavy, 4 mL ampule', 'Bupivacaine'],
  ['Cefazolin 1 gram powder for injection', 'Cefazolin'],
  ['Cefepime 1g vial', 'Cefepime'],
  ['Docetaxel 80mg/2ml', 'Docetaxel'],
  ['Bleomycin 15 units vial', 'Bleomycin'],
  ['IV cannula G22 with wings', 'Intravenous Cannula Set'],
  ['Blood bag single 450 ml', 'Single Blood Bag'],
  ['Blood transfusion set, adult', 'Blood Transfusion Set'],
  ['Iohexol 350 mg I/ml, 100 ml bottle', 'Iohexol'],
  ['Teriparatide 20 mcg/80 mcL pen', 'Teriparatide'],
  // Typing errors in tenders (user, 2026-10-24): real lines from PhilGEPS
  ['3 90 Vial (vial) Rocorunium 10mg/mL,5mL', 'Rocuronium'],
  ['200 vial Rocoronium Bromide 50 mg/5ml', 'Rocuronium'],
  ['53 Loratidine 10mg tablet 2000 pcs', 'Loratadine'],
  ['400 pfs ErythropoeitIn 4000 iu/0.4 ml', 'Epoetin Alfa'],
  ['8 Epoeitin Alfa 4000iu/0.4ml. : Pre-Filled Syringe', 'Epoetin Alfa'],
  ['11 SUGAMMADEZ 100MG/ML, 2ML VIAL', 'Sugammadex'],
  ['Paclitaxol 300 mg/50 ml vial', 'Paclitaxel'],
  ['Amlodipine5mg tablet', 'Amlodipine'],
  ['Amlo dipine 10 mg tablet', 'Amlodipine'],
];
const MUST_NOT_MATCH = [
  ['Amlodipine 2.5 mg tablet', 'a strength we do not sell'],
  ['Paclitaxel 6 mg/ml? no: Paclitaxel 3 mg/ml', 'another concentration'],
  ['Heparin 1,000 IU/mL 10 mL', 'another concentration (only 5000 IU/ml in this test list)'],
  ['Cefazolin 500 mg vial', 'another amount'],
  ['IV cannula G18', 'another gauge'],
  ['Povidone iodine 10% solution', 'iodine is not Iohexol'],
  ['Supply of Paclitaxel', 'no dosage at all'],
  ['Losartan 50 mg tablet', 'not our product'],
  ['CEFEXIME 1 G', 'Cefexime is Cefixime misspelled, not our Cefepime'],
  ['Cefixime 1g', 'Cefixime is another medicine'],
  ['Dobutamine 50 mg/ml, 5 ml ampule (IV infusion, SC)', '"infusion, SC" is not "infusion set"'],
  ['Rocuronium 10 mg/ml? no: Rocorunium 25 mg/ml', 'misspelled but another dosage'],
  ['Amlodipine 5 mg? no: Bmlodipine 5 mg', 'first letter wrong'],
];

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}\n        ${detail}`);
  }
};
for (const [line, want] of MUST_MATCH) {
  const got = match(line);
  check(`matches: ${line}`, got.includes(want), `expected ${want}, got [${got.join(', ')}]`);
}
for (const [line, why] of MUST_NOT_MATCH) {
  const got = match(line.replace(/^.*no: /, ''));
  check(`rejects (${why}): ${line}`, got.length === 0, `expected nothing, got [${got.join(', ')}]`);
}
// A dosage on the next line of a wrapped table row
check('dosage on the following line', match('3 Paclitaxel\n300 mg/50 ml vial\n').includes('Paclitaxel'), 'wrapped row not matched');
check('named without any dosage is reported (documents get checked)', match.details('Supply of Paclitaxel').undosed.includes('Paclitaxel'), 'not reported');
check('a wrong dosage is not "without dosage" (no documents ordered for it)', !match.details('Amlodipine 2.5 mg tablet').undosed.includes('Amlodipine'), 'reported as undosed');
check('names: Iodine (as Iohexol) -> Iohexol', matchName('Iodine (as Iohexol)') === 'Iohexol', matchName('Iodine (as Iohexol)'));

try {
  assert.equal(failed, 0);
  console.log(`\nProduct matching check passed (${MUST_MATCH.length + MUST_NOT_MATCH.length + 4} checks).`);
} catch {
  console.error(`\nProduct matching check FAILED (${failed}). Nothing may be pushed until it passes.`);
  process.exit(1);
}
