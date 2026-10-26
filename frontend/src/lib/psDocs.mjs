import { createClient } from '@supabase/supabase-js';
import { loadMatcher } from './products.mjs';
import JSZip from 'jszip';
import { extractText, getDocumentProxy } from 'unpdf';
import { OCR_STILL_GOOD, OCR_VERSION, QUANTITY_COLUMN_MARK, ocrPdfPages } from './ocr.mjs';

// Reads each PS-PhilGEPS tender's bid documents (Storage bucket ps-documents) with free, rule-based text
// reading and stores per tender in ps_tender_analysis:
// - bid_data_sheet: the sentences giving the pre-bid conference, bid opening, submission deadline,
//   delivery period, bid validity and bid security (as written in the documents),
// - items (molecule tracker): every line that names one of our products (table products), with item no.,
//   quantity, unit, unit price and total where the line's layout allows (same rules as parseItemLine in
//   scraper.js); the raw line is always kept.
// PDFs, Word (.docx) and Excel (.xlsx) files are read; a table row of a Word or Excel file becomes one line.
// PDF pages with no text layer (scanned) are read with OCR (lib/ocr.mjs); a document whose pages still give
// too little text is listed in documents_read as "scanned".
// A tender is read again only when its documents, RULES_VERSION or our product list (matcher.key) change.
// Plain .mjs (no Next imports) so it can also be run directly with node.

// rules-20: several rows on one line never read by a header; Item No. + Unit on the line above a row; quantity above only under a Quantity-first header. rules-19: rows read by their table's header first (columns before the description from the left, after it from the right). rules-18: layouts Item | Description | Unit Price | Qty | Unit, Item | ABC Total | Description | Qty | Unit, Item | Unit | Description | Qty | Price, quantity on the line above ("200 PFS" / product / ABC per unit). rules-17: a Quantity column read on its own is used only when it agrees with the rows and never over a row whose quantity × price = total; "7.826" read as 7,826 when the total adds up. rules-16: a number whose next line starts with a strength unit ("1" / "g Vial") is never the quantity. rules-15: a quantity is a whole number (never an amount with centavos), unit "Ampule/Vial", numbered rows with no quantity read again without the Item No. (a bare number at the end; of two, the first). rules-14: an Item No. needs three rows numbered in order and is set aside only when it was read as the quantity; layouts Unit | Qty | Description, price before quantity, "pfs". rules-13: Item No. never the quantity. rules-12: each item keeps its row's text (written) for "As written". rules-11: the form under a table ("Purpose:", "Requested By") is never part of its last row. rules-10: scans straightened and table rules removed (ocr-3), rules left in a line, two-word units ("prefilled syringe"), a row's number when its quantity cell is empty, "Amikacide", "125mmg". rules-9: "<row no.> <unit> <description> <qty>" rows and rows broken over lines (the row number was read as the quantity). rules-8: misspelled names ("Rocorunium", "Epoeitin"). rules-7: molecule AND dosage (lib/products.mjs; B2B price list + PRODUCT LIST). rules-6: table products. rules-4: Word and Excel files, item codes like "DM14"
const RULES_VERSION = 'rules-20';
const READABLE = /\.(pdf|docx|xlsx)$/i;
const BUCKET = 'ps-documents';
const TEXT_PAGE_MIN_CHARS = 200; // fewer letters per page than this on average = scanned
const TENDERS_AT_ONCE = 3;
const OCR_MAX_MS = 90 * 1000; // OCR time per readDocuments call when the caller gives no deadline
// OCR is heavy on CPU. On the deployed server (Vercel Hobby: 4 h of CPU a month, 98% used on 2026-10-24, mostly
// by OCR retried every 5 minutes) it runs only with the setting OCR_ON_SERVER=on; on a team computer always.
// Pages OCR'd before stay in use from the cache.
export const OCR_ENABLED = !process.env.VERCEL || process.env.OCR_ON_SERVER === 'on';
// Pages per document; a longer scan is read up to here (40 cut the item lists of 90- to 180-page bidding
// documents, whose schedule of requirements is near the end)
const OCR_MAX_PAGES = 250;
// OCR text is kept in the same bucket under _ocr/<document path>.json (per page), so a re-read (e.g. after a
// product list change) or a reading cut short by time doesn't OCR the same pages again
const ocrCachePath = (doc) => `_ocr/${doc.path}.json`;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------- our products ----------

// The matcher for our product list (table products, lib/products.mjs: the PRODUCT LIST plus Add Molecule)
export { loadMatcher };

// ---------- item lines (ported from scraper.js parseItemLine / parseItemColumns; keep in step) ----------

const num = (s) => Number(s.replace(/,/g, ''));

// A delivery period after the amounts ("... 78,120.00 15 calendar days") is not part of the item
const DELIVERY_TAIL = /\s+\d+\s*(?:calendar\s+|working\s+)?days?\b.*$/i;

// An amount after a row's quantity above this, with at least this quantity, is the ABC total, not the unit price
const LARGE_AMOUNT = 50000;
const SIZEABLE_QUANTITY = 20;
// A unit price below this (₱ per unit) is not one: the amount is something else
const MIN_UNIT_PRICE = 0.1;

// quantity × unit price gives the total (1% for rounded prices)
const adds = (quantity, unitPrice, total) => quantity > 0 && Math.abs(quantity * unitPrice - total) <= total * 0.01;

// Units a quantity is counted in, for the layouts with no fixed column order
const KNOWN_UNIT_RE = String.raw`(?:pre-?\s?filled\s+)?(?:pfs|tab|tablet|cap|capsule|bottle|btl|botl|bot|vial|vl|amp|ampule|ampoule|box|bx|pc|piece|pack|sachet|tube|inhaler|nebule|syringe|bag|kit|set|unit|each|ea)(?:e?s)?\.?(?:\s?\/\s?(?:vial|amp|bottle|bot)s?)?`;

// A line that starts a new table row: a number, then a word or another number ("26 bottle ...", "DM14 Amikacin
// ...", "5,000 tablet", "10 30,000 Tablet"); not a row's continuation such as "10mg Tablet 100's 250" or a lone
// quantity. Also a row whose number OCR smudged ("© 1s boxes Cefuroxime ..."): a short word, then a unit.
const ROW_START = new RegExp(String.raw`^(?:[A-Z]{0,4}-?\d[\d,]*[.)]*\s+[\dA-Za-z]|\W*\S{1,3}\s+${KNOWN_UNIT_RE}\s)`, 'i');
const LONE_NUMBER = /^\d[\d,]*$/;
// The form around a table, never a row's continuation ("Purpose: Purchase of Drugs ...", "Requested By:")
const FORM_TEXT = /^\W*(?:purpose|requested|approved|prepared|received|certified|noted|recommend\w*|submitted|signed|signature|name|designation|total|grand total|sub-?total|note|notes|remarks|page \d)\b/i;
// Ends in a bare number (a quantity column without its unit), not a pack size such as "x 100" or "/100"
const ENDS_IN_NUMBER = /(?<![x×/]\s?)(?<=\s)\d[\d,]*$/i;
// "<row no.> <unit> ...": the row number is followed by the unit, so the quantity is the row's last number
const ROW_NO_UNIT = new RegExp(`^\\d{1,3}[.)]*\\s+${KNOWN_UNIT_RE}\\s`, 'i');

/** The row of lines[n] with the lines it continues on (at most two), up to the next row. A lone number is the
 * quantity cell only while the row has no quantity yet; after one it is the next row's number: "25 box
 * Cetirizine" / "10mg Tablet 100's 250" / "26" -> "25 box Cetirizine 10mg Tablet 100's 250" */
export function rowText(lines, n) {
  let row = lines[n];
  const rowNo = Number(/^(\d+)[.)]*\s/.exec(row)?.[1]);
  for (const next of lines.slice(n + 1, n + 3)) {
    if (!next || ROW_START.test(next) || FORM_TEXT.test(next)) break;
    if (LONE_NUMBER.test(next)) {
      // The next row's number ("88 ..." / "89") is never this row's quantity
      if (!ENDS_IN_NUMBER.test(row) && Number(next) !== rowNo + 1) row += ` ${next}`;
      break;
    }
    row += ` ${next}`;
  }
  return row;
}

// A table's rules OCR left in a line ("| 60 | vials] Cefoxitin ... |", "4m| 800") are not text
const withoutRules = (line) => (line || '').replace(/\s*[|[\]]+\s*/g, ' ').trim();

// A line's first number (not a strength such as "10 mg"), or a lone number (a row number on a line of its own)
const LEADING_NUMBER = /^\W*(\d{1,4})[.)]*(?:\s+(?!(?:mg|mcg|g|gm|ml|l|iu|units?|%)\b)|$)/i;
const leadingNumber = (line) => {
  const m = LEADING_NUMBER.exec(line || '');
  return m ? Number(m[1]) : null;
};
// A line that goes on with a strength's unit ("g Vial ...", "IU/Ml Solution ...", "mL Solution for Injection")
const STRENGTH_UNIT_START = /^\W*(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|%)\b/i;
// How far up and down to look for the rows numbered just before and after
const NUMBERING_REACH = 3;

/** The Item No. of lines[n]: its first number when it is one of three rows numbered in order nearby (k-1, k,
 * k+1, or the two before or after it: "58 vials ..." / "59 vials ..." / "60 vials Cefoxitin ..."), else null.
 * One neighbour isn't enough: a quantity-first list ("10 btl ...", "11 box ...") can have two in a row. */
function itemNumberOf(lines, n) {
  const k = leadingNumber(lines[n]);
  if (k == null) return null;
  const above = new Set();
  const below = new Set();
  for (let d = 1; d <= NUMBERING_REACH; d++) {
    above.add(leadingNumber(lines[n - d]));
    below.add(leadingNumber(lines[n + d]));
  }
  const run = (above.has(k - 1) && below.has(k + 1)) || (above.has(k - 1) && above.has(k - 2)) || (below.has(k + 1) && below.has(k + 2));
  return run ? k : null;
}

/** The columns of the table row starting on lines[n], also when the row is broken over lines (the text layer or
 * OCR puts the description's end and the quantity on the next lines). A line's own reading stays when it is
 * priced (quantity × unit price gives its total) or already has its quantity (the next lines are another row).
 * Rows numbered in order: the first number is the Item No. and never the quantity (user, 2026-10-26); the
 * quantity is read from the rest of the row, and stays empty when the row has none. */
// written: the row's text as the document gives it (its own line, or with the lines it continues on), shown as
// "As written"
export function parseItemRow(rawLines, n) {
  const lines = rawLines.map(withoutRules);
  // The table's own header first (user, 2026-10-26: "the documents usually have this on top so you will know
  // where is the name, quantity, and other needed info"); the row rules below when there is none or the row
  // doesn't fit it
  const fromHeader = byHeader(lines, n);
  if (fromHeader) return fromHeader;
  return quantityAbove(lines, n, rowColumns(lines, n));
}

// ---------- reading a row by its table's header ----------

// Header words, in the order they are tried at each place in the header line ("Item Description" is the
// description, not the Item No.; "Unit Cost" is a price, not the Unit)
const HEADER_WORDS = [
  ['description', /^(?:item\s+description|description(?:\s+of\s+(?:items?|goods))?|particulars|articles?|item\s+name|generic\s+name)\b/i],
  ['price', /^(?:unit\s+(?:cost|price|value)|abc\s*(?:\/|per)\s*unit|price\s+per\s+unit|estimated\s+unit\s+cost|cost\s+per\s+(?:unit|item)|unit\s+abc)\b/i],
  ['total', /^(?:total\s+(?:cost|price|amount|abc|value)|total|amount|abc|estimated\s+(?:cost|budget)|approved\s+budget)\b/i],
  ['quantity', /^(?:quantity|qty)\b\.?/i],
  ['unit', /^(?:unit\s+of\s+(?:issue|measure(?:ment)?)|uom|u\/m|unit)\b/i],
  ['item', /^(?:item\s*(?:no\.?|#|number)|stock\s*(?:\/\s*property\s*)?(?:no\.?|number)|property\s*no\.?|no\.|item|lot\s*no\.?)/i],
  ['text', /^(?:brand(?:\s+name)?|remarks?|delivery(?:\s+(?:period|schedule))?|manufacturer|country\s+of\s+origin)\b/i],
];

/** The columns a header line names, in order, e.g. ['item', 'unit', 'description', 'quantity', 'price', 'total'];
 * null unless it names a description and a quantity */
function headerColumns(line) {
  const columns = [];
  const text = line.replace(/\s+/g, ' ').trim();
  for (let at = 0; at < text.length; ) {
    const rest = text.slice(at);
    const hit = HEADER_WORDS.find(([, re]) => re.test(rest));
    if (hit) {
      if (columns.at(-1) !== hit[0]) columns.push(hit[0]);
      at += hit[1].exec(rest)[0].length;
    } else {
      const space = rest.indexOf(' ');
      at += space < 0 ? rest.length : space + 1;
    }
  }
  return columns.includes('description') && columns.includes('quantity') ? columns : null;
}

// How far above a row its header may be, in lines (a table running down the page)
const HEADER_REACH = 120;
const headerCache = new WeakMap();

/** The header of the table lines[n] is in: the nearest line above naming the columns (also a header broken over
 * two lines: "Item" / "No. Unit Description Quantity ..."), or null */
function headerFor(lines, n) {
  let found = headerCache.get(lines);
  if (!found) {
    found = [];
    lines.forEach((line, i) => {
      const columns = headerColumns(line) || (i + 1 < lines.length && headerColumns(`${line} ${lines[i + 1]}`));
      if (columns) found.push({ at: i, columns });
    });
    headerCache.set(lines, found);
  }
  return found.findLast((h) => h.at < n && n - h.at <= HEADER_REACH)?.columns || null;
}

const MONEY_TOKEN = /^\d[\d,]*\.\d{2}$/;
const COUNT_TOKEN = /^(?:\d{1,3}(?:[.,]\d{3})+|\d+)$/;
const ITEM_TOKEN = /^[A-Z]{0,4}-?\d+[.)]*$/;
const WORD_TOKEN = /^[A-Za-z][A-Za-z/.'’-]*$/;
const STRENGTH_TOKEN = /^(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)\.?$/i;

/** A row read by its table's header: the columns before the description from the left, those after it from the
 * right (an empty cell is skipped: an amount can only fill a price or total, a whole number the quantity), e.g.
 * "1 btl Amoxicillin ... 60ml/Oral 22,752 78.00 1,774,656.00" under "Item No. | Unit | Item Description |
 * Quantity | Unit Cost | Total Cost". null when the page has no header or the row has no quantity this way. */
function byHeader(lines, n) {
  const columns = headerFor(lines, n);
  if (!columns) return null;
  const read = (text) => {
    const tokens = text.split(/\s+/).filter(Boolean);
    const out = { written: text };
    const middle = columns.indexOf('description');
    // From the left: Item No., Unit, Quantity written before the description
    for (const key of columns.slice(0, middle)) {
      const token = tokens[0];
      if (token == null) return null;
      if (key === 'item' && ITEM_TOKEN.test(token)) out.item_no = tokens.shift().replace(/[.)]+$/, '');
      else if (key === 'quantity' && COUNT_TOKEN.test(token)) out.quantity = num(tokens.shift().replace(/\./g, ''));
      else if (key === 'unit' && WORD_TOKEN.test(token) && !STRENGTH_TOKEN.test(token)) {
        out.unit = tokens.shift();
        if (/^pre-?filled$/i.test(out.unit) && /^syringes?$/i.test(tokens[0] || '')) out.unit += ` ${tokens.shift()}`;
      } else if (key !== 'text') return null;
    }
    // From the right: Quantity, Unit, Unit Cost, Total after the description; an empty cell is skipped
    for (const key of columns.slice(middle + 1).reverse()) {
      const token = tokens.at(-1);
      if (token == null) break;
      if ((key === 'total' || key === 'price') && MONEY_TOKEN.test(token)) out[key === 'total' ? 'total' : 'unit_price'] = num(tokens.pop());
      else if (key === 'quantity' && COUNT_TOKEN.test(token) && !STRENGTH_TOKEN.test(tokens.at(-2) || '')) out.quantity = num(tokens.pop().replace(/\./g, ''));
      else if (key === 'unit' && WORD_TOKEN.test(token) && !STRENGTH_TOKEN.test(token) && out.quantity == null) out.unit = tokens.pop();
    }
    out.description = tokens.join(' ');
    if (out.quantity == null || !/[A-Za-z]/.test(out.description)) return null;
    // Several rows on one line ("Cetirizine 10 mg 500 Tablets Cinnarizine 25 mg 3000 Tablets Epinephrine ... 100
    // Ampules"): a quantity and unit inside the description with more words after them; the row rules read it
    if (new RegExp(`(?<![\\d.,])\\d[\\d,]*\\s+${KNOWN_UNIT_RE}\\s+[A-Za-z]{4,}`, 'i').test(out.description)) return null;
    // One amount in a column it can't be (the nearest header belongs to another table): a "total" under ₱0.10 a
    // unit is the unit price ("Amikacin ... 1,500 65.00"), a large "unit price" on a sizeable quantity the total
    if (out.total != null && out.unit_price == null && out.total / out.quantity < MIN_UNIT_PRICE) [out.unit_price, out.total] = [out.total, undefined];
    else if (out.unit_price != null && out.total == null && out.unit_price > LARGE_AMOUNT && out.quantity >= SIZEABLE_QUANTITY) [out.total, out.unit_price] = [out.unit_price, undefined];
    return out;
  };
  // The row on its own line, else with the lines it continues on
  const alone = read(lines[n]);
  // Not when the line's last number is a strength going on below ("... 1" / "g Vial ...")
  if (alone && !(STRENGTH_UNIT_START.test(lines[n + 1] || '') && /\s\d[\d,]*$/.test(lines[n]))) return alone;
  const row = rowText(lines, n);
  return row === lines[n] ? null : read(row);
}

// "<qty> <unit>" alone on a line: the Quantity and Unit columns of the row below it (not a strength: "500 mg")
const QTY_UNIT_LINE = /^(\d[\d,]*)\s+(?!(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)\.?$)([A-Za-z][A-Za-z/.'’]*(?:\s+syringes?)?)$/i;
const MONEY_END = /(?<![\d.,])(\d[\d,]*\.\d{2})$/;

/** A row read without a quantity whose line above is only "<qty> <unit>": QUANTITY | UNIT | DESCRIPTION | ABC/unit
 * forms whose text layer puts the quantity first, then the description, then the ABC/unit ("200 PFS" /
 * "Filgrastim 300 mcg/0.5 mL solution for injection" / "in pre-filled syringe (IV, SC) 1,500.00", PhilGEPS
 * 13298769). The unit price is the amount ending this line or one of the next two, before the next row. */
function quantityAbove(lines, n, parsed) {
  if (parsed.quantity != null) return parsed;
  const above = QTY_UNIT_LINE.exec(lines[n - 1] || '');
  if (!above) return parsed;
  // "<Item No.> <Unit>" above a row ending in "<qty> <unit price>": the row's start broken onto the line above
  // ("1 Ampule" / "or Vial Rocuronium Br 10Mg/Ml-5Ml Iv 180 99.78", PhilGEPS 13303642)
  const ends = /(?<![\d.,])(\d[\d,]*)\s+(\d[\d,]*\.\d{2})$/.exec(lines[n]);
  if (ends) return { ...parsed, item_no: above[1], unit: above[2], quantity: num(ends[1]), unit_price: num(ends[2]) };
  // Only under a header that puts the Quantity before the Description: elsewhere "<qty> <unit>" above is the end
  // of the row before (PhilGEPS 13283536)
  const columns = headerFor(lines, n);
  if (!columns || columns.indexOf('quantity') > columns.indexOf('description')) return parsed;
  let unitPrice;
  for (const line of lines.slice(n, n + 3)) {
    if (line !== lines[n] && QTY_UNIT_LINE.test(line)) break;
    const money = MONEY_END.exec(line);
    if (money) {
      unitPrice = num(money[1]);
      break;
    }
  }
  return { ...parsed, quantity: num(above[1]), unit: above[2], ...(unitPrice != null && { unit_price: unitPrice }) };
}

function rowColumns(lines, n) {
  const parsed = readRow(lines, n);
  if (parsed.unit_price != null) return parsed;
  const itemNo = itemNumberOf(lines, n);
  // The row read with its Item No. as the quantity, or with no quantity: read again without that number; no
  // quantity if none is left
  if (itemNo == null || (parsed.quantity != null && parsed.quantity !== itemNo)) return itemNo == null || parsed.item_no != null ? parsed : { ...parsed, item_no: String(itemNo) };
  const read = (text) => {
    const rest = text.replace(LEADING_NUMBER, '');
    const columns = parseItemLine(rest);
    // Item | Description | Quantity with no unit: the bare number ending the row ("28 Cetirizine 10mg/tablet X 100
    // 340"), not a pack size; of two, the first ("51 Cetirizine 10mg/tablet 2,500 10": Quantity, then Estimated
    // Cost per Item)
    // Not when the next line starts with a strength's unit: "69 Cefepime hydrochloride 1" / "g Vial ..." is 1 g
    const strengthGoesOn = text === lines[n] && STRENGTH_UNIT_START.test(lines[n + 1] || '');
    const bare = columns.quantity == null && !strengthGoesOn && /(?<![x×/]\s?)(?<=\s)(\d[\d,]*)(?:\s+\d[\d,]*)?$/i.exec(rest);
    const found = bare ? { description: rest.slice(0, bare.index).trim(), quantity: num(bare[1]) } : columns;
    return { ...found, item_no: String(itemNo), written: text };
  };
  const alone = read(lines[n]);
  const row = rowText(lines, n);
  const whole = row === lines[n] ? alone : read(row);
  return whole.quantity != null ? whole : alone;
}

function readRow(lines, n) {
  const own = { ...parseItemLine(lines[n]), written: lines[n] };
  if (own.unit_price != null) return own;
  // "<row no.> <unit> <description> <qty>": its own reading takes the row number as the quantity
  if (!ROW_NO_UNIT.test(lines[n]) && (own.quantity != null || ENDS_IN_NUMBER.test(lines[n]))) return own;
  const row = rowText(lines, n);
  const whole = row === lines[n] ? {} : { ...parseItemLine(row), written: row };
  return whole.quantity != null ? whole : own;
}

export function parseItemLine(fullLine) {
  const line = fullLine.replace(DELIVERY_TAIL, '');
  const parsed = parseItemColumns(line);
  // A priced row is taken as is when its quantity × unit price gives its total (a row whose own numbers
  // never add up keeps these columns)
  if (parsed.unit_price != null && adds(parsed.quantity, parsed.unit_price, parsed.total)) return parsed;
  // Any other layout ending in "<unit price> <total>": the quantity is the number that times the unit price
  // gives the total, the one nearest the price when several do, e.g. "500 TABLET Amlodipine 5 mg Tablet 2
  // 1,000.00", or "55100000 vial Vancomycin ..., 1gram 3000 450.00 1,350,000.00" (55100000 is a stock number)
  const tail = /^(.*\S)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})$/.exec(line);
  if (!tail) return priceBeforeQuantity(line, parsed);
  const [, rest, priceText, totalText] = tail;
  const unitPrice = num(priceText);
  const total = num(totalText);
  const quantity = (rest.match(/\d[\d,]*/g) || []).map(num).findLast((q) => adds(q, unitPrice, total));
  if (quantity == null) return parsed;
  // "<stock no.> <unit> <description> <quantity>" (PhilGEPS RFQ tables: Stock/Property No. | Unit | Description | Qty)
  const stock = /^(\S*\d\S*)\s+([A-Za-z][A-Za-z.'’]*)\s+(.+?)\s+([\d,]+)$/.exec(rest);
  if (stock && num(stock[4]) === quantity) {
    return { item_no: stock[1], unit: stock[2], description: stock[3], quantity, unit_price: unitPrice, total };
  }
  const base = parseItemColumns(rest);
  return { ...base, description: base.description || rest, quantity: adds(base.quantity, unitPrice, total) ? base.quantity : quantity, unit_price: unitPrice, total };
}

// "... <unit price> <quantity> <unit> <total>", e.g. "1 092600000 Lapatinib 250mg tablet, bottle of 30's 12,375.00 90
// Bottle 1,113,750.00": the quantity is the whole number that times a price on the line gives the total
function priceBeforeQuantity(line, parsed) {
  const end = /^(.*\S)\s+(\d[\d,]*\.\d{2})$/.exec(line);
  if (!end) return parsed;
  const total = num(end[2]);
  const prices = (end[1].match(/\d[\d,]*\.\d{2}/g) || []).map(num);
  // A whole number, also with a dot between thousands (OCR's "7.826" for 7,826: "7.826 1050.00 ~ 8,217,300.00")
  const whole = (s) => Number(s.replace(/[.,]/g, ''));
  for (const unitPrice of prices) {
    const m = [...end[1].matchAll(/(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d.,])(?:\s+([A-Za-z][A-Za-z/]*))?/g)].findLast((x) => adds(whole(x[1]), unitPrice, total));
    if (m) return { ...parsed, quantity: whole(m[1]), unit: m[2] || parsed.unit, unit_price: unitPrice, total };
  }
  return parsed;
}

function parseItemColumns(line) {
  // Item numbers may carry a letter code, e.g. "DM14"
  const ITEM = String.raw`([A-Z]{0,4}-?\d+)[.)]*`;
  // "Ampule/Vial" too
  const UNIT = String.raw`([A-Za-z][A-Za-z.'’]*(?:\/[A-Za-z]+)?)`;
  // A quantity is a whole number starting with a digit: a lone "," left by OCR is not one, nor an amount with
  // centavos ("3 293,100.00 Oxaliplatin ..." is a price, the quantity is further on)
  const QTY = String.raw`(\d[\d,]*)(?![.\d])`;
  const PRICE = String.raw`([\d,]+\.\d{2})`;
  // Item | Quantity | Unit | Description | Unit Price | Total
  const priced = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+?)\\s+${PRICE}\\s+${PRICE}$`).exec(line);
  if (priced) return { item_no: priced[1], quantity: num(priced[2]), unit: priced[3], description: priced[4], unit_price: num(priced[5]), total: num(priced[6]) };
  // A whole quantity, also with a dot between thousands (OCR's "27.100" for 27,100)
  const COUNT = String.raw`(\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)|\d+(?![.,]?\d))`;
  const count = (s) => Number(s.replace(/[.,]/g, ''));
  // Item | Description | Unit Price | Quantity | Unit: "1 Capecitabine 500mg ... (VAT EXEMPT) 14.23 27.100 tab"
  const priceQty = new RegExp(`^${ITEM}\\s+(.+?)\\s+${PRICE}\\s+${COUNT}\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (priceQty) return { item_no: priceQty[1], description: priceQty[2], unit_price: num(priceQty[3]), quantity: count(priceQty[4]), unit: priceQty[5] };
  // Item | ABC Total | Description | Quantity | Unit: "1 650,000.00 Idarubicin (as hydrochloride) powder, 5 mg vial 100 vial"
  const totalFirst = new RegExp(`^${ITEM}\\s+${PRICE}\\s+(.*[A-Za-z].*?)\\s+${COUNT}\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (totalFirst) return { item_no: totalFirst[1], total: num(totalFirst[2]), description: totalFirst[3], quantity: count(totalFirst[4]), unit: totalFirst[5] };
  // Item | Quantity | Unit | Description, e.g. "21. 5000 TAB LOSARTAN 100 MG"
  const qtyFirst = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+)$`).exec(line);
  if (qtyFirst) return { item_no: qtyFirst[1], quantity: num(qtyFirst[2]), unit: qtyFirst[3], description: qtyFirst[4] };
  // Item | Description | Quantity | Unit, e.g. "9 MIDAZOLAM 5MG/ML AMPULE 10’S 40 BX"
  const qtyLast = new RegExp(`^${ITEM}\\s+(.+?)\\s+(\\d[\\d,]*)\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (qtyLast) return { item_no: qtyLast[1], description: qtyLast[2], quantity: num(qtyLast[3]), unit: qtyLast[4] };
  // The remaining layouts have no fixed column order, so their unit must be a known one
  const KNOWN_UNIT = `(${KNOWN_UNIT_RE})`;
  // Item | Unit | Description | Quantity, e.g. "40 box Loratidine 10 mg Tablet 100's 150": the first number is the
  // row's number, the last one the quantity (not a pack size such as "x 100")
  const unitFirst = new RegExp(`^(\\d{1,3})[.)]*\\s+${KNOWN_UNIT}\\s+(.*[A-Za-z].*?)(?<![x×/])\\s+(\\d[\\d,]*)$`, 'i').exec(line);
  if (unitFirst) return { item_no: unitFirst[1], unit: unitFirst[2], description: unitFirst[3], quantity: num(unitFirst[4]) };
  // Item | Unit | Description | Quantity | Unit Price: "10 Tablet Capecitabine 500Mg In Blister Or Foil Pack 3,000 19.00"
  const unitFirstPriced = new RegExp(`^(\\d{1,3})[.)]*\\s+${KNOWN_UNIT}\\s+(.*[A-Za-z].*?)\\s+${COUNT}\\s+${PRICE}$`, 'i').exec(line);
  if (unitFirstPriced) {
    // The amount is the unit price ("3,000 19.00") or the ABC total ("32 box Cetirizine 10mg ... 100 336,000.00": a
    // box at ₱336,000 is not a price): a large amount on a sizeable quantity is the total
    const quantity = count(unitFirstPriced[4]);
    const amount = num(unitFirstPriced[5]);
    const isTotal = amount > LARGE_AMOUNT && quantity >= SIZEABLE_QUANTITY;
    return { item_no: unitFirstPriced[1], unit: unitFirstPriced[2], description: unitFirstPriced[3], quantity, ...(isTotal ? { total: amount } : { unit_price: amount }) };
  }
  // Unit | Quantity | Description ("Tablet 2,500 Cetirizine 10mg/tablet", once its Item No. is set aside)
  const unitQty = new RegExp(`^${KNOWN_UNIT}\\s+${QTY}\\s+(.*[A-Za-z].*)$`, 'i').exec(line);
  if (unitQty) return { unit: unitQty[1], quantity: num(unitQty[2]), description: unitQty[3] };
  // Unit | Description | Quantity: such a row once its Item No. is set aside ("Boxes Losartan 50mg/tab (60’s) 105")
  const unitDesc = new RegExp(`^${KNOWN_UNIT}\\s+(.*[A-Za-z].*?)(?<![x×/])\\s+(\\d[\\d,]*)$`, 'i').exec(line);
  if (unitDesc) return { unit: unitDesc[1], description: unitDesc[2], quantity: num(unitDesc[3]) };
  const descPriced = new RegExp(`^${ITEM}\\s+(.+?)\\s+${QTY}\\s+${KNOWN_UNIT}\\s+${PRICE}\\s+${PRICE}$`, 'i').exec(line);
  if (descPriced) return { item_no: descPriced[1], description: descPriced[2], quantity: num(descPriced[3]), unit: descPriced[4], unit_price: num(descPriced[5]), total: num(descPriced[6]) };
  const noItem = new RegExp(`^${QTY}\\s+${KNOWN_UNIT}\\s+(.+)$`, 'i').exec(line);
  if (noItem) return { quantity: num(noItem[1]), unit: noItem[2], description: noItem[3] };
  const descNoItem = new RegExp(`^(.*[A-Za-z].*?)\\s+(\\d[\\d,]*)\\s+${KNOWN_UNIT}$`, 'i').exec(line);
  if (descNoItem) return { description: descNoItem[1], quantity: num(descNoItem[2]), unit: descNoItem[3] };
  return {};
}

// ---------- bid data sheet ----------

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const DATE = String.raw`(?:[A-Z][a-z]+\.? \d{1,2},? \d{4}|\d{1,2}(?:st|nd|rd|th)? (?:day of )?[A-Z][a-z]+,? \d{4}|\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4})`;

// The first passage after one of the words that also holds the expected kind of value, cut to ~220
// characters at a sentence end, e.g. "Pre-Bid Conference: October 30, 2026, 1:30 PM via Zoom"
function passage(text, words, value) {
  const re = new RegExp(words, 'gi');
  for (let m; (m = re.exec(text)); ) {
    const window = text.slice(m.index, m.index + 260);
    if (!new RegExp(value, 'i').test(window)) continue;
    const cut = window.search(/(?<=\S{3}[.;])\s+[A-Z]/);
    return clean(cut > 40 ? window.slice(0, cut) : window.slice(0, 220));
  }
  return null;
}

function readBidDataSheet(text) {
  return {
    prebid_conference: passage(text, 'pre-?bid conference', DATE),
    bid_opening: passage(text, 'opening of (?:the )?bids|bid opening', DATE),
    bid_submission_deadline: passage(text, 'deadline (?:for|of) (?:the )?submission|submission of bids|bids must be (?:delivered|submitted)|submit (?:their|your) (?:bids|quotations?)', DATE),
    delivery_period: passage(text, 'delivery (?:period|schedule|time|of (?:the )?goods)', String.raw`\d+\s*(?:calendar\s+|working\s+)?days|${DATE}`),
    bid_validity: passage(text, 'bid validity|bids shall be valid|valid (?:for|until)', String.raw`\d+\s*(?:calendar\s+)?days|${DATE}`),
    bid_security: passage(text, 'bid securing declaration|bid security', String.raw`\d+(?:\.\d+)?\s*%|php|₱|declaration`),
  };
}

// ---------- reading a file ----------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (xml) =>
  xml
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : XML_ENTITIES[e]));

// Word: paragraphs are lines; a table row (its cells side by side) is one line, like a PDF table row
async function docxText(zip) {
  const xml = (await zip.file('word/document.xml')?.async('string')) || '';
  const rows = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) =>
    `${(row.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) || []).map((cell) => clean(xmlText(cell.replace(/<\/w:p>/g, ' ')))).filter(Boolean).join(' ')}</w:p>`
  );
  return xmlText(rows.replace(/<\/w:p>/g, '\n'));
}

// Excel: every sheet row is one line (cells in column order)
async function xlsxText(zip) {
  const shared = ((await zip.file('xl/sharedStrings.xml')?.async('string')) || '').match(/<si>[\s\S]*?<\/si>/g) || [];
  const strings = shared.map((si) => xmlText(si));
  const lines = [];
  for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const xml = await zip.file(name).async('string');
    for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) || []) {
      const cells = (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
        const value = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1] ?? xmlText(/<is>([\s\S]*?)<\/is>/.exec(c)?.[1] || '');
        return / t="s"/.test(c) ? strings[Number(value)] || '' : value;
      });
      const line = clean(cells.join(' '));
      if (line) lines.push(line);
    }
  }
  return lines.join('\n');
}

// A file's text as pages (a Word or Excel file is one "page"); [] when it can't be opened.
// pdf: the opened PDF (pdf.js), for OCR of its scanned pages
async function fileText(name, bytes) {
  if (/\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    return { pages: text, pdf };
  }
  const zip = await JSZip.loadAsync(bytes);
  return { pages: [/\.docx$/i.test(name) ? await docxText(zip) : await xlsxText(zip)] };
}

const letterCount = (text) => (text || '').replace(/\s/g, '').length;

// A page's Quantity column read on its own is used only when it agrees with the rows' own quantities at least as
// often as it disagrees (rows read with a quantity and an Item No. in the column); else it belongs to another
// table or column (PhilGEPS 13295969: 11,028 against the row's own 7,826 × 1,050.00 = 8,217,300.00)
function columnAgrees(lines, column) {
  let agree = 0;
  let disagree = 0;
  lines.forEach((line, n) => {
    if (!line) return;
    const row = parseItemRow(lines, n);
    const value = row.item_no != null && row.quantity != null ? column.get(Number(row.item_no)) : undefined;
    if (value == null) return;
    if (value === row.quantity) agree++;
    else disagree++;
  });
  return agree >= disagree;
}

// A page's text without the Quantity column line lib/ocr.mjs adds ("@@quantity-column 31 1 220 20 ..."), and
// that column as Item No. -> quantity (null when the page has none)
function quantityColumnOf(page) {
  const lines = String(page || '').split('\n');
  const at = lines.findIndex((l) => l.startsWith(QUANTITY_COLUMN_MARK));
  if (at < 0) return { text: page, quantities: null };
  const [start, ...values] = lines[at].slice(QUANTITY_COLUMN_MARK.length).trim().split(/\s+/).map(Number);
  lines.splice(at, 1);
  return { text: lines.join('\n'), quantities: new Map(values.map((v, i) => [start + i, v])) };
}

// Replaces the PDF's pages that have too little text with their OCR text (cached in Storage). Returns
// { pages, ocrPages: how many pages came from OCR, version: the OCR version that read them, complete: false when
// time ran out first, error: OCR failed }
async function withOcr(supabase, bucket, doc, pdf, pages, until) {
  const scanned = pages.map((p, i) => (letterCount(p) < TEXT_PAGE_MIN_CHARS ? i + 1 : null)).filter(Boolean).slice(0, OCR_MAX_PAGES);
  if (!scanned.length) return { pages, ocrPages: 0, complete: true };
  let cached = {};
  // The OCR version of the cached pages in use
  let version = OCR_VERSION;
  const { data: blob } = await supabase.storage.from(bucket).download(ocrCachePath(doc));
  if (blob) {
    try {
      const saved = JSON.parse(await blob.text());
      if (saved.size === doc.size) {
        cached = saved.pages || {};
        version = saved.version;
        // An older OCR's pages are read again with the current one where OCR runs (except those it would read
        // the same, OCR_STILL_GOOD); elsewhere (the deployed server) they stay in use until then
        if (saved.version !== OCR_VERSION && OCR_ENABLED) {
          const stillGood = OCR_STILL_GOOD[saved.version];
          cached = stillGood ? Object.fromEntries(Object.entries(cached).filter(([, text]) => stillGood(text || ''))) : {};
          version = OCR_VERSION;
        }
      }
    } catch {
      // unreadable cache: OCR again
    }
  }
  const todo = scanned.filter((n) => cached[n] == null);
  if (todo.length && !OCR_ENABLED) {
    // No new OCR here: what the cache has, and the document counts as read (no retry every few minutes)
    const merged = pages.map((p, i) => (cached[i + 1] != null && letterCount(cached[i + 1]) > letterCount(p) ? cached[i + 1] : p));
    return { pages: merged, ocrPages: scanned.filter((n) => letterCount(cached[n]) > letterCount(pages[n - 1])).length, version, complete: true, error: 'OCR is off on the server' };
  }
  if (todo.length) {
    let texts;
    try {
      ({ texts } = await ocrPdfPages(pdf, todo, { until }));
    } catch (e) {
      // OCR itself failed (not this document): read the rest as before, try the OCR again next run
      return { pages, ocrPages: 0, complete: true, error: e.message };
    }
    Object.assign(cached, texts);
    // Pages with no scanned picture (a short page of a text PDF) aren't worth a cache file
    if (Object.values(texts).some(Boolean) || todo.some((n) => texts[n] == null)) {
      await supabase.storage
        .from(bucket)
        .upload(ocrCachePath(doc), JSON.stringify({ version: OCR_VERSION, size: doc.size, pages: cached }), { contentType: 'application/json', upsert: true });
    }
  }
  const complete = scanned.every((n) => cached[n] != null);
  const merged = pages.map((p, i) => (cached[i + 1] != null && letterCount(cached[i + 1]) > letterCount(p) ? cached[i + 1] : p));
  return { pages: merged, ocrPages: scanned.filter((n) => letterCount(cached[n]) > letterCount(pages[n - 1])).length, version, complete };
}

// Documents read before OCR, or by an older OCR, that were scanned: read them again
// (never while OCR is off here: they would be queued again every few minutes)
export const ocrPending = (read) => OCR_ENABLED && (read || []).some((d) => (d.kind === 'scanned' || d.ocr_pages) && d.ocr !== OCR_VERSION);

// ---------- one tender ----------

// Which documents changed since the last reading (and which rules and product list read them)
export const documentsKey = (notice, listKey = '') => `${RULES_VERSION}|${listKey}|${(notice.documents || []).map((d) => `${d.path}:${d.size}`).sort().join('|')}`;

function readTender(supabase, matchProducts, notice, options) {
  return readDocuments(supabase, BUCKET, notice.documents, matchProducts, options);
}

/** For checking the readings (tools, never the Syncs): a file's pages as readDocuments reads them (text layer,
 * scanned pages from the OCR cache only — nothing new is read or saved), each page's lines, and per line the two
 * readings before the Quantity column: { pages: [{ lines, quantities }] } */
export async function documentPages(supabase, bucket, doc) {
  const { data: blob, error } = await supabase.storage.from(bucket).download(doc.path);
  if (error) throw new Error(`${doc.name}: ${error.message}`);
  let { pages, pdf } = await fileText(doc.name, new Uint8Array(await blob.arrayBuffer()));
  if (pdf) ({ pages } = await withOcr({ storage: { from: (b) => ({ download: (p) => supabase.storage.from(b).download(p), upload: async () => ({}) }) } }, bucket, doc, pdf, pages, 0));
  return { pages: pages.map(quantityColumnOf).map(({ text, quantities }) => ({ lines: text.split('\n').map(clean), quantities })) };
}

/** The two readings of a row, for checking: by its table's header (null without one) and by the row rules */
export function rowReadings(rawLines, n) {
  const lines = rawLines.map(withoutRules);
  return { byHeader: byHeader(lines, n), byRows: quantityAbove(lines, n, rowColumns(lines, n)) };
}

// Reads a tender's files ([{ name, path }] in Storage bucket `bucket`; also used by the PhilGEPS Sync,
// philgepsSync.mjs) for our products and the bid data sheet. Returns { status: done | skipped, read,
// result: { bid_data_sheet, items }, error }. A file that can't be opened is listed as "unreadable".
// ocrUntil: time (ms) when OCR of scanned pages stops; when it stops before every scanned page is read, this
// throws (the pages read so far are kept), so the caller reads the tender again on its next run.
export async function readDocuments(supabase, bucket, documents, matchProducts, { ocrUntil = Date.now() + OCR_MAX_MS } = {}) {
  const items = [];
  const seen = new Set();
  const read = [];
  const texts = [];
  for (const doc of documents || []) {
    if (!doc.path || !READABLE.test(doc.name)) {
      if (doc.path) read.push({ name: doc.name, kind: 'unsupported' });
      continue;
    }
    const { data: blob, error } = await supabase.storage.from(bucket).download(doc.path);
    if (error) throw new Error(`${doc.name}: ${error.message}`);
    let pages;
    let pdf;
    try {
      ({ pages, pdf } = await fileText(doc.name, new Uint8Array(await blob.arrayBuffer())));
    } catch {
      read.push({ name: doc.name, kind: 'unreadable' });
      continue;
    }
    const isPdf = /\.pdf$/i.test(doc.name);
    let ocrPages = 0;
    let ocrError;
    let ocrVersion;
    if (pdf) {
      const ocr = await withOcr(supabase, bucket, doc, pdf, pages, ocrUntil);
      if (!ocr.complete) throw new Error(`${doc.name}: scanned pages are still being read (OCR); the next run continues.`);
      ({ pages, ocrPages, error: ocrError, version: ocrVersion } = ocr);
    }
    const letters = pages.join('').replace(/\s/g, '').length;
    // Not readable: almost no text in the whole file, or mostly empty pages that OCR couldn't run on (yet).
    // Once OCR has read every page, a file with a filled first page and blank signature pages counts as read.
    const ocrRan = Boolean(pdf) && !ocrError;
    if (letters < TEXT_PAGE_MIN_CHARS || (!ocrRan && letters / Math.max(pages.length, 1) < TEXT_PAGE_MIN_CHARS)) {
      // ocr: OCR found no more text, so it isn't tried again; without it (OCR failed) the next run tries again
      read.push({ name: doc.name, kind: 'scanned', pages: pages.length, ...(pdf && (ocrError ? { ocr_error: ocrError.slice(0, 200) } : { ocr: OCR_VERSION })) });
      continue;
    }
    // ocr: which OCR read its scanned pages (an older one's are read again where OCR runs, ocrPending)
    read.push({ name: doc.name, kind: 'text', pages: pages.length, ...(ocrPages && { ocr_pages: ocrPages, ocr: ocrVersion }) });
    const marked = pages.map(quantityColumnOf);
    texts.push(marked.map((m) => m.text).join('\n'));
    marked.forEach(({ text: page, quantities: column }, i) => {
      const lines = page.split('\n').map(clean);
      const quantities = column && columnAgrees(lines, column) ? column : null;
      lines.forEach((line, n) => {
        // Our molecule on this line in one of our dosages (the dosage may be on the next two lines)
        const products = matchProducts.line(line, lines.slice(n + 1, n + 3).join('\n'));
        if (!products.length || line.length > 400) return;
        const key = line.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        // Table rows often break over several lines ("65 Aztreonam 1 g Powder for" / "injection 50 vials ..."),
        // so keep the next two lines to show with it when the line alone has no quantity
        const context = lines.slice(n, n + 3).filter(Boolean).join(' / ');
        const row = parseItemRow(lines, n);
        // The page's Quantity column read on its own (lib/ocr.mjs quantityColumn) gives the row's quantity by its
        // Item No., also when the column is shifted against the rows
        // A row whose own numbers add up (quantity × unit price = total) keeps its own quantity
        const checked = row.unit_price != null && adds(row.quantity, row.unit_price, row.total);
        const fromColumn = row.item_no != null && !checked ? quantities?.get(Number(row.item_no)) : undefined;
        if (fromColumn != null) {
          // The unit from the row itself ("60 vials Cefoxitin ..."), when its own reading had none
          const unit = row.unit || new RegExp(`^\\d{1,4}[.)]*\\s+(${KNOWN_UNIT_RE})\\s`, 'i').exec(row.written || line)?.[1];
          Object.assign(row, { quantity: fromColumn, quantity_from: 'column', ...(unit && { unit }) });
        }
        items.push({ our_products: products, ...row, line, context, source: `${doc.name}, ${isPdf ? `page ${i + 1}` : 'Word/Excel file'}` });
      });
    });
  }
  if (!read.some((d) => d.kind !== 'unsupported')) return { status: 'skipped', read, error: 'No PDF, Word or Excel documents.' };
  if (!texts.length) return { status: 'skipped', read, error: 'No readable text (scanned or damaged documents).' };
  return {
    status: 'done',
    read,
    result: { bid_data_sheet: readBidDataSheet(clean(texts.join('\n'))), items },
  };
}

// Reads the tenders whose documents are new or changed, a few at a time, until maxMs has passed.
// onProgress(done, total) after each tender. Returns { read, failed, left }.
export async function analyzePending({ maxMs = 200000, refs: only, onProgress } = {}) {
  const started = Date.now();
  const supabase = admin();
  const matchProducts = await loadMatcher();

  const { data: snap } = await supabase.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').maybeSingle();
  const { data: done } = await supabase.from('ps_tender_analysis').select('ref, documents_key, documents_read');
  const known = new Map((done || []).map((r) => [r.ref, r]));
  const queue = Object.entries(snap?.notices || {})
    .filter(([ref, n]) => (!only || only.includes(ref)) && n.documents?.some((d) => d.path))
    .filter(([ref, n]) => known.get(ref)?.documents_key !== documentsKey(n, matchProducts.key) || ocrPending(known.get(ref).documents_read))
    // Tenders that mention our products first
    .sort(([, a], [, b]) => (b.matched?.length || 0) - (a.matched?.length || 0));

  let readCount = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < queue.length && Date.now() - started < maxMs) {
      const [ref, notice] = queue[next++];
      let outcome;
      try {
        outcome = await readTender(supabase, matchProducts, notice, { ocrUntil: started + maxMs });
      } catch (e) {
        outcome = { status: 'failed', error: e.message };
      }
      if (outcome.status === 'failed') failed++;
      else readCount++;
      await supabase.from('ps_tender_analysis').upsert({
        ref,
        status: outcome.status,
        result: outcome.result || null,
        documents_read: outcome.read || null,
        // A failed reading keeps no key, so the next run tries again
        documents_key: outcome.status === 'failed' ? null : documentsKey(notice, matchProducts.key),
        error: outcome.error || null,
        model: RULES_VERSION,
        analyzed_at: new Date().toISOString(),
      });
      await onProgress?.(readCount + failed, queue.length);
    }
  };
  await Promise.all(Array.from({ length: TENDERS_AT_ONCE }, worker));
  return { read: readCount, failed, left: queue.length - next };
}
