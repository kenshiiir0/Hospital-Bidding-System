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
  P('Amikacin', '250 mg/ml (500 mg/2 ml)'),
  P('Folic acid (Vitamin B9)', '5 mg', 'Tablet'),
  P('Cetirizine', '10 mg'),
  P('Propofol', '10 mg/ml (200 mg/20 ml)'),
  P('Cytarabine', '100 mg'),
  P('Docetaxel [COLD CHAIN]', '20 mg/0.5 ml'),
  P('Oxaliplatin', '2 mg/ml (50 mg/25 ml)'),
  P('Atracurium', '10mg'),
  P('Methotrexate', '100mg/ml (500mg / 5ml)'),
  P('Methotrexate', '10ml'),
  P('Heparin Sodium', '1000 IU / ml (25000 IU / 5ml)'),
  P('Enoxaparin sodium*', '6000 IU/0.6 mL (60 mg/0.6 ml)'),
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
  // Exactly our dosage (user, 2026-10-26)
  ['7. Amikacin 250mg/ml, 2ml 1,500', 'Amikacin'],
  ['Amikacin 500 mg/2 mL vial', 'Amikacin'],
  ['Folic Acid 5 mg tablet', 'Folic Acid'],
  ['Cetirizine 10 mg tablet', 'Cetirizine'],
  // A route label is not another ingredient
  ['6 Propofol, Inj: 10mg/ml, 20ml 120 amps 390.00 46,800.00', 'Propofol'],
  ['22 Cefazolin, Inj: 1g 400 vials 45.00 18,000.00', 'Cefazolin'],
  // Bupidex is 0.5% as the Product List gives it (user, 2026-10-27: "The 8% is the wrong one")
  ['3 BUPIVACAINE (AS HYDROCHLORIDE) 0.5%, 5ML ISOBARIC POLYAMP 1,500 Ampule', 'Bupivacaine'],
  // Atracurium's "10mg" is 10 mg per mL (user, 2026-10-27)
  ['26 Atracurium 10mg/mL, 2.5mL. Amp. ampule 150 327.00', 'Atracurium'],
  ['Oxaliplatin 50 mg/25 mL vial', 'Oxaliplatin'],
  // Concentration x volume = our amount (user, 2026-10-27: "100mg/ml multiplied by 5 equals 500")
  ['Methotrexate 100 mg/mL, 5 mL vial', 'Methotrexate'],
  ['Methotrexate 500mg/5ml solution for injection', 'Methotrexate'],
  ['Methotrexate 100mg/ml solution for injection', 'Methotrexate'],
  ['Atracurium besylate 10mg/mL, 5mL ampule', 'Atracurium'],
  // User, 2026-10-27: Amikacin "250MG/2ML" is our vial; Epoetin 4000 IU a syringe in any volume; Enoxaparin 0.6 mL
  ['15 AMIKACIN (AS SULFATE) 250MG/2ML, VIAL 5,000 Vial 55.00 275,000.00', 'Amikacin'],
  ['37 Erythropoietin Alfa 4,000IU/0.4ml PFS 1,000 pfs 525.00', 'Epoetin Alfa'],
  ['Enoxaparin 100mg/ml, 0.6ml pre-filled syringe', 'Enoxaparin'],
  // Our concentration over our pack volume (hospitals' shorthand); a percent product with a mg/ml line
  ['56. Rocuronium 10mg/5ml as bromide vial (IV) 1,000 vial 114.89', 'Rocuronium'],
  ['44 Bupivacaine HCl Heavy, 5 mg/ml. 4 ml. 400 400', 'Bupivacaine'],
  ['Folic acid 5mg tablet or capsule', 'Folic Acid'],
  // Concentration and our pack volume, the bracket total ignored (user, 2026-10-27: 1000 IU and 5ML)
  ['HEPARIN 1000IU/ML, 5ML VIAL 643 Vial 338.00', 'Heparin'],
  ['PROPOFOL 10 mg ml. - 3.500 amp vial 2 mt 61.64 333.520.00', 'Propofol'],
];
const MUST_NOT_MATCH = [
  // Chewable only when our row says so (user, 2026-10-27): our Loratadine is a plain tablet
  ['Loratadine 10 mg Chewable Tablet', 'Loratadine'],
  // Our form only (user, 2026-10-27): our Folic Acid is a tablet
  ['22 Folic Acid 5 mg Capsule capsule 3,000 2.59 7,770.00', 'Folic Acid'],
  // A volume-only row is no match for a line with another strength
  ['60 METHOTREXATE Inj.: 100 mg/mL, 10 mL vial (as base) VAT-exempt', 'Methotrexate'],
  // A dextrose strength besides our 0.5% is another product (user, 2026-10-27: "The 8% is the wrong one")
  ['4 BUPIVACAINE HYDROCLORIDE 0.5%, 4ML W/ 8% (SENPIVAC)DEXTROSE HEAVY 700 Ampule', 'Bupivacaine'],
  ['31 Bupivacaine + Dextrose 0.5% + 8%, 4 mL Solution for Injection Amp', 'Bupivacaine'],
  // Exact dosage (user, 2026-10-27): a concentration is not an amount, nor concentration x volume
  ['CYTARABINE Inj.: 100mg/mL solution, 1mL (IM', 'Cytarabine'],
  ['Methotrexate 100 mg/mL, 10 mL vial', 'Methotrexate'],
  ['Heparin 1000 IU/ml, 10 ml vial', 'Heparin'],
  ['50 Enoxaparin 100mg/ml,0.4ml (SC) pre filled syringe', 'Enoxaparin'],
  ['Methotrexate 25 mg/mL, 2 mL (as base) vial', 'Methotrexate'],
  ['DOCETAXEL Inj.: 10mg/mL, solution for infusion (IV), 2mL VAT-exempt', 'Docetaxel'],
  ['OXALIPLATIN Inj.: 5mg/mL concentrate solution, 10mL vial (IV infusion)', 'Oxaliplatin'],
  ['56 Amikacin 125mg/mL Solution for Injection, 2mL 700 49,000.00', 'Amikacin'],
  // Only the exact dosage we offer (user, 2026-10-26): another ingredient's dosage on the line doesn't count
  ['E: 4mg, Folic Acid: 65mcg, Niacin: 5mg', "Niacin's 5 mg is not Folic Acid's"],
  ['Ferrous sulfate 5 mg + Folic Acid 400 mcg tablet', "the iron's 5 mg is not Folic Acid's"],
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
// Another ingredient's dose is not ours (PS 102904: Niacin 1-5mg in a vitamin B complex)
check("another ingredient's dose", match('10 mcg), Vi E 3-4mg, Folic Acid\n20-65mcg, Niacin 1-5mg), 15ml').length === 0, 'combination matched');
// A strength in capitals on the next line is not the next row (PhilGEPS 13299385)
check('capital IU on the following line', match('57 Heparin (Unfractionated)\n1000 IU/mL, 5 mL Solution\n').includes('Heparin'), 'wrapped row not matched');
check('named without any dosage is reported (documents get checked)', match.details('Supply of Paclitaxel').undosed.includes('Paclitaxel'), 'not reported');
check('a wrong dosage is not "without dosage" (no documents ordered for it)', !match.details('Amlodipine 2.5 mg tablet').undosed.includes('Amlodipine'), 'reported as undosed');
check('names: Iodine (as Iohexol) -> Iohexol', matchName('Iodine (as Iohexol)') === 'Iohexol', matchName('Iodine (as Iohexol)'));

try {
  assert.equal(failed, 0);
  console.log(`\nProduct matching check passed (${MUST_MATCH.length + MUST_NOT_MATCH.length + 6} checks).`);
} catch {
  console.error(`\nProduct matching check FAILED (${failed}). Nothing may be pushed until it passes.`);
  process.exit(1);
}
