// Adds contact persons to hospitals on the Hospital List (table hospitals, column contacts) from lists the team
// sends outside the WINNING BID TRACKER sheet. Each contact is saved as { name, role, phone, source: 'added' };
// tools/import-hospitals.mjs keeps 'added' contacts when it re-reads the sheet. A number already saved for the
// hospital is skipped, so running this twice adds nothing.
//   node tools/add-hospital-contacts.mjs --dry-run   (print what would be added)
//   node tools/add-hospital-contacts.mjs             (save)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const { createClient } = require('@supabase/supabase-js');
createRequire(import.meta.url)('dotenv').config({ path: path.join(root, '.env'), quiet: true });

// [name, mobile number as written (leading 0 dropped), department / position]. From the team's contact list, 2026-11-06.
const LISTS = {
  'SOUTHERN PHILIPPINES MEDICAL CENTER': [
    ['Dr. Marween Jay Brieta', '9190019300', 'Chief Resident - Anesthesia Department'],
    ['Dr. Dahlia Arancel', '9228940458', 'Head of Anesthesia Department'],
    ['Rhea Evangelista', '9922316533', "Procurement Officer / Released of PO's"],
    ['Sir Kit', '9388318933', 'Procurement Officer / Released NOA Consignment'],
    ['Jun Pisngot', '9562986509', 'Procurement Officer for RFQ'],
    ['Grace Fajardo', '9456310806', 'Procurement Officer for Bidding'],
    ['Sir Baltimore', '9778074704', 'Head of Material Management System (MMS)'],
    ['Raquel Lamparero', '9566233913', 'Pharmacist - Receiving Stocks'],
    ['Dimple', '9556474622', 'In-Patient Pharmacy - Receiving Consignment Stocks'],
    ['Deo Chris Viloria', '9171470581', 'Cancer Institute Pharmacist'],
  ],
  'NORTHERN MINDANAO MEDICAL CENTER': [
    ['Ana Maria Tadem', '9952391883', 'Procurement'],
    ["Ma'am Berly", '9193443634', 'Accounting'],
    ["Ma'am Amor", '9177060931', 'Accounting'],
    ['Mayeth', '9276302242', 'Main Pharmacy'],
  ],
  'AMAI PAKPAK MEDICAL CENTER': [
    ['Laarni', '9129512760', 'BAC Committee member / Malasakit Head'],
    ['Gemma', '9461628904', null],
    [null, '9283321949', 'Head Pharmacist'],
    ['Krishna', '9171571462', 'Secretary'],
    ['Inrahim Ampa', '9495080817', null],
    ['Nihar', '9664000979', 'Medonco'],
    ['Dr. Domado', '9177968330', 'Onco Head'],
    ['Marielyn Lucman', '9175017365', 'Chief Nurse'],
    ['Jevan Buntilao', '9388353115', 'Nurse Supervisor - Cancer Unit'],
  ],
};

// 9190019300 -> 0919 001 9300 (same layout as the sheet import)
const mobile = (d) => `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^0/, '');

async function main() {
  const dry = process.argv.includes('--dry-run');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
  for (const [key, people] of Object.entries(LISTS)) {
    const { data: h, error } = await supabase.from('hospitals').select('agency_key, contacts').eq('agency_key', key).maybeSingle();
    if (error) throw new Error(`${key}: ${error.message}`);
    if (!h) throw new Error(`${key} is not in table hospitals`);
    const have = new Set(h.contacts.map((c) => digits(c.phone)));
    const add = people.filter(([, phone]) => !have.has(phone)).map(([name, phone, role]) => ({ name, role, phone: mobile(phone), source: 'added' }));
    console.log(`${key}: ${add.length} to add (${people.length - add.length} already there)`);
    if (dry || !add.length) continue;
    const { error: saveError } = await supabase
      .from('hospitals')
      .update({ contacts: [...h.contacts, ...add], updated_at: new Date().toISOString() })
      .eq('agency_key', key);
    if (saveError) throw new Error(`${key}: ${saveError.message}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
