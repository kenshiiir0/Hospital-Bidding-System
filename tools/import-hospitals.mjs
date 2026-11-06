// Puts the hospital list (Hospital List page) into table hospitals from the "Active Hospital" sheet of the team's
// WINNING BID TRACKER workbook. One hospital can take several rows (merged cells): each extra row adds a contact
// person / number and maybe an e-mail. A value without "@" in the e-mail column is the hospital's website.
// Rows are matched by agency_key (lib/agencyKey.js), the same key View details uses for websites: a hospital
// already there keeps its name, website, procurement pages and note; status, list note, contacts and e-mails
// come from the sheet. Archived hospitals stay archived. Hospitals added on the page are left alone.
//   node tools/import-hospitals.mjs "<path to .xlsx>" --dry-run   (print what would be saved)
//   node tools/import-hospitals.mjs "<path to .xlsx>"             (save)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// exceljs and supabase-js are installed in frontend/
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
createRequire(import.meta.url)('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const SHEET = 'Active Hospital';
// Names missing or misspelt on the sheet: the "[" row is Vicente Sotto (its e-mail is osm@vsmmc.doh.gov.ph)
const NAME_FIXES = {
  '[': 'VICENTE SOTTO MEMORIAL MEDICAL CENTER',
  'PHILIPPINE CHILDREN MEDICAL CENTER': "PHILIPPINE CHILDREN'S MEDICAL CENTER",
};

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

// Mobile numbers the sheet keeps as plain numbers lose their leading 0: 9179216127 -> 0917 921 6127
function phone(v) {
  if (typeof v === 'number') {
    const d = String(v);
    if (d.length === 10 && d.startsWith('9')) return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    return d.startsWith('9') ? `0${d}` : d;
  }
  return clean(v).replace(/^\(?0?8822\)/, '(088) 22'); // "08822) 726362" -> "(088) 22 726362"
}

const person = (v) => {
  const p = clean(v).replace(/\)\)$/, ')');
  if (/^(landline|admin)$/i.test(p)) return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  return p;
};

function status(text) {
  const t = clean(text).toUpperCase();
  if (t === 'ACTIVE TENDER') return { status: 'active', list_note: null };
  if (t === 'RFQ') return { status: 'rfq', list_note: null };
  return { status: 'prospect', list_note: clean(text) };
}

export async function readHospitals(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`No "${SHEET}" sheet in ${file}`);
  const hospitals = [];
  let current = null;
  let ended = false;
  ws.eachRow((row, n) => {
    if (n === 1 || ended) return;
    // The sheet ends with "Prepared by: … Authorized Representative"
    if (/prepared by/i.test(`${clean(row.getCell(4).value)} ${clean(row.getCell(5).value)}`)) {
      ended = true;
      return;
    }
    const a = row.getCell(1);
    const continuation = a.isMerged && a.master.address !== a.address;
    const value = (c) => {
      const cell = row.getCell(c);
      // A merged cell's other rows repeat the first row's value; only the first row counts
      if (cell.isMerged && cell.master.address !== cell.address) return null;
      const v = cell.value;
      return v && typeof v === 'object' && 'text' in v ? v.text : v;
    };
    const rawName = clean(value(1));
    if (!continuation && rawName) {
      current = { name: NAME_FIXES[rawName] || rawName, ...status(value(2)), contacts: [], emails: [], websites: [], sheet_row: n };
      hospitals.push(current);
    } else if (!continuation && !rawName && !clean(row.getCell(3).value) && !clean(row.getCell(5).value)) {
      return;
    }
    if (!current) return;
    const number = value(3) == null ? '' : phone(value(3));
    const who = person(value(4));
    if (number || who) current.contacts.push({ name: who || null, phone: number || null });
    for (const part of clean(value(5)).split(/[\s/;,]+/).filter(Boolean)) {
      if (part.includes('@')) current.emails.push(part.toLowerCase());
      else current.websites.push(part.toLowerCase());
    }
  });
  return hospitals;
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
  const { data: existing, error: readError } = await supabase.from('hospitals').select('agency_key, website');
  if (readError) throw new Error(readError.message);
  const have = new Map(existing.map((h) => [h.agency_key, h]));
  const now = new Date().toISOString();
  const updates = [];
  const inserts = [];
  for (const { websites, ...h } of hospitals) {
    const agency_key = agencyKey(h.name);
    const listed = { status: h.status, list_note: h.list_note, contacts: h.contacts, emails: h.emails, sheet_row: h.sheet_row, updated_at: now };
    const site = websites[0] ? `https://${websites[0].replace(/^https?:\/\//, '')}/` : null;
    const old = have.get(agency_key);
    if (old) updates.push({ agency_key, ...listed, ...(!old.website && site ? { website: site } : {}) });
    else inserts.push({ agency_key, name: h.name, website: site, source: 'winning-bid-tracker', ...listed });
  }
  for (const u of updates) {
    const { agency_key, ...change } = u;
    const { error } = await supabase.from('hospitals').update(change).eq('agency_key', agency_key);
    if (error) throw new Error(`${agency_key}: ${error.message}`);
  }
  if (inserts.length) {
    const { error } = await supabase.from('hospitals').insert(inserts);
    if (error) throw new Error(error.message);
  }
  console.log(`"${SHEET}": ${hospitals.length} hospitals (${inserts.length} added, ${updates.length} already there and updated).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
