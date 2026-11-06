// Puts the Abstract of Bids (table bid_abstracts, Abstract of Bids page) from the "ABSTRACT 2026" sheet of the team's
// WINNING BID TRACKER workbook: HOSPITAL, ITEM, ABC PRICE, QUANTITY, 2MG PRICE (ours; empty = we did not bid),
// WON (the winning company), PRICE (the winning price). A merged HOSPITAL or WON cell counts for every row it
// covers. Re-running updates rows by (year, hospital, item); archived rows stay archived, added rows are left alone.
//   node tools/import-abstract.mjs "<path to .xlsx>" --dry-run   (print what would be saved)
//   node tools/import-abstract.mjs "<path to .xlsx>"             (save)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// exceljs and supabase-js are installed in frontend/
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
createRequire(import.meta.url)('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const SHEET = 'ABSTRACT 2026';
const YEAR = 2026;

// Same as frontend/src/lib/agencyKey.js
const agencyKey = (name = '') =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const clean = (v) =>
  String(v ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const number = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && 'result' in v) v = v.result;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.round(n * 10000) / 10000 : null;
};

export async function readAbstract(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`No "${SHEET}" sheet in ${file}`);
  const head = ws.getRow(1).values.map((v) => clean(v).toUpperCase());
  const col = (name) => head.indexOf(name);
  const C = { hospital: col('HOSPITAL'), item: col('ITEM'), abc: col('ABC PRICE'), qty: col('QUANTITY'), ours: col('2MG PRICE'), won: col('WON'), price: col('PRICE') };
  if (Object.values(C).some((i) => i < 1)) throw new Error(`"${SHEET}" headers changed: ${head.filter(Boolean).join(', ')}`);
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    // A merged cell's value is its first row's value, so a merged HOSPITAL / WON counts for every row it covers
    const value = (c) => {
      const cell = row.getCell(c);
      return cell.isMerged ? cell.master.value : cell.value;
    };
    const item = clean(value(C.item));
    if (!item) return;
    const hospital = clean(value(C.hospital)) || rows.at(-1)?.hospital;
    if (!hospital) return;
    rows.push({
      year: YEAR,
      hospital,
      agency_key: agencyKey(hospital),
      item,
      abc_price: number(value(C.abc)),
      quantity: number(value(C.qty)),
      our_price: number(value(C.ours)),
      winner: clean(value(C.won)) || null,
      winning_price: number(value(C.price)),
      sheet_row: n,
    });
  });
  return rows;
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  if (!file) {
    console.log('Usage: node tools/import-abstract.mjs "<path to .xlsx>" [--dry-run]');
    process.exit(2);
  }
  const rows = await readAbstract(file);
  if (dry) {
    console.table(rows.map(({ hospital, item, abc_price, quantity, our_price, winner, winning_price }) => ({ hospital: hospital.slice(0, 28), item: item.slice(0, 30), abc_price, quantity, our_price, winner, winning_price })));
    console.log(`${rows.length} results`);
    return;
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('bid_abstracts')
    .upsert(rows.map((r) => ({ ...r, source: 'abstract-2026', updated_at: now })), { onConflict: 'year,agency_key,item' });
  if (error) throw new Error(error.message);
  console.log(`"${SHEET}": ${rows.length} results saved.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
