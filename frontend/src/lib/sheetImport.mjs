// Reads the team's WINNING BID TRACKER sheets (an ExcelJS workbook) for the Import Excel buttons of the Hospital List
// and the Abstract of Bids, and for tools/import-hospitals.mjs / tools/import-abstract.mjs: the same format as the
// original workbook. The whole tracker or a file with just that sheet both work: the sheet is found by its name,
// else by its header row. Plain .mjs (no Next imports) so the tools can run it with node.
import { agencyKey } from './agencyKey.js';

export const HOSPITAL_SHEET = 'Active Hospital';
export const ABSTRACT_SHEET = 'ABSTRACT 2026';

export const clean = (v) =>
  String(v ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const header = (v) => clean(cellText(v)).toUpperCase();

// A cell's own value: rich text and links become their text, formulas their result
function cellText(v) {
  if (v == null) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return typeof v.text === 'object' ? cellText(v.text) : v.text;
    if ('result' in v) return v.result;
    return null;
  }
  return v;
}

// The sheet with this name (spaces and case ignored), else the first sheet whose first row has all these headers.
// Returns { ws, cols: { HEADER: column number } }.
function findSheet(wb, name, headers) {
  const columns = (ws) => {
    const cols = {};
    ws.getRow(1).eachCell((cell, c) => {
      const h = header(cell.value);
      if (h && !(h in cols)) cols[h] = c;
    });
    return cols;
  };
  const sheets = wb.worksheets.filter((ws) => ws.state !== 'veryHidden');
  const byName = sheets.find((ws) => clean(ws.name).toUpperCase() === name.toUpperCase());
  const candidates = byName ? [byName, ...sheets.filter((ws) => ws !== byName)] : sheets;
  for (const ws of candidates) {
    const cols = columns(ws);
    if (headers.every((h) => h in cols)) return { ws, cols };
  }
  throw new Error(`No "${name}" sheet with the columns ${headers.join(', ')} in this file.`);
}

// ---------- Hospital List ("Active Hospital": HOSPITAL, STATUS, CONTACT NUMBER, CONTACT PERSON, HOSPITAL EMAIL ADDRESS)

// Names missing or misspelt on the sheet: the "[" row is Vicente Sotto (its e-mail is osm@vsmmc.doh.gov.ph)
const NAME_FIXES = {
  '[': 'VICENTE SOTTO MEMORIAL MEDICAL CENTER',
  'PHILIPPINE CHILDREN MEDICAL CENTER': "PHILIPPINE CHILDREN'S MEDICAL CENTER",
};

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
  if (t === 'ACTIVE TENDER' || t === 'ACTIVE') return { status: 'active', list_note: null };
  if (t === 'RFQ') return { status: 'rfq', list_note: null };
  return { status: 'prospect', list_note: clean(text) || null };
}

/**
 * One entry per hospital. A hospital can take several rows (merged HOSPITAL cell, or an empty HOSPITAL under it):
 * each row adds a contact person / number and maybe an e-mail. A value without "@" in the e-mail column is the
 * hospital's website. The sheet ends at "Prepared by".
 * Returns { sheet, hospitals: [{ name, status, list_note, contacts: [{name, phone}], emails, websites, sheet_row }] }.
 */
export function readHospitalSheet(wb) {
  const { ws, cols } = findSheet(wb, HOSPITAL_SHEET, ['HOSPITAL', 'STATUS']);
  const C = {
    name: cols.HOSPITAL,
    status: cols.STATUS,
    phone: cols['CONTACT NUMBER'] ?? 3,
    person: cols['CONTACT PERSON'] ?? 4,
    email: cols['HOSPITAL EMAIL ADDRESS'] ?? cols['EMAIL ADDRESS'] ?? cols.EMAIL ?? 5,
  };
  const hospitals = [];
  let current = null;
  let ended = false;
  ws.eachRow((row, n) => {
    if (n === 1 || ended) return;
    const value = (c) => {
      const cell = row.getCell(c);
      // A merged cell's other rows repeat the first row's value; only the first row counts
      if (cell.isMerged && cell.master.address !== cell.address) return null;
      return cellText(cell.value);
    };
    if (/prepared by/i.test(`${clean(row.getCell(C.person).value)} ${clean(row.getCell(C.email).value)}`)) {
      ended = true;
      return;
    }
    const a = row.getCell(C.name);
    const continuation = a.isMerged && a.master.address !== a.address;
    const rawName = clean(value(C.name));
    if (!continuation && rawName) {
      current = { name: NAME_FIXES[rawName.toUpperCase()] || rawName.toUpperCase(), ...status(value(C.status)), contacts: [], emails: [], websites: [], sheet_row: n };
      hospitals.push(current);
    } else if (!continuation && !clean(value(C.phone)) && !clean(value(C.person)) && !clean(value(C.email))) {
      return;
    }
    if (!current) return;
    const number = value(C.phone) == null ? '' : phone(value(C.phone));
    const who = person(value(C.person));
    if (number || who) current.contacts.push({ name: who || null, phone: number || null });
    for (const part of clean(value(C.email)).split(/[\s/;,]+/).filter(Boolean)) {
      const p = part.toLowerCase();
      if (p.includes('@')) !current.emails.includes(p) && current.emails.push(p);
      else !current.websites.includes(p) && current.websites.push(p);
    }
  });
  return { sheet: ws.name.trim(), hospitals };
}

/**
 * What saving the sheet's hospitals changes, given the hospitals already in the table ({ agency_key, website,
 * contacts }). A hospital already there keeps its name, website (unless it has none), procurement pages, note and
 * archive state; status, list note, contacts and e-mails come from the sheet; contacts added outside the sheet
 * (source 'added') are kept after the sheet's. Returns { inserts, updates } rows for table hospitals.
 */
export function planHospitalImport(hospitals, existing, { source = 'winning-bid-tracker', addedBy = null, now = new Date().toISOString() } = {}) {
  const have = new Map(existing.map((h) => [h.agency_key, h]));
  const inserts = [];
  const updates = [];
  const seen = new Set();
  for (const { websites, ...h } of hospitals) {
    const agency_key = agencyKey(h.name);
    if (!agency_key || seen.has(agency_key)) continue;
    seen.add(agency_key);
    const old = have.get(agency_key);
    const kept = (old?.contacts || []).filter((c) => c.source === 'added' && !h.contacts.some((s) => s.phone && s.phone === c.phone));
    const listed = { status: h.status, list_note: h.list_note, contacts: [...h.contacts, ...kept], emails: h.emails, sheet_row: h.sheet_row, updated_at: now };
    const site = websites[0] ? `https://${websites[0].replace(/^https?:\/\//, '').replace(/\/$/, '')}/` : null;
    if (old) updates.push({ agency_key, ...listed, ...(!old.website && site ? { website: site } : {}) });
    else inserts.push({ agency_key, name: h.name, website: site, source, added_by: addedBy, ...listed });
  }
  return { inserts, updates };
}

// ---------- Abstract of Bids ("ABSTRACT 2026": HOSPITAL, ITEM, ABC PRICE, QUANTITY, 2MG PRICE, WON, PRICE)

const amount = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.round(n * 10000) / 10000 : null;
};

/**
 * One entry per item. A merged HOSPITAL or WON cell counts for every row it covers; an empty HOSPITAL takes the one
 * above. 2MG PRICE empty = we did not bid. The year comes from the sheet name ("ABSTRACT 2026"), else this year.
 * Returns { sheet, year, results: [{ year, hospital, agency_key, item, abc_price, quantity, our_price, winner,
 * winning_price, sheet_row }] }.
 */
export function readAbstractSheet(wb) {
  const { ws, cols } = findSheet(wb, ABSTRACT_SHEET, ['HOSPITAL', 'ITEM', 'WON', 'PRICE']);
  const C = { hospital: cols.HOSPITAL, item: cols.ITEM, abc: cols['ABC PRICE'], qty: cols.QUANTITY, ours: cols['2MG PRICE'], won: cols.WON, price: cols.PRICE };
  const year = Number(ws.name.match(/20\d\d/)?.[0]) || new Date().getFullYear();
  const results = [];
  const seen = new Set();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const value = (c) => {
      if (!c) return null;
      const cell = row.getCell(c);
      return cellText(cell.isMerged ? cell.master.value : cell.value);
    };
    const item = clean(value(C.item));
    if (!item) return;
    const hospital = clean(value(C.hospital)).toUpperCase() || results.at(-1)?.hospital;
    if (!hospital) return;
    const key = `${agencyKey(hospital)}|${item}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      year,
      hospital,
      agency_key: agencyKey(hospital),
      item,
      abc_price: amount(value(C.abc)),
      quantity: amount(value(C.qty)),
      our_price: amount(value(C.ours)),
      winner: clean(value(C.won)).toUpperCase() || null,
      winning_price: amount(value(C.price)),
      sheet_row: n,
    });
  });
  return { sheet: ws.name.trim(), year, results };
}

// ---------- A hospital's own Abstract of Bids (every bidder's unit price per item, one column per bidder)
// Header row (within the first 10 rows): "Item No.", "Item Description", then "1. SAHAR INTERNATIONAL TRADING INC.",
// "2. ...", ...; extra columns such as "No. of Bids", "Lowest Bid", "Lowest Bidder" are ignored (worked out here).
// A price cell is a number, or "No Bid". Sheets without numbered bidder columns (a summary such as "2MG vs Lowest")
// are skipped. Several sheets (items 28-53, 136-162, ...) are read together.

// Us among the bidders (as on the Abstract of Bids page)
export const isOurBidder = (name) => /\b2\s*MG\b|GET\s*MEDS/i.test(name || '');
const BIDDER = /^(\d+)\s*[.)]\s*(\S.*)$/;

function abstractHeader(ws) {
  for (let n = 1; n <= Math.min(10, ws.rowCount); n++) {
    const cols = { bidders: [] };
    ws.getRow(n).eachCell((cell, c) => {
      const text = clean(cellText(cell.value));
      const h = text.toUpperCase();
      if (/^ITEM\s*(NO|#|NUMBER)/.test(h)) cols.no ??= c;
      else if (/^ITEM\s*DESCRIPTION|^DESCRIPTION|^PARTICULARS/.test(h)) cols.item ??= c;
      else if (BIDDER.test(text)) cols.bidders.push({ c, no: Number(text.match(BIDDER)[1]), name: clean(text.match(BIDDER)[2]).toUpperCase() });
    });
    if (cols.item && cols.bidders.length) return { row: n, ...cols };
  }
  return null;
}

/**
 * One result per item that got at least one bid: the winner (lowest unit price; the first on a tie) and its price,
 * and our price (2MG's bid; none = we did not bid). Items nobody bid on are left out. The file names no hospital
 * or year: they are asked for when importing (completeHospitalAbstract). The item keeps its number ("FUROSEMIDE
 * (item 29)") since a hospital can list the same medicine twice. A sheet without our column (e.g. only bidders 11-20
 * visible) gets a note: our price is unknown there, and the lowest is only the lowest of the bidders shown.
 * Returns null when no sheet is in this format, else { sheet, results, skippedNoBids }.
 */
export function readHospitalAbstract(wb) {
  const results = [];
  const sheets = [];
  let skippedNoBids = 0;
  for (const ws of wb.worksheets.filter((s) => s.state !== 'veryHidden')) {
    const head = abstractHeader(ws);
    if (!head) continue;
    sheets.push(ws.name.trim());
    const us = head.bidders.find((b) => isOurBidder(b.name));
    const nos = head.bidders.map((b) => b.no);
    const note = us ? null : `Our bid is not on the hospital's sheet "${ws.name.trim()}" (bidders ${Math.min(...nos)}–${Math.max(...nos)} only), so the winner is the lowest of those bidders.`;
    ws.eachRow((row, n) => {
      if (n <= head.row) return;
      const value = (c) => cellText(row.getCell(c).value);
      const description = clean(value(head.item));
      if (!description) return;
      const no = head.no ? clean(value(head.no)) : '';
      const bids = head.bidders
        .map((b) => ({ ...b, price: typeof value(b.c) === 'number' ? value(b.c) : amount(/\d/.test(String(value(b.c) ?? '')) ? value(b.c) : null) }))
        .filter((b) => b.price != null && b.price > 0);
      if (!bids.length) {
        skippedNoBids++;
        return;
      }
      const lowest = bids.reduce((best, b) => (b.price < best.price ? b : best));
      results.push({
        item: no ? `${description} (item ${no})` : description,
        winner: lowest.name,
        winning_price: Math.round(lowest.price * 10000) / 10000,
        our_price: us ? (bids.find((b) => b === us || b.c === us.c)?.price ?? null) : null,
        note,
        sheet_row: n,
      });
    });
  }
  if (!sheets.length) return null;
  return { sheet: sheets.join(', '), results, skippedNoBids };
}

/**
 * A hospital's own abstract with every bidder's price (for the Overall Abstract tracker, lib/abstractTracker.mjs):
 * one row per item, items nobody bid on included. Returns null when no sheet is in this format, else
 * { sheet, rows: [{ sheet, item_no, description, bids: [{ no, name, price }], ourColumn, sheetBidders }] } (ourColumn:
 * 2MG is a column on that sheet, so "no price" there means we did not bid; sheetBidders: every bidder on that sheet).
 */
export function readHospitalBidRows(wb) {
  const rows = [];
  const sheets = [];
  for (const ws of wb.worksheets.filter((s) => s.state !== 'veryHidden')) {
    const head = abstractHeader(ws);
    if (!head) continue;
    sheets.push(ws.name.trim());
    const ourColumn = head.bidders.some((b) => isOurBidder(b.name));
    ws.eachRow((row, n) => {
      if (n <= head.row) return;
      const value = (c) => cellText(row.getCell(c).value);
      const description = clean(value(head.item));
      if (!description) return;
      const bids = head.bidders
        .map((b) => ({ no: b.no, name: b.name, price: typeof value(b.c) === 'number' ? value(b.c) : amount(/\d/.test(String(value(b.c) ?? '')) ? value(b.c) : null) }))
        .filter((b) => b.price != null && b.price > 0)
        .map((b) => ({ ...b, price: Math.round(b.price * 10000) / 10000 }));
      rows.push({ sheet: ws.name.trim(), item_no: head.no ? clean(value(head.no)) : '', description, bids, ourColumn, sheetBidders: head.bidders.map((b) => b.name) });
    });
  }
  if (!sheets.length) return null;
  return { sheet: sheets.join(', '), rows };
}

/** The hospital and year chosen when importing, added to every result of readHospitalAbstract. */
export const completeHospitalAbstract = (results, { hospital, year }) => {
  const name = clean(hospital).toUpperCase();
  return results.map((r) => ({ ...r, hospital: name, agency_key: agencyKey(name), year: Number(year) || new Date().getFullYear(), abc_price: null, quantity: null }));
};
