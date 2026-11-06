// Puts the hospital list (Hospital List page) into table hospitals from the "Active Hospital" sheet of the team's
// WINNING BID TRACKER workbook. Same reading and saving rules as the page's Import Excel button
// (frontend/src/lib/sheetImport.mjs): rows are matched by agency_key; a hospital already there keeps its name,
// website, procurement pages, note and archive state; status, list note, contacts and e-mails come from the sheet
// (contacts marked source 'added' are kept). Hospitals not on the sheet are left alone.
//   node tools/import-hospitals.mjs "<path to .xlsx>" --dry-run   (print what would be saved)
//   node tools/import-hospitals.mjs "<path to .xlsx>"             (save)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planHospitalImport, readHospitalSheet } from '../frontend/src/lib/sheetImport.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// exceljs and supabase-js are installed in frontend/
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
createRequire(import.meta.url)('dotenv').config({ path: path.join(root, '.env'), quiet: true });

export async function readHospitals(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return readHospitalSheet(wb).hospitals;
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) {
    console.log('Usage: node tools/import-hospitals.mjs "<path to .xlsx>" [--dry-run]');
    process.exit(2);
  }
  const hospitals = await readHospitals(file);
  if (dry) {
    console.log(JSON.stringify(hospitals, null, 1));
    console.log(`${hospitals.length} hospitals`);
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
  const { data: existing, error: readError } = await supabase.from('hospitals').select('agency_key, website, contacts');
  if (readError) throw new Error(readError.message);
  const { inserts, updates } = planHospitalImport(hospitals, existing);
  for (const { agency_key, ...change } of updates) {
    const { error } = await supabase.from('hospitals').update(change).eq('agency_key', agency_key);
    if (error) throw new Error(`${agency_key}: ${error.message}`);
  }
  if (inserts.length) {
    const { error } = await supabase.from('hospitals').insert(inserts);
    if (error) throw new Error(error.message);
  }
  console.log(`${hospitals.length} hospitals (${inserts.length} added, ${updates.length} already there and updated).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
