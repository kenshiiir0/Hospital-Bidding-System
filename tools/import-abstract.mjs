// Puts the Abstract of Bids (table bid_abstracts) from the "ABSTRACT 2026" sheet of the team's WINNING BID TRACKER
// workbook. Same reading rules as the page's Import Excel button (frontend/src/lib/sheetImport.mjs). Re-running
// updates rows by (year, hospital, item); archived rows stay archived; rows not on the sheet are left alone.
//   node tools/import-abstract.mjs "<path to .xlsx>" --dry-run   (print what would be saved)
//   node tools/import-abstract.mjs "<path to .xlsx>"             (save)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAbstractSheet } from '../frontend/src/lib/sheetImport.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// exceljs and supabase-js are installed in frontend/
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
createRequire(import.meta.url)('dotenv').config({ path: path.join(root, '.env'), quiet: true });

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) {
    console.log('Usage: node tools/import-abstract.mjs "<path to .xlsx>" [--dry-run]');
    process.exit(2);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const { sheet, results } = readAbstractSheet(wb);
  if (dry) {
    console.table(results.map(({ hospital, item, abc_price, quantity, our_price, winner, winning_price }) => ({ hospital: hospital.slice(0, 28), item: item.slice(0, 30), abc_price, quantity, our_price, winner, winning_price })));
    console.log(`"${sheet}": ${results.length} results`);
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('bid_abstracts')
    .upsert(results.map((r) => ({ ...r, source: 'excel-import', updated_at: now })), { onConflict: 'year,agency_key,item' });
  if (error) throw new Error(error.message);
  console.log(`"${sheet}": ${results.length} results saved.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
