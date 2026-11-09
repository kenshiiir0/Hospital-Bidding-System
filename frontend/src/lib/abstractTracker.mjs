// The Overall Abstract tracker (Abstract of Bids → Overall Abstract / All Bids tabs): read from the team's workbook
// (Overall_Abstract_2026_v2.xlsx) and written back in the same format by Export Excel. Two sheets:
//  - "Overall Abstract": per hospital, one or more groups (a header row "Item No. | Description | Qty | ABC Price |
//    Total ABC Price | Lowest Bid | Lowest Bidder | 2mg Price", the hospital's name in column A of every row), each
//    closed by a subtotal row (=SUM of Total ABC Price), then a yellow FINAL TOTAL row per hospital; notes at the end.
//  - "All Bids": one row per molecule, one column per bidder at a hospital ("ZUELLIG PHARMA - Davao Regional MC"),
//    unit prices or "No Bid", then No. of Bids, Lowest Bid, Lowest Bidder (formulas) and 2mg Price; notes at the end.
// Plain .mjs (no Next imports): the browser (Import / Export Excel) and node checks both use it. ExcelJS is passed in.
import { agencyKey } from './agencyKey.js';

export const OVERALL_SHEET = 'Overall Abstract';
export const BIDS_SHEET = 'All Bids';

const clean = (v) =>
  String(v ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// A cell's own value: rich text and links become their text, formulas their result
function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return typeof v.text === 'object' ? cellValue(v.text) : v.text;
    if ('result' in v) return v.result ?? null;
    return null;
  }
  return v;
}
const text = (cell) => clean(cellValue(cell.value));
// 1,092.50 / "₱1,092.50" -> 1092.5; "-", "No Bid", empty -> null
function amount(cell) {
  const v = cellValue(cell.value);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = clean(v).replace(/[₱,\s]/g, '');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const isRed = (cell) => /FF0000$/i.test(cell.font?.color?.argb || '');
export const isOurBidder = (name) => /^\s*(2\s*MG|GET\s*MEDS)\b/i.test(name || '');

function findSheet(wb, name, test) {
  const sheets = wb.worksheets.filter((ws) => ws.state !== 'veryHidden');
  return sheets.find((ws) => clean(ws.name).toUpperCase() === name.toUpperCase()) || sheets.find(test) || null;
}
const rowHeaders = (ws, r) => {
  const cols = {};
  ws.getRow(r).eachCell((cell, c) => {
    const h = text(cell).toUpperCase();
    if (h && !(h in cols)) cols[h] = c;
  });
  return cols;
};
const OVERALL_HEADERS = ['ITEM NO.', 'DESCRIPTION', 'QTY', 'ABC PRICE', 'LOWEST BID', 'LOWEST BIDDER'];
const isOverallHeader = (cols) => OVERALL_HEADERS.every((h) => h in cols);

/**
 * Reads the tracker workbook. Returns { sheets, items, molecules, meta } or null when the file is not this tracker.
 *  items: { hospital, agency_key, block, position, item_no, description, quantity, abc_price, lowest_bid,
 *           lowest_bidder, our_price }  (block = the hospital's group number, 1, 2, …)
 *  molecules: { position, item_no, molecule, prices: { bidder: price }, our_price }
 *  meta: { bidders: [column order], overall_notes: [], bids_notes: [], highlighted: [agency_key of a red name] }
 */
export function readTrackerWorkbook(wb) {
  const overall = findSheet(wb, OVERALL_SHEET, (ws) => isOverallHeader(rowHeaders(ws, 1)));
  const bids = findSheet(wb, BIDS_SHEET, (ws) => {
    const cols = rowHeaders(ws, 1);
    return 'MOLECULE' in cols && 'NO. OF BIDS' in cols;
  });
  if (!overall) return null;

  const items = [];
  const overallNotes = [];
  const highlighted = new Set();
  const blocks = new Map(); // agency_key -> groups seen
  let cols = null;
  let hospital = '';
  let inNotes = false;
  for (let r = 1; r <= overall.rowCount; r++) {
    const row = overall.getRow(r);
    const here = rowHeaders(overall, r);
    if (isOverallHeader(here)) {
      cols = here;
      const hc = cols['ITEM NO.'] - 1;
      hospital = hc >= 1 ? text(row.getCell(hc)).toUpperCase() : '';
      const key = agencyKey(hospital);
      if (key) {
        blocks.set(key, (blocks.get(key) || 0) + 1);
        if (isRed(row.getCell(hc))) highlighted.add(key);
      }
      inNotes = false;
      continue;
    }
    const first = text(row.getCell(1));
    if (/^notes:?$/i.test(first)) {
      inNotes = true;
      cols = null;
      continue;
    }
    if (inNotes) {
      if (first) overallNotes.push(first);
      continue;
    }
    if (!cols) continue;
    const description = text(row.getCell(cols.DESCRIPTION));
    // Subtotal and FINAL TOTAL rows have no item; they are rebuilt on export
    if (!description || /^FINAL TOTAL$/i.test(description)) continue;
    const key = agencyKey(hospital);
    if (!key) continue;
    items.push({
      hospital,
      agency_key: key,
      block: blocks.get(key),
      position: items.length + 1,
      item_no: text(row.getCell(cols['ITEM NO.'])) || '-',
      description,
      quantity: amount(row.getCell(cols.QTY)),
      abc_price: amount(row.getCell(cols['ABC PRICE'])),
      lowest_bid: amount(row.getCell(cols['LOWEST BID'])),
      lowest_bidder: /^no bid/i.test(text(row.getCell(cols['LOWEST BIDDER']))) ? null : text(row.getCell(cols['LOWEST BIDDER'])) || null,
      our_price: cols['2MG PRICE'] ? amount(row.getCell(cols['2MG PRICE'])) : null,
    });
  }

  const molecules = [];
  const bidders = [];
  const bidsNotes = [];
  if (bids) {
    const head = rowHeaders(bids, 1);
    const molCol = head.MOLECULE;
    const noCol = head['ITEM NO.'] || molCol - 1;
    const countCol = head['NO. OF BIDS'];
    const ourCol = head['2MG PRICE'];
    const bidderCols = [];
    for (let c = molCol + 1; c < countCol; c++) {
      const name = text(bids.getRow(1).getCell(c));
      if (name) {
        bidderCols.push([c, name]);
        bidders.push(name);
      }
    }
    let notes = false;
    for (let r = 2; r <= bids.rowCount; r++) {
      const row = bids.getRow(r);
      const molecule = text(row.getCell(molCol));
      if (/^notes:?$/i.test(molecule)) {
        notes = true;
        continue;
      }
      if (notes) {
        if (molecule) bidsNotes.push(molecule);
        continue;
      }
      if (!molecule) continue;
      const prices = {};
      for (const [c, name] of bidderCols) {
        const p = amount(row.getCell(c));
        if (p != null) prices[name] = p;
      }
      molecules.push({
        position: molecules.length + 1,
        item_no: text(row.getCell(noCol)) || String(molecules.length + 1),
        molecule,
        prices,
        our_price: ourCol ? amount(row.getCell(ourCol)) : null,
      });
    }
  }

  return {
    sheets: [overall.name, bids?.name].filter(Boolean),
    items,
    molecules,
    meta: { bidders, overall_notes: overallNotes, bids_notes: bidsNotes, highlighted: [...highlighted] },
  };
}

// ---------- Groups and totals (the page and the export count the same way)

/** Items (sorted by position) as hospitals → groups: [{ hospital, agency_key, blocks: [{ block, items }] }] */
export function groupTracker(items) {
  const hospitals = [];
  const byKey = new Map();
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
    let h = byKey.get(it.agency_key);
    if (!h) {
      h = { hospital: it.hospital, agency_key: it.agency_key, blocks: [] };
      byKey.set(it.agency_key, h);
      hospitals.push(h);
    }
    let b = h.blocks.find((x) => x.block === it.block);
    if (!b) {
      b = { block: it.block, items: [] };
      h.blocks.push(b);
    }
    b.items.push(it);
  }
  return hospitals;
}
/** Total ABC Price of one item: Qty × ABC Price, or null when either is missing (blank in Excel) */
export const totalAbc = (it) => (it.quantity == null || it.abc_price == null ? null : it.quantity * it.abc_price);
export const sumAbc = (items) => items.reduce((s, it) => s + (totalAbc(it) || 0), 0);

/** All Bids: No. of Bids, Lowest Bid and Lowest Bidder (first bidder at that price, in column order, like Excel's MATCH) */
export function moleculeStats(molecule, bidders) {
  const priced = bidders.filter((b) => typeof molecule.prices?.[b] === 'number');
  if (!priced.length) return { count: 0, lowest: null, bidder: null };
  const lowest = Math.min(...priced.map((b) => molecule.prices[b]));
  return { count: priced.length, lowest, bidder: priced.find((b) => molecule.prices[b] === lowest) };
}

// ---------- A hospital's own Abstract of Bids added to the tracker (Import Excel on the tracker tabs)

// Words that are not the drug's name: salts, forms, routes
const NOT_NAME = new Set(
  'as sodium na hcl hydrochloride sulfate sulphate acetate besilate besylate bromide br chloride cl carbonate mesilate mesylate phosphate dihydrate monohydrate trihydrate pentahydrate powder tablet tablets tab capsule cap vial ampule ampoule for injection inj solution suspension iv im sc and in of the with'.split(' ')
);
const FORMS = { tablet: /\btab(let)?s?\b/i, capsule: /\bcap(sule)?s?\b/i, powder: /\bpowder\b|lyophili[sz]ed/i, suspension: /\bsuspension\b/i };
const words = (s) =>
  clean(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9.%]+/g, ' ')
    .split(' ')
    .filter(Boolean);
// The drug's name: its first word that is not a number, a salt or a form ("CEFAZOLIN SODIUM" -> "cefazolin")
const drugName = (s) => words(s).find((w) => !/\d/.test(w) && w.length > 1 && !NOT_NAME.has(w)) || '';
// Strength numbers ("500 mg", "500mg", "500,000 units" -> 500, 500000)
const strengths = (s) => (clean(s).replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(\.\d+)?/g) || []).map(Number);

/**
 * Which tracker molecule (All Bids row) a hospital's item is: same drug name; when several of our molecules have that
 * name (Amlodipine 5 mg / 10 mg), the item's strength and form decide. Returns { molecule } | { ambiguous: [...] } | null.
 */
export function matchMolecule(description, molecules) {
  const name = drugName(description);
  if (!name) return null;
  let found = molecules.filter((m) => drugName(m.molecule) === name);
  if (found.length > 1) {
    const nums = strengths(description);
    if (nums.length) {
      const fit = found.filter((m) => nums.every((n) => strengths(m.molecule).includes(n)));
      if (fit.length) found = fit;
    }
  }
  if (found.length > 1) {
    const forms = Object.entries(FORMS).filter(([, re]) => re.test(description));
    if (forms.length) {
      const fit = found.filter((m) => forms.every(([, re]) => re.test(m.molecule)));
      if (fit.length) found = fit;
    }
  }
  if (!found.length) return null;
  return found.length === 1 ? { molecule: found[0] } : { ambiguous: found };
}

// "EAST AVENUE MEDICAL CENTER" -> "East Avenue MC", like the All Bids column names
export function shortHospital(name) {
  const title = clean(name)
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii)\b/g, (r) => r.toUpperCase());
  return title
    .replace(/\bHospital And Medical Center\b/g, 'H&MC')
    .replace(/\bMedical Center\b/g, 'MC')
    .replace(/\bHospital\b/g, 'H')
    .replace(/\bAnd\b/g, '&');
}
const ourColumnName = (name) => (isOurBidder(name) ? '2MG' : clean(name).toUpperCase());

/**
 * What adding one hospital's abstract (sheetImport.readHospitalBidRows) does to the tracker:
 *  - All Bids: a column "<BIDDER> - <hospital>" for each of its bidders, and their prices on our molecules;
 *    a column of that name already there (an earlier import of the same file) gets its prices replaced
 *  - Overall Abstract: our molecules' items as a new group for the hospital (Qty / ABC blank: not in the file),
 *    Lowest Bid / Lowest Bidder = the lowest of All Bids after the import; an earlier import of this hospital's
 *    abstract is replaced
 *  - other hospitals' rows of the same molecule: Lowest Bid lowered when a new price is lower
 * current = { items, molecules, meta } as loaded. Returns the change and what to tell the user.
 */
export function planHospitalMerge(current, rows, hospitalName) {
  const hospital = clean(hospitalName).toUpperCase();
  const key = agencyKey(hospital);
  const suffix = ` - ${shortHospital(hospital)}`;
  const molecules = current.molecules || [];
  const oldBidders = current.meta?.bidders || [];

  const matched = [];
  const ambiguous = [];
  let notOurs = 0;
  for (const row of rows) {
    const m = matchMolecule(row.description, molecules);
    if (!m) notOurs++;
    else if (m.ambiguous) ambiguous.push({ row, options: m.ambiguous.map((x) => x.molecule) });
    else matched.push({ row, molecule: m.molecule });
  }

  // New bidder columns: others before the first 2MG column, 2MG columns among the 2MG ones (A-Z)
  const columns = new Set();
  for (const { row } of matched) for (const b of row.bids) columns.add(ourColumnName(b.name) + suffix);
  const added = [...columns].filter((c) => !oldBidders.includes(c));
  const ours = (c) => isOurBidder(c);
  const firstOur = oldBidders.findIndex(ours);
  const others = firstOur < 0 ? [...oldBidders] : oldBidders.slice(0, firstOur);
  const ourOld = firstOur < 0 ? [] : oldBidders.slice(firstOur);
  const bidders = [...others, ...added.filter((c) => !ours(c)).sort(), ...[...ourOld, ...added.filter(ours)].sort((a, b) => a.localeCompare(b))];
  // Keep the tracker's own order for its own 2MG columns when nothing was added there
  const finalBidders = added.some(ours) ? bidders : [...others, ...added.filter((c) => !ours(c)).sort(), ...ourOld];

  // Prices: on the molecules this file lists, the columns of the bidders on that item's sheet are set again (an
  // earlier import replaced). Everything else is kept: "2MG - Tondo MC" can already hold our prices there from the
  // WINNING BID TRACKER, and a sheet showing bidders 11-20 only says nothing about our bid.
  const prices = new Map(molecules.map((m) => [m.id ?? m.position, { ...(m.prices || {}) }]));
  for (const { row, molecule } of matched) {
    const p = prices.get(molecule.id ?? molecule.position);
    for (const name of row.sheetBidders || row.bids.map((b) => b.name)) delete p[ourColumnName(name) + suffix];
  }
  for (const { row, molecule } of matched) {
    const p = prices.get(molecule.id ?? molecule.position);
    for (const b of row.bids) {
      const col = ourColumnName(b.name) + suffix;
      p[col] = p[col] == null ? b.price : Math.min(p[col], b.price);
    }
  }
  const changedMolecules = molecules
    .filter((m) => JSON.stringify(prices.get(m.id ?? m.position)) !== JSON.stringify(m.prices || {}))
    .map((m) => ({ id: m.id, prices: prices.get(m.id ?? m.position) }));
  const lowestOf = (m) => moleculeStats({ prices: prices.get(m.id ?? m.position) }, finalBidders);

  // The new group (our molecules only), and the earlier one from this hospital's file left out of the comparisons
  const replaced = (current.items || []).filter((it) => it.agency_key === key && it.source === 'hospital-abstract');
  const newItems = matched.map(({ row, molecule }, i) => {
    const low = lowestOf(molecule);
    const us = row.bids.find((b) => isOurBidder(b.name));
    return {
      item_no: row.item_no || '-',
      description: row.description,
      quantity: null,
      abc_price: null,
      lowest_bid: low.lowest,
      lowest_bidder: low.bidder,
      our_price: us ? us.price : null,
      order: i,
    };
  });

  // Other rows of these molecules (one sure match only): a lower price from this file lowers their Lowest Bid
  const lowered = [];
  const touched = new Set(matched.map(({ molecule }) => molecule.id ?? molecule.position));
  for (const it of current.items || []) {
    if (replaced.includes(it)) continue;
    const m = matchMolecule(it.description, molecules);
    if (!m?.molecule || !touched.has(m.molecule.id ?? m.molecule.position)) continue;
    const low = lowestOf(m.molecule);
    if (low.lowest != null && columns.has(low.bidder) && (it.lowest_bid == null || low.lowest < it.lowest_bid)) {
      lowered.push({ id: it.id, lowest_bid: low.lowest, lowest_bidder: low.bidder, description: it.description, hospital: it.hospital, was: it.lowest_bid });
    }
  }

  return {
    hospital,
    agency_key: key,
    bidders: finalBidders,
    addedColumns: added,
    molecules: changedMolecules,
    items: newItems,
    replacedItems: replaced.length,
    lowered,
    matched: matched.length,
    ambiguous,
    notOurs,
    withBids: matched.filter(({ row }) => row.bids.length).length,
  };
}

// ---------- Export Excel: the same layout, styles and formulas as the original workbook

const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const RED = 'FFFF0000';
const GREEN_HEAD = 'FFE2EFDA';
const BLUE_BID = 'FF9BC2E6';
const YELLOW = 'FFFFFF00';
const BLUE_HEAD = 'FFD9E1F2';
const ORANGE_HEAD = 'FFFCE4D6';
const PESO = '#,##0.00';
const asNumber = (s) => (/^\d+(\.\d+)?$/.test(String(s ?? '')) ? Number(s) : s);

function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Adds the two sheets to an ExcelJS workbook. data = { items, molecules, meta: { bidders, overall_notes, bids_notes, highlighted } } */
export function buildTrackerWorkbook(workbook, { items, molecules, meta }) {
  const highlighted = new Set(meta?.highlighted || []);

  // ----- Overall Abstract
  const ws = workbook.addWorksheet(OVERALL_SHEET, { views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }] });
  // 9.01: ExcelJS leaves a width of exactly 9 out of the file (its default), and Excel would show 8.43
  [42, 9.01, 60, 11, 11, 16, 12, 70, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const heads = ['Item No.', 'Description', 'Qty', 'ABC Price', 'Total ABC Price', 'Lowest Bid', 'Lowest Bidder', '2mg Price'];
  let r = 0;
  for (const h of groupTracker(items)) {
    const nameFont = highlighted.has(h.agency_key) ? { name: 'Calibri', color: { argb: RED } } : { name: 'Calibri', bold: true };
    const subtotals = [];
    let hospitalTotal = 0;
    for (const b of h.blocks) {
      r += 1;
      const head = ws.getRow(r);
      head.getCell(1).value = h.hospital;
      head.getCell(1).font = nameFont;
      heads.forEach((label, i) => {
        const c = head.getCell(i + 2);
        c.value = label;
        c.font = { name: 'Calibri', bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.border = BORDER;
        if (i >= 5) c.fill = fill(GREEN_HEAD);
      });
      const first = r + 1;
      for (const it of b.items) {
        r += 1;
        const row = ws.getRow(r);
        const total = totalAbc(it);
        row.getCell(1).value = h.hospital;
        row.getCell(1).font = nameFont;
        const cells = [
          [asNumber(it.item_no || '-'), { horizontal: 'center', vertical: 'middle' }],
          [it.description, { horizontal: 'center', vertical: 'middle', wrapText: true }],
          [it.quantity, { horizontal: 'right', vertical: 'middle' }, '#,##0'],
          [it.abc_price, { horizontal: 'right', vertical: 'middle' }, PESO],
          [{ formula: `IF(OR(D${r}="",E${r}=""),"",D${r}*E${r})`, result: total == null ? '' : total }, { horizontal: 'right', vertical: 'middle' }, PESO],
          [it.lowest_bid ?? '-', { horizontal: 'center', vertical: 'middle' }, PESO],
          [it.lowest_bidder || 'No bid found', { horizontal: 'left', vertical: 'middle', wrapText: true }],
          [it.our_price, { horizontal: 'right', vertical: 'middle' }, PESO],
        ];
        cells.forEach(([value, alignment, numFmt], i) => {
          const c = row.getCell(i + 2);
          c.value = value ?? null;
          c.font = { name: 'Calibri' };
          c.alignment = alignment;
          c.border = BORDER;
          if (numFmt) c.numFmt = numFmt;
        });
        // Lowest Bid: blue, bold; red when above this row's ABC price
        const bid = row.getCell(7);
        bid.fill = fill(BLUE_BID);
        bid.font = { name: 'Calibri', bold: true, ...(it.lowest_bid != null && it.abc_price != null && it.lowest_bid > it.abc_price ? { color: { argb: RED } } : {}) };
        if (!it.lowest_bidder) row.getCell(8).font = { name: 'Calibri', italic: true, color: { argb: 'FF808080' } };
      }
      r += 1;
      const subtotal = sumAbc(b.items);
      hospitalTotal += subtotal;
      const s = ws.getRow(r).getCell(6);
      s.value = { formula: `SUM(F${first}:F${r - 1})`, result: subtotal };
      s.font = { name: 'Calibri', bold: true, color: { argb: RED } };
      s.numFmt = PESO;
      s.border = BORDER;
      subtotals.push(`F${r}`);
    }
    r += 1;
    const fin = ws.getRow(r);
    for (let c = 1; c <= 9; c++) fin.getCell(c).fill = fill(YELLOW);
    fin.getCell(3).value = 'FINAL TOTAL';
    fin.getCell(3).font = { name: 'Calibri', bold: true, color: { argb: RED } };
    fin.getCell(3).alignment = { horizontal: 'center' };
    fin.getCell(6).value = { formula: subtotals.join('+'), result: hospitalTotal };
    fin.getCell(6).font = { name: 'Calibri', bold: true, color: { argb: RED } };
    fin.getCell(6).numFmt = PESO;
  }
  if (meta?.overall_notes?.length) {
    r += 2;
    ws.getCell(`A${r}`).value = 'Notes:';
    ws.getCell(`A${r}`).font = { name: 'Calibri', bold: true, size: 10 };
    for (const note of meta.overall_notes) {
      r += 1;
      ws.getCell(`A${r}`).value = note;
      ws.getCell(`A${r}`).font = { name: 'Calibri', italic: true, size: 10 };
    }
  }

  // ----- All Bids
  const bidders = meta?.bidders || [];
  if (!molecules?.length && !bidders.length) return workbook;
  const ab = workbook.addWorksheet(BIDS_SHEET, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  const firstBid = 3;
  const lastBid = firstBid + bidders.length - 1;
  const [cCount, cLow, cWho, cOur] = [lastBid + 1, lastBid + 2, lastBid + 3, lastBid + 4];
  const range = (row) => `${colName(firstBid)}${row}:${colName(lastBid)}${row}`;
  ab.getColumn(1).width = 7;
  ab.getColumn(2).width = 42;
  for (let c = firstBid; c <= lastBid; c++) ab.getColumn(c).width = 14;
  [8, 11, 44, 11].forEach((w, i) => (ab.getColumn(cCount + i).width = w));
  const small = (extra = {}) => ({ name: 'Calibri', size: 10, ...extra });
  const head = ab.getRow(1);
  head.height = 60;
  ['Item No.', 'Molecule', ...bidders, 'No. of Bids', 'Lowest Bid', 'Lowest Bidder', '2mg Price'].forEach((label, i) => {
    const c = head.getCell(i + 1);
    c.value = label;
    c.font = small({ bold: true });
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = BORDER;
    c.fill = fill(i + 1 >= cCount ? GREEN_HEAD : i >= 2 && isOurBidder(label) ? ORANGE_HEAD : BLUE_HEAD);
  });
  let br = 1;
  for (const m of [...(molecules || [])].sort((a, b) => a.position - b.position)) {
    br += 1;
    const row = ab.getRow(br);
    const stats = moleculeStats(m, bidders);
    const set = (c, value, alignment, extra = {}) => {
      const cell = row.getCell(c);
      cell.value = value ?? null;
      cell.font = small(extra.font);
      cell.alignment = alignment;
      cell.border = BORDER;
      if (extra.numFmt) cell.numFmt = extra.numFmt;
    };
    const center = { horizontal: 'center', vertical: 'middle' };
    set(1, asNumber(m.item_no), center);
    set(2, m.molecule, { horizontal: 'left', vertical: 'middle' });
    bidders.forEach((b, i) => {
      const p = m.prices?.[b];
      set(firstBid + i, typeof p === 'number' ? p : 'No Bid', center, typeof p === 'number' ? { numFmt: PESO } : {});
    });
    set(cCount, { formula: `COUNT(${range(br)})`, result: stats.count }, center);
    set(cLow, { formula: `IF(COUNT(${range(br)})=0,"-",MIN(${range(br)}))`, result: stats.lowest ?? '-' }, center, { font: { bold: true }, numFmt: PESO });
    set(
      cWho,
      {
        formula: `IF(COUNT(${range(br)})=0,"No bid found",INDEX($${colName(firstBid)}$1:$${colName(lastBid)}$1,MATCH(MIN(${range(br)}),${range(br)},0)))`,
        result: stats.bidder || 'No bid found',
      },
      { horizontal: 'left', vertical: 'middle', wrapText: true }
    );
    set(cOur, m.our_price, center, { numFmt: PESO });
  }
  if (meta?.bids_notes?.length) {
    br += 2;
    ab.getCell(`B${br}`).value = 'Notes:';
    ab.getCell(`B${br}`).font = small({ bold: true });
    for (const note of meta.bids_notes) {
      br += 1;
      ab.getCell(`B${br}`).value = note;
      ab.getCell(`B${br}`).font = small({ italic: true });
    }
  }
  return workbook;
}

/** Builds the workbook in the browser and downloads it as "Overall_Abstract_<year>.xlsx" */
export async function downloadTrackerWorkbook(data) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  buildTrackerWorkbook(workbook, data);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Overall_Abstract_${data.meta?.year || new Date().getFullYear()}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
