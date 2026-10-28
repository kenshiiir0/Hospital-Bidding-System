import { createClient } from '@supabase/supabase-js';
import { loadMatcher, withOcrUnits } from './products.mjs';
import JSZip from 'jszip';
import { extractText, getDocumentProxy } from 'unpdf';
import { OCR_STILL_GOOD, OCR_VERSION, QUANTITY_COLUMN_MARK, ocrPdfPages } from './ocr.mjs';
import { PACKAGE_ROW } from './packageTender.js';

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

// rules-48: a row's look-ahead ends at the next row's number; a scan's dotted thousands, 'rna' for mg and 'droDs' for drops; a loose mark after a row number; a strength-less priced row paired with its Item No.'s listing; a row's numbers after its bidder field; marks before the next row's name; a carried header naming one amount column checked against its page's rows. rules-47: a priced copy of a row is read even when an unpriced copy starts alike; Item | Qty | Unit | ABC | Description; '-' cells empty; the Price Schedule form's and offer/in-words columns are the bidder's; one amount meaning per page without a header; a row ends at its numbers and a lot heading; a '/' partner is a combination; the row's own form wins; a Schedule of Requirements quantity of 1 lot/package (or a price list headed by the whole as one lot) makes the tender a lot. rules-46: an ABC column that doesn't say per unit or total is read one way for its whole table, by which reading gives sensible unit prices; "ABC Unit Price" and "ABC Total" are one column each. rules-39: a chewable line only for a product our list states as chewable (Loratadine is a plain tablet). rules-38: our Bupivacaine is 0.5% as the Product List gives it, a line adding another percent strength (8% dextrose) is not ours, isobaric is. rules-37: concentration and our pack volume (bracket total ignored), whole row checked again (unit column form), rejected rows' copies dropped, a row's next lines read up to 8. rules-36: a volume-only product never against another strength, a product "in dextrose" needs dextrose. rules-35: our concentration x volume must give our amount, hospitals' shorthand (250MG/2ML), dosage form strict, a scan's "10 mg ml". rules-34: exact dosages (no concentration read as an amount, no concentration x volume), the same row kept once by its own number. rules-33: a quantity and amount alone on a row's last line end the row above. rules-32: a Price Schedule's bidder fields end a row, a dosage only from the row's own lines, delivery plan copies dropped. rules-31: big single amount is the total, unit price from total when they disagree, garbled amounts set aside, next row on a line cut, heading after the amounts, rows read once (best file first), package Schedule of Requirements. rules-30: only a table's rows are fetched (isTableRow; others kept as outside_table), a header starts at its own first line. rules-29: a row's price on its wrapped next line (with or without a header). rules-28: "Unit PR Price" and the bidder's empty bid columns, an empty Brand column keeps the description, Item | Qty | Unit | Description | amount, quantity on a scan's second line, dots in amounts, quantity written twice; worked-out amounts marked computed. rules-27: numbers lines below a row with no header, "... 100's box 50" rows, "Within twenty (20)" delivery; missing ABC/Unit or Total worked out. rules-26: a description going on with a strength ("100 mg tablet") is not the next row. rules-25: an ABC/unit of 100,000 or more is the ABC total. rules-24: one amount after the quantity (unit price for injectables, total for cheap tablets), delivery text and -do- set aside, only real unit words as units. rules-23: a long table's header carried to its next pages, rows read through their numbers line (up to 12 lines), delivery split and text columns after the numbers, ₱ signs, repeated rows without a quantity dropped. rules-22: a molecule's sub-rows (".01 250mg/ml ... 2,000 235.00 5,640,000.00") read as rows of their own; quantity before unit price when the total doesn't multiply out. rules-21: a dosage counts only in its molecule's own part of the line (lib/products.mjs ownPart). rules-20: several rows on one line never read by a header; Item No. + Unit on the line above a row; quantity above only under a Quantity-first header. rules-19: rows read by their table's header first (columns before the description from the left, after it from the right). rules-18: layouts Item | Description | Unit Price | Qty | Unit, Item | ABC Total | Description | Qty | Unit, Item | Unit | Description | Qty | Price, quantity on the line above ("200 PFS" / product / ABC per unit). rules-17: a Quantity column read on its own is used only when it agrees with the rows and never over a row whose quantity × price = total; "7.826" read as 7,826 when the total adds up. rules-16: a number whose next line starts with a strength unit ("1" / "g Vial") is never the quantity. rules-15: a quantity is a whole number (never an amount with centavos), unit "Ampule/Vial", numbered rows with no quantity read again without the Item No. (a bare number at the end; of two, the first). rules-14: an Item No. needs three rows numbered in order and is set aside only when it was read as the quantity; layouts Unit | Qty | Description, price before quantity, "pfs". rules-13: Item No. never the quantity. rules-12: each item keeps its row's text (written) for "As written". rules-11: the form under a table ("Purpose:", "Requested By") is never part of its last row. rules-10: scans straightened and table rules removed (ocr-3), rules left in a line, two-word units ("prefilled syringe"), a row's number when its quantity cell is empty, "Amikacide", "125mmg". rules-9: "<row no.> <unit> <description> <qty>" rows and rows broken over lines (the row number was read as the quantity). rules-8: misspelled names ("Rocorunium", "Epoeitin"). rules-7: molecule AND dosage (lib/products.mjs; B2B price list + PRODUCT LIST). rules-6: table products. rules-4: Word and Excel files, item codes like "DM14"
const RULES_VERSION = 'rules-48';
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

// A delivery period after the amounts ("... 78,120.00 15 calendar days", "... 462,500.00 Fifteen (15)
// calendar days", "... 70,000.00 Fifteen (15)") or a "-do-" (ditto) is not part of the item
const DELIVERY_TAIL = /\s+(?:\d+\s*(?:calendar\s+|working\s+)?days?\b|(?:within\s+)?(?:[A-Za-z-]+\s+)?\(\s*\d+\s*\)(?:\s*(?:calendar|working|days?)\b)?).*$|\s+-do-\s*$/i;
// "<description> <quantity> [unit] <amount>": the one amount is the ABC total when it is at least this and comes
// to this much a unit or more (70 vials, 10,500.00 = 150.00 each), else the unit price (100 vials, 215.00 each)
const TOTAL_AT_LEAST = 1000;
const TOTAL_PER_UNIT_AT_LEAST = 0.2;
const CHEAP_UNIT_PRICE_UP_TO = 100;

// An amount after a row's quantity above this, with at least this quantity, is the ABC total, not the unit price
const LARGE_AMOUNT = 50000;
const SIZEABLE_QUANTITY = 20;
// A unit price below this (₱ per unit) is not one: the amount is something else
const MIN_UNIT_PRICE = 0.1;

// quantity × unit price gives the total (1% for rounded prices)
const adds = (quantity, unitPrice, total) => quantity > 0 && Math.abs(quantity * unitPrice - total) <= total * 0.01;

// Units a quantity is counted in, for the layouts with no fixed column order
const KNOWN_UNIT_RE = String.raw`(?:pre-?\s?filled\s+)?(?:pfs|tab|tablet|cap|capsule|bottle|btl|botl|bot|vial|vl|amp|ampule|ampoule|box|bx|pc|piece|pack|sachet|tube|inhaler|nebule|syringe|bag|kit|set|unit|each|ea)(?:e?s)?\.?(?:\s?\/\s?(?:vial|amp|bottle|bot)s?)?`;

const KNOWN_UNIT_WORD = new RegExp(`^${KNOWN_UNIT_RE}$`, 'i');

// Sub-rows of a molecule ("33 Amikacin sulfate" / ".01 250mg/ml, 2ml ampule 2,000 235.00 5,640,000.00" / ".02
// ...", Philippine Heart Center): each strength is its own row, read as "33.01 Amikacin sulfate 250mg/ml, 2ml
// ampule 2,000 235.00 5,640,000.00" so its dosage is checked against ours and its numbers read; the molecule's own
// line (no numbers) is not a row then (isVariantParent)
const VARIANT = /^\.(\d{1,2})\s+(.*)$/;
const VARIANT_PARENT = /^(\d{1,4})[.)]?\s+([A-Za-z][^\d]*)$/;
export function expandVariants(lines) {
  let parent = null;
  return lines.map((line) => {
    const variant = VARIANT.exec(line || '');
    if (variant && parent) return `${parent.no}.${variant[1]} ${parent.name} ${variant[2]}`;
    const head = VARIANT_PARENT.exec(line || '');
    if (head) parent = { no: head[1], name: head[2].trim() };
    return line;
  });
}
export const isVariantParent = (lines, n) => VARIANT_PARENT.test(lines[n] || '') && VARIANT.test(lines[n + 1] || '');

// A line that starts a new table row: a number, then a word or another number ("26 bottle ...", "DM14 Amikacin
// ...", "5,000 tablet", "10 30,000 Tablet"); not a row's continuation such as "10mg Tablet 100's 250" or a lone
// quantity. Also a row whose number OCR smudged ("© 1s boxes Cefuroxime ..."): a short word, then a unit.
// (Not a strength going on: "100 mg tablet", "mL ampoule 596.00", PhilGEPS 13309762.) Sub-numbered rows too ("8.3
// PROPOFOL ...", "24.3 Folic Acid ...", PhilGEPS 13309069), and "4mL AMPULE ..." is a strength going on (PS 114476).
// A scan's loose mark after the number too ("22 . IV Infusion (microset) ...", PhilGEPS 13279404)
const ROW_START = new RegExp(String.raw`^(?:[A-Z]{0,4}-?\d[\d,]*(?:\.\d{1,2}(?=\s))?[.)]*\s+(?!(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)\b)[\dA-Za-z]|\d{1,4}\s[.•·:;|-]\s+[A-Za-z]|\W*(?!(?:\d+(?:\.\d+)?)?(?:mg|mcg|µg|g|gm|ml|l|iu)\s)\S{1,3}\s+${KNOWN_UNIT_RE}\s)`, 'i');
const LONE_NUMBER = /^\d[\d,]*$/;
// The form around a table, never a row's continuation ("Purpose: Purchase of Drugs ...", "Requested By:"), also the
// bidder's fields under each row of a Price Schedule ("brand", "packaging/model", "country of origin", "cpr
// manufacturer", "Amount In Words", PhilGEPS 13300232). "Packaging: 20 mL x glass ampule or vial" is the row's own
// description going on (PS 101007): a packaging or brand line is a bidder's field only when it is a bare label. A
// lot's heading and subtotal alone on a line ("LOT 2 2,395,500.00", PhilGEPS 13292592) starts the next section
const LOT_HEADING = /^\W*(?:lot|batch|group)\s*(?:no\.?\s*)?\d{1,3}[A-Za-z]?\s*[:.-]?\s*(?:(?:php|₱)?\s*\d[\d,]*\.\d{2})?\s*$/i;
const FORM_TEXT = new RegExp(String.raw`^\W*(?:purpose|requested|approved|prepared|received|certified|noted|recommend\w*|submitted|signed|signature|name|designation|total|grand total|sub-?total|note|notes|remarks|page \d|country of origin|cpr|manufacturer|amount in words)\b|^\W*(?:brand(?:\s+name)?|packaging(?:\s*\/\s*model)?)[\W_]*$|${LOT_HEADING.source}`, 'i');
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
    // A row ends at its numbers ("Vial Amikacin ... 2 mL vial" / "(IM, IV) 20 235.00 4,700.00" / "Capsule Amoxicillin
    // ... 9,000 6.00 54,000.00": the next row's numbers are not this row's, PhilGEPS 13284382)
    if (!next || ROW_START.test(next) || FORM_TEXT.test(next) || ENDS_IN_NUMBERS.test(row)) break;
    if (LONE_NUMBER.test(next)) {
      // The next row's number ("88 ..." / "89") is never this row's quantity
      if (!ENDS_IN_NUMBER.test(row) && Number(next) !== rowNo + 1) row += ` ${next}`;
      break;
    }
    row += ` ${next}`;
  }
  return row;
}

// A table's rules OCR left in a line ("| 60 | vials] Cefoxitin ... |", "4m| 800") are not text; nor is the peso
// sign before an amount ("₱ 90.00")
const withoutRules = (line) => (line || '').replace(/\s*[|[\]]+\s*/g, ' ').replace(/₱\s*/g, '').trim();
/** A row with the next row run onto its line ("9 Bupivacaine 0.5%, 5ml ... 700,000.00 10 CalciumCarbonate 6.00 ...",
 * PS 94918; "22 Carboplatin ... vial 600 23 Carvedilol 6.25 mg tablet 564,000", PhilGEPS 13300871): cut where the
 * next row's number and name begin (k+1, then a name that is not a unit) */
function withoutNextRow(line) {
  const own = /^\W{0,2}(\d{1,4})[.)]?\s+[A-Za-z]/.exec(line);
  if (!own) return line;
  // (a scan's loose mark after the number and a short first word: "... 10,850.00 22 . IV Infusion (microset) ...",
  // PhilGEPS 13279404)
  const next = new RegExp(String.raw`\s${Number(own[1]) + 1}(?:[.)]|\s[.•·:;|-])?\s+(?!${KNOWN_UNIT_RE}\b)(?:[A-Z][A-Za-z]{3,}|[A-Z]{2,}\s+[A-Z][A-Za-z]{3,})`).exec(line.slice(own[0].length));
  return next ? line.slice(0, own[0].length + next.index).trim() : line;
}
/** An amount broken over two lines by a narrow column ("... 80.39 309,50" / "1.50", "2,417,250.0" / "0", PhilGEPS
 * 13280005): put back together on the first line, the second left empty (the lines keep their places) */
function joinSplitAmounts(lines) {
  const out = [...lines];
  for (let k = 0; k < out.length - 1; k++) {
    const head = /(?<=\s)(\d[\d,.]*\d)$/.exec(out[k]);
    const tail = /^\d{0,3}(?:\.\d{0,2})?$/.exec(out[k + 1]);
    if (!head || !tail || !out[k + 1] || /^\d{1,3}(?:,\d{3})*\.\d{2}$/.test(head[1])) continue;
    const joined = head[1] + out[k + 1];
    if (!/^\d{1,3}(?:,\d{3})+\.\d{2}$/.test(joined)) continue;
    out[k] = out[k].slice(0, head.index) + joined;
    out[k + 1] = '';
  }
  return out;
}
// The same lines cleaned once per page (the header found on a page is kept with them)
const cleanedCache = new WeakMap();
// Cells left empty with a dash after a number ("2mL vial (IV) 1,500 - - 6,300,000.00 - -", PhilGEPS 13282466): gone,
// so the numbers around them are read as neighbours. Not a range ("Folic Acid 20 – 65 mcg"): only before an amount or
// the line's end
const withoutEmptyCells = (line) => line.replace(/(?<=\d)(?:\s+(?:[-–—]{1,2}|n\/a))+(?=\s+\d[\d,]*\.\d{2}(?!\d)|\s*$)/gi, '');
// An amount a scan wrote with dots between its thousands ("300 61.00 18.300.00", "2.087.50", PhilGEPS 13279404): read
// with commas, as every rule expects
const withCommaThousands = (line) => line.replace(/(?<![\d.,])\d{1,3}(?:\.\d{3})+\.\d{2}(?![\d.,])/g, (amount) => amount.replace(/\.(?=\d{3}[.])/g, ','));
const cleanLines = (rawLines) => {
  let lines = cleanedCache.get(rawLines);
  if (!lines) cleanedCache.set(rawLines, (lines = joinSplitAmounts(rawLines.map((line) => withoutEmptyCells(withCommaThousands(withoutNextRow(withoutRules(line))))))));
  return lines;
};

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
  const lines = cleanLines(rawLines);
  // The table's own header first (user, 2026-10-26: "the documents usually have this on top so you will know
  // where is the name, quantity, and other needed info"); the row rules below when there is none or the row
  // doesn't fit it
  const fromHeader = byHeader(lines, n);
  const row = abcTotalNotUnit(fromHeader || quantityAbove(lines, n, rowColumns(lines, n)));
  if (row.quantity == null) return rowBelow(lines, n) || row;
  // Its amounts on the lines below, after its unit ("5 Propofol ... (IV) 4,000" / "vial /" / "ampule 250.00
  // 1,000,000.00 500,000.00", PhilGEPS 13282466)
  const below = row.unit_price == null && row.total == null && rowBelow(lines, n);
  return below && below.quantity === row.quantity && (below.unit_price != null || below.total != null) ? below : row;
}

// A numbers line ending a row: its unit, then quantity, unit price and/or total ("syringe/vial 10,000 450.00
// 4,500,000.00", "Syringe 50 20,000.00")
const UNIT_NUMBERS_LINE = /^[A-Za-z][A-Za-z/.'’-]*(?:\s+[A-Za-z][A-Za-z/.'’-]*)?\s+\d[\d,]*\s+\d[\d,]*\.\d{2}(?:\s+\d[\d,]*\.\d{2})?$/;
// A unit broken over lines after the quantity ("... 400 ampule /" / "vial 72.00 28,800.00 14,400.00"; "... (IV) 4,000" /
// "vial /" / "ampule 250.00 1,000,000.00 500,000.00", PhilGEPS 13282441, 13282466; "3,100 pre-filled" / "syringe
// 264.71 820,601.00", PS 101007): the row so far ends in its quantity
const SPLIT_UNIT_END = /\s\d[\d,]*(?:\s+[A-Za-z][A-Za-z/-]*)*(?:\s*\/)?$/;
const UNIT_AMOUNTS_LINE = /^\W*[A-Za-z][A-Za-z/-]*(?:\s+\d[\d,]*\.\d{2}){1,3}(?:\s+[A-Za-z(].*)?$/;
// Only the quantity and its amount(s) on the row's last line ("78 Enoxaparin ... prefilled" / "syringe" / "600 410.00",
// PS 105627): the end of the row above, not a row of its own
const QTY_AMOUNT_LINE = /^\d[\d,]*\s+\d[\d,]*\.\d{2}(?:\s+\d[\d,]*\.\d{2})?$/;

/** A row with no header to read it by whose description runs over lines and whose numbers end it some lines
 * below ("7" / "Epoetin alfa 4000iu/0.4ml OR" / "4000iu/1ml,IV,SC (Recombinant Human" / ... / "syringe/vial 10,000
 * 450.00 4,500,000.00", PS 107172): read whole from the row's first line (its number before it or on it), up to
 * the next row; null otherwise */
function rowBelow(lines, n) {
  const before = lines[n - 1] || '';
  const ownNumber = /^\d{1,4}[.)]*\s+[A-Za-z]/.test(lines[n]);
  if (!(ownNumber || !before || LONE_NUMBER.test(before) || /\d\.\d{2}$/.test(before))) return null;
  const parts = [lines[n]];
  let found = false;
  for (const [k, next] of lines.slice(n + 1, n + ROW_LINES).entries()) {
    // The Quantity written twice on a line of its own (Quantity | Total Quantity: "500 500", PS 105627)
    const twice = /^(\d[\d,]*)\s+(\d[\d,]*)$/.exec(next || '');
    // "3,100 pre-filled" / "syringe 264.71 820,601.00" (PS 101007): this row's quantity, its unit going on below
    const qtyGoesOn = SPLIT_UNIT_END.test(` ${next}`) && UNIT_AMOUNTS_LINE.test(lines[n + 2 + k] || '');
    if (twice && twice[1] === twice[2] && parts.length >= 2) {
      const itemNo = ownNumber ? leadingNumber(lines[n]) : LONE_NUMBER.test(before) ? Number(before) : null;
      const text = [...parts, next].join(' ');
      return { ...(itemNo != null && { item_no: String(itemNo) }), description: parts.join(' ').replace(LEADING_NUMBER, ''), quantity: num(twice[1]), written: text };
    }
    // Each cell on a line of its own ("vial" / "40,000" / "132.00" / "5,280,000.00", PS 106363): a lone number
    // followed by a lone amount is this row's quantity, the amounts after it its prices
    if (LONE_NUMBER.test(next || '') && MONEY_TOKEN.test(lines[n + 2 + k] || '') && parts.length >= 2) {
      parts.push(next, ...lines.slice(n + 2 + k, n + 4 + k).filter((l) => MONEY_TOKEN.test(l)));
      found = true;
      break;
    }
    if (!next || LONE_NUMBER.test(next) || FORM_TEXT.test(next) || (ROW_START.test(next) && !NUMBERS_LINE.test(next) && !QTY_AMOUNT_LINE.test(next) && !qtyGoesOn)) return null;
    parts.push(next);
    if ((found = UNIT_NUMBERS_LINE.test(next) || NUMBERS_LINE.test(next) || QTY_AMOUNT_LINE.test(next) || ROW_AMOUNTS.test(next) || (SPLIT_UNIT_END.test(parts.slice(0, -1).join(' ')) && UNIT_AMOUNTS_LINE.test(next)))) break;
  }
  if (!found) return null;
  const itemNo = ownNumber ? leadingNumber(lines[n]) : LONE_NUMBER.test(before) ? Number(before) : null;
  const text = parts.join(' ');
  const parsed = parseItemLine(ownNumber ? text.replace(LEADING_NUMBER, '') : text);
  if (parsed.quantity == null) return null;
  return abcTotalNotUnit({ ...parsed, ...(itemNo != null && { item_no: String(itemNo) }), written: text });
}

// An ABC/unit can't be hundreds of thousands (user, 2026-10-27: "always assume it as abc total"): such an amount
// read as the unit price is the ABC total
const UNIT_PRICE_MAX = 100000;
// One amount that, as the unit price, would make the line's total this big while still a sensible price a unit is
// the ABC total ("Amikacin ... 2mL Vial 700 49,000.00" under "Approved Budget Cost": ₱70 a vial, not ₱34.3M; PS 102904)
const LINE_TOTAL_TOO_BIG = 10000000;
const SENSIBLE_UNIT_PRICE = 0.5;
function abcTotalNotUnit(row) {
  const tooBig =
    row.unit_price >= UNIT_PRICE_MAX ||
    (row.total == null && row.quantity > 0 && row.unit_price * row.quantity > LINE_TOTAL_TOO_BIG && row.unit_price / row.quantity >= SENSIBLE_UNIT_PRICE);
  if (!tooBig) return row;
  const { unit_price: amount, ...rest } = row;
  return { ...rest, total: rest.total ?? amount };
}

// The missing amount worked out as the team's sheet does (user, 2026-10-27): ABC/Unit = ABC Total ÷ Qty, ABC
// Total = Qty × ABC/Unit. Applied when a row is kept, after the Quantity column check (a worked-out price always
// "adds up")
export function withBothAmounts(row) {
  if (!(row.quantity > 0)) return row;
  // A unit price that doesn't give the total (a scan misreading a digit: "800 ... 1043.00 1,316,480.00" for 1645.60,
  // PS 107166): the row's quantity and ABC total stand, the ABC/Unit is worked out from them
  if (row.unit_price != null && row.total != null && !adds(row.quantity, row.unit_price, row.total) && Math.abs(row.quantity * row.unit_price - row.total) > row.total * 0.01) {
    return { ...row, unit_price: Math.round((row.total / row.quantity) * 100) / 100, computed: 'unit_price', read_unit_price: row.unit_price };
  }
  // computed: which amount was worked out, not read (shown green: View details, the Excel)
  if (row.unit_price == null && row.total != null) return { ...row, unit_price: Math.round((row.total / row.quantity) * 100) / 100, computed: 'unit_price' };
  if (row.total == null && row.unit_price != null) return { ...row, total: Math.round(row.quantity * row.unit_price * 100) / 100, computed: 'total' };
  return row;
}

// ---------- reading a row by its table's header ----------

// Header words, in the order they are tried at each place in the header line ("Item Description" is the
// description, not the Item No.; "Unit Cost" is a price, not the Unit)
const HEADER_WORDS = [
  ['description', /^(?:item\s+description|description(?:\s+of\s+(?:items?|goods))?|particulars|articles?|item\s+name|generic\s+name)\b/i],
  // The bidder's own columns, left empty in the bid documents ("Unit Bid Price", "Total Bid Price", PhilGEPS 13309750)
  // ("Unit Offer Total Offer Total Amount in Words" after the ABC's Unit Cost / Total Cost, PhilGEPS 13282462)
  // The Price Schedule form's own columns, "Unit price CIF ...", "Total CIF or CIP price per item", "Unit Price
  // Delivered at Place (DAP)", "Total Price delivered DDP", "Unit price EXW per item" (the hospital's amount is its
  // "ABC per line item" column, PS 107827)
  ['bid', /^(?:(?:unit|total)\s+bid\s+(?:price|amount)|bid\s+(?:price|amount)|offered\s+(?:unit\s+)?price|(?:unit|total)\s+offer(?:ed)?(?:\s+(?:price|amount))?|(?:total\s+)?amount\s+in\s+words|bidder'?s\s+(?:unit\s+)?(?:price|offer|amount)|unit\s+price\s+(?:cif|cip|exw|fob|delivered|ddp|dap)|total\s+(?:cif|cip|exw)|total\s+price,?\s+(?:delivered|per\s+unit|exw))\b/i],
  // ("ABC Unit Price" is one column, PhilGEPS 13298236)
  ['price', /^(?:unit\s+(?:pr\.?\s+)?(?:cost|price|value)|abc\s*(?:\/|per)\s*unit|abc\s+unit\s+(?:pr\.?\s+)?(?:cost|price|value)|price\s+per\s+unit|estimated\s+unit\s+cost|cost\s+per\s+(?:unit|item)|unit\s+abc)\b/i],
  // An ABC column that doesn't say per unit or total ("ABC", "ABC per Item", "ABC Per Line Item"): hospitals put the
  // unit price in it (PS 106895) or the line's total (PhilGEPS 13300773); its table's rows decide (abcColumn)
  ['abc', /^abc(?:\s*(?:\/|per)\s*(?:line\s+)?item)?\b(?!\s+(?:total|amount)\b)/i],
  ['total', /^(?:total\s+(?:cost|price|amount|abc|value)|abc\s+(?:total|amount)|total|amount|estimated\s+(?:cost|budget)|approved\s+budget)\b/i],
  ['quantity', /^(?:quantity|qty)\b\.?/i],
  ['unit', /^(?:unit\s+of\s+(?:issue|measure(?:ment)?)|uom|u\/m|unit)\b/i],
  ['item', /^(?:item\s*(?:no\.?|#|number)|stock\s*(?:\/\s*property\s*)?(?:no\.?|number)|property\s*no\.?|no\.|item|lot\s*no\.?)/i],
  // Delivery split columns ("1st Delivery 2nd Delivery 3rd Delivery"): each holds a number or "-", never the quantity
  ['delivery', /^\d+(?:st|nd|rd|th)\s+delivery\b/i],
  ['text', /^(?:brand(?:\s+name)?|remarks?|delivery(?:\s+(?:period|schedule))?|manufacturer|country\s+of\s+origin)\b/i],
];
// Columns a header can name more than once in a row
const REPEATING = new Set(['delivery']);

/** The columns a header line names, in order, e.g. ['item', 'unit', 'description', 'quantity', 'price', 'total'];
 * null unless it names a description and a quantity */
function headerColumns(line) {
  const columns = [];
  const text = line.replace(/\s+/g, ' ').trim();
  // After the ABC's own column, a "Unit Cost" / "Total Cost" is the bidder's, left empty ("Qty Unit ABC Per Line Item
  // Unit Cost Total Cost", PS 106895)
  let abcSeen = false;
  for (let at = 0; at < text.length; ) {
    const rest = text.slice(at);
    const hit = HEADER_WORDS.find(([, re]) => re.test(rest));
    if (hit) {
      const words = hit[1].exec(rest)[0];
      const amount = hit[0] === 'price' || hit[0] === 'total' || hit[0] === 'abc';
      const key = abcSeen && amount && !/abc|budget/i.test(words) ? 'bid' : hit[0];
      if (amount && /abc|budget/i.test(words)) abcSeen = true;
      if (columns.at(-1) !== key || REPEATING.has(key)) columns.push(key);
      at += words.length;
    } else {
      const space = rest.indexOf(' ');
      at += space < 0 ? rest.length : space + 1;
    }
  }
  if (!columns.includes('description') || !columns.includes('quantity')) return null;
  // Beside a Unit Cost column the ABC one is the total, beside a Total the unit price
  return columns.includes('price') ? columns.map((c) => (c === 'abc' ? 'total' : c)) : columns.includes('total') ? columns.map((c) => (c === 'abc' ? 'price' : c)) : columns;
}

// A unit price that makes sense: ₱1 or more, up to ₱1,000 a tablet or capsule and ₱50,000 a vial, ampule, bottle
const INJECTABLE_FORM = /\b(?:vials?|amp\w*|syringes?|pfs|bottles?|btls?|bots?|inj\w*)\b/i;
const sensibleUnitPrice = (price, row) => price >= 1 && price <= (INJECTABLE_FORM.test(`${row.description} ${row.unit || ''}`) ? 50000 : 1000);

/** What a table's lone ABC column holds, 'price' or 'total', one meaning for the whole table (the user: "they are in a
 * one table"): its rows read both ways, the reading giving more sensible unit prices wins, the total when even
 * ("Divalproex ... 8,000 tablet 23.00" is ₱23 a tablet, PS 106895; "20 Liter (L) Nitrous Oxide 70% ₱207,000.00" the
 * line's total, PhilGEPS 13300773). Kept with the header, so the pages a long table goes on to read it alike. */
function abcColumn(lines, n, columns) {
  if (columns.abc) return columns.abc;
  const headers = headersOf(lines);
  const from = headers.findLast((h) => h.at < n)?.at ?? -1;
  const to = Math.min(headers.find((h) => h.at > n)?.at ?? lines.length, from + 1 + HEADER_REACH);
  const asTotal = columns.map((c) => (c === 'abc' ? 'total' : c));
  let asPrice = 0;
  let asLineTotal = 0;
  for (let k = from + 1; k < to; k++) {
    const row = byHeader(lines, k, asTotal);
    const amount = row && (row.total != null) !== (row.unit_price != null) ? row.total ?? row.unit_price : null;
    if (!amount || !row.quantity) continue;
    const price = sensibleUnitPrice(amount, row);
    const total = sensibleUnitPrice(amount / row.quantity, row);
    if (price && !total) asPrice++;
    else if (total && !price) asLineTotal++;
  }
  // No rows to judge by on this page: the total, judged again on the next page
  if (!asPrice && !asLineTotal) return 'total';
  columns.abc = asPrice > asLineTotal ? 'price' : 'total';
  return columns.abc;
}

// How far above a row its header may be, in lines (a table running down the page)
const HEADER_REACH = 120;
const headerCache = new WeakMap();

// A header broken over up to this many lines ("Item" / "No. Description Quantity Unit Unit Cost Total Cost" /
// "Delivery Schedule" / "1st Delivery 2nd Delivery 3rd Delivery")
const HEADER_LINES = 4;

// The headers on a page, [{ at: line, columns }] (cached with the page's cleaned lines)
function headersOf(lines) {
  let found = headerCache.get(lines);
  if (!found) {
    found = [];
    lines.forEach((line, i) => {
      if (found.at(-1)?.at >= i - HEADER_LINES) return;
      for (let k = 1; k <= HEADER_LINES && i + k <= lines.length; k++) {
        const end = i + k;
        let columns = headerColumns(lines.slice(i, end).join(' '));
        if (!columns) continue;
        // Starting at its own first line, not the title lines above it ("BAC No. EPA 2027-002" / "Supply and Delivery
        // of ..." / "Quantity Unit Item Description ...": no Item No. or Delivery column, PS 107166)
        let start = i;
        // A line starting with a column name is the header's own ("Item" / "Number Description Quantity ...")
        const ownLine = (line) => HEADER_WORDS.some(([, re]) => re.test(line.trim()));
        while (start < end - 1 && !ownLine(lines[start]) && headerColumns(lines.slice(start + 1, end).join(' '))) start++;
        columns = headerColumns(lines.slice(start, end).join(' '));
        // The longest reading of a header broken over lines
        let all = columns;
        for (let more = end + 1; more <= end + 2 && more <= lines.length; more++) all = headerColumns(lines.slice(start, more).join(' ')) || all;
        found.push({ at: start, columns: all });
        break;
      }
    });
    headerCache.set(lines, found);
  }
  return found;
}

/** The header of the table lines[n] is in: the nearest one above (also a header broken over lines, and the one
 * carried over from the page before when a long table goes on: carryHeader), or null */
function headerFor(lines, n) {
  return headersOf(lines).findLast((h) => h.at < n && n - h.at <= HEADER_REACH)?.columns || null;
}

// A page starting a table of its own ("Item Specification Statement of Compliance", "Item No. Item Particulars /
// Description Total Amount"): a line naming two or more column words, the item one among them
const TABLE_START = /\bitem\b.*\b(?:description|specifications?|particulars|quantity|qty|compliance)\b|\b(?:description|specifications?)\b.*\b(?:quantity|qty|compliance)\b/i;

/** A long table going on onto the next page without its header (13309076: page 70 has it, 71-72 go on): the next
 * page's rows are read by the page before's header, unless that page starts a table of its own. Returns the header
 * to carry on to the page after. */
export function carryHeader(rawLines, columns) {
  const lines = cleanLines(rawLines);
  const found = headersOf(lines);
  const ownTable = found.length || lines.some((l) => TABLE_START.test(l));
  if (columns && !ownTable) found.unshift({ at: -1, columns });
  return found.at(-1)?.columns || (ownTable ? null : columns);
}

// An amount, also with OCR's dots between thousands ("413.074.00")
const MONEY_TOKEN = /^(?:\d[\d,]*|\d{1,3}(?:[.,]\d{3})+)\.\d{2}$/;
// An amount with letters the scan put in for digits ("3IRS.000.00"): ends in .dd, mostly digits
const GARBLED_MONEY = /^(?=(?:[^\d]*\d){3})[\dA-Za-z,.]{4,}[.,]\d{2}$/;
const money = (s) =>Number(s.replace(/[.,](?=\d{3}(?:[.,]|$))/g, ''));
const COUNT_TOKEN = /^(?:\d{1,3}(?:[.,]\d{3})+|\d+)$/;
const ITEM_TOKEN = /^[A-Z]{0,4}-?\d+[.)]*$/;
const WORD_TOKEN = /^[A-Za-z][A-Za-z/.'’-]*$/;
// (also a concentration: "Rocuronium 10 mg/mL" is never 10 of unit "mg/mL", PS 101007)
const STRENGTH_TOKEN = /^(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)(?:\/[\d.]*\s*(?:ml|l|g|kg|dose|tab\w*|cap\w*))?\.?,?$/i;

/** A row read by its table's header: the columns before the description from the left, those after it from the
 * right (an empty cell is skipped: an amount can only fill a price or total, a whole number the quantity), e.g.
 * "1 btl Amoxicillin ... 60ml/Oral 22,752 78.00 1,774,656.00" under "Item No. | Unit | Item Description |
 * Quantity | Unit Cost | Total Cost". null when the page has no header or the row has no quantity this way. */
function byHeader(lines, n, given) {
  let columns = given || headerFor(lines, n);
  if (!columns) return null;
  if (columns.includes('abc')) columns = columns.map((c) => (c === 'abc' ? abcColumn(lines, n, columns) : c));
  const read = (text) => {
    // Delivery text after the numbers also when the header has no column for it ("... 138,000.00 Fifteen (15)
    // calendar days upon receipt of an advice for delivery.", PhilGEPS 13299419)
    const tokens = text.replace(DELIVERY_TAIL, '').split(/\s+/).filter(Boolean);
    const out = { written: text };
    const middle = columns.indexOf('description');
    // From the left: Item No., Unit, Quantity written before the description
    for (const key of columns.slice(0, middle)) {
      const token = tokens[0];
      if (token == null) return null;
      if (key === 'item' && ITEM_TOKEN.test(token)) out.item_no = tokens.shift().replace(/[.)]+$/, '');
      // The Item No. alone on the line above the row ("19" / "FLUOROURACIL 50mg/mL," / "10mL VIAL 200 Vial
      // 13,600.00" under "... Qty Unit of Issue Total ABC", PS 114450)
      else if (key === 'item' && LONE_NUMBER.test(lines[n - 1] || '')) out.item_no = lines[n - 1];
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
      if (key === 'bid') continue;
      if (key === 'delivery') {
        if (COUNT_TOKEN.test(token) || /^[-–—]$/.test(token)) tokens.pop();
      } else if (key === 'text') {
        // A text cell after the numbers ("Fifteen (15) calendar days" under Delivery Schedule): its words go. One
        // before them (an empty Brand column, PhilGEPS 13309750) holds the description's end, kept
        // Only after a row's amounts: a row without them on its line keeps its words ("68 Amikacin 250 mg/mL, 2 mL"
        // is not quantity 2, PhilGEPS 13292520)
        const numbersRead = out.total != null || out.unit_price != null || out.quantity != null;
        const hasAmounts = tokens.some((t) => MONEY_TOKEN.test(t));
        while (!numbersRead && hasAmounts && tokens.length && !MONEY_TOKEN.test(tokens.at(-1)) && !COUNT_TOKEN.test(tokens.at(-1))) tokens.pop();
      } else if ((key === 'total' || key === 'price') && MONEY_TOKEN.test(token)) out[key === 'total' ? 'total' : 'unit_price'] = money(tokens.pop());
      // An amount the scan garbled ("3IRS.000.00" for 385,000.00, PS 108640): its cell is set aside, the amount
      // worked out from the others
      else if ((key === 'total' || key === 'price') && GARBLED_MONEY.test(token)) tokens.pop();
      else if (key === 'quantity' && COUNT_TOKEN.test(token) && !STRENGTH_TOKEN.test(tokens.at(-2) || '')) out.quantity = num(tokens.pop().replace(/\./g, ''));
      // A Quantity cell with its unit and no Unit column ("Vial 800 vial 25,600.00" under "Description Quantity
      // Total", PhilGEPS 13292520)
      else if (key === 'quantity' && !columns.includes('unit') && WORD_TOKEN.test(token) && !STRENGTH_TOKEN.test(token) && COUNT_TOKEN.test(tokens.at(-2) || '')) {
        out.unit = tokens.pop();
        out.quantity = num(tokens.pop().replace(/\./g, ''));
      }
      else if (key === 'unit' && WORD_TOKEN.test(token) && !STRENGTH_TOKEN.test(token) && out.quantity == null) out.unit = tokens.pop();
    }
    // A header the scan read only in part (no Unit Cost column found, PS 108640 "Item Nao."): an amount left ending
    // the description is the unit cost (a description never ends in an amount)
    if (out.unit_price == null && !columns.includes('price') && MONEY_TOKEN.test(tokens.at(-1) || '')) out.unit_price = money(tokens.pop());
    // An amount still ending the description: the header (carried from another table) doesn't fit this row ("2
    // 25200000 Folic Acid, 5mg 5.00 10,000" under "Description Quantity Price Total", PhilGEPS 13311929)
    if (MONEY_TOKEN.test(tokens.at(-1) || '')) return null;
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
  // A row whose numbers come on a line of their own below it is read whole first ("30 PLAIN NSS 1 LITER" /
  // "94,920 Bottle 60.00 5,695,200.00": the "1" of 1 liter is not the quantity)
  const whole = numbersBelow(lines, n);
  if (whole) {
    const read2 = read(whole);
    if (read2) return read2;
  }
  // A Quantity-first table whose quantity and unit OCR put on the row's second or third line ("BUPIVACAINE 0.5%" /
  // "as hydrochloride 4 ml" / "6.000 amp-vial (spinal) with 8% 69.18 413.074.00", PS 107166)
  if (columns.indexOf('quantity') < columns.indexOf('description') && !COUNT_TOKEN.test(lines[n].split(' ')[0])) {
    for (let k = n + 1; k <= n + 3 && lines[k]; k++) {
      const m = /^(\d{1,3}(?:[.,]\d{3})+|\d+)\s+([A-Za-z][A-Za-z/.'’-]*)\s+(.*\d\.\d{2}\b.*)$/.exec(lines[k]);
      if (!m || STRENGTH_TOKEN.test(m[2])) continue;
      const late = read([m[1], m[2], ...lines.slice(n, k), m[3]].join(' '));
      if (late) return { ...late, written: lines.slice(n, k + 1).join(' ') };
      break;
    }
  }
  // The row on its own line, else with the lines it continues on
  const alone = read(lines[n]);
  // Not when the line's last number is a strength going on below ("... 1" / "g Vial ...")
  if (alone && !(STRENGTH_UNIT_START.test(lines[n + 1] || '') && /\s\d[\d,]*$/.test(lines[n]))) {
    // Its price on the next line, the description wrapping (PhilGEPS 13309780)
    const priced = alone.unit_price == null && alone.total == null && (columns.includes('price') || columns.includes('total')) && pricedRow(lines, n, read);
    return priced && priced.quantity === alone.quantity ? priced : alone;
  }
  const row = rowText(lines, n);
  return row === lines[n] ? null : read(row);
}

// The numbers of a row on a line of their own: "2,100 Ampule 90.00 189,000.00" (Quantity, Unit, Unit Cost,
// Total Cost after the description's lines)
// (an amount, not a strength: "14 Chlorhexidine 0.12%, 120" is the next row, PhilGEPS 13299419)
const NUMBERS_LINE = /^\d[\d,]*\s+[A-Za-z][A-Za-z/.'’-]*(?:\s+[A-Za-z][A-Za-z/.'’-]*)?\s+\d[\d,]*\.\d{2}(?![\d%])/;
// A row's quantity, unit and amount(s) inside a line, with text before or after them ("ampule 7,000 154.00
// 1,078,000.00 Fifteen (15)", "mg/mL, 2.5mL AMPULE 200 amp 18,800.00"; a third amount column: "300 vial 800.00
// 240,000.00 120,000.00", PhilGEPS 13282441); not a strength ("10 mg 5.00")
const ROW_AMOUNTS = /(?<![\d.,])\d[\d,]*(?:\s+(?!(?:mg|mcg|µg|g|gm|ml|l|iu|units?|%)\b)[A-Za-z][A-Za-z/.'’-]*)?\s+\d[\d,]*\.\d{2}(?![\d%])(?:\s+\d[\d,]*\.\d{2}){0,2}(?:\s+[A-Za-z(].*)?$/i;
// How many lines a row of a table with a header may take (a long description broken over lines)
const ROW_LINES = 12;

/** Under a header: the row from lines[n] through its numbers line below ("31 PROPOFOL 10MG/ML," / "20ML AMPULE" /
 * "2,100 Ampule 90.00 189,000.00"), stopping before the next numbered row; null when no numbers line comes */
function numbersBelow(lines, n) {
  // A row with its own numbers ends there ("19 Sevelamer ... 54,000 18.15 980,100.00" / "LOT 2 2,395,500.00", PhilGEPS
  // 13292592)
  if (NUMBERS_LINE.test(lines[n]) || ENDS_IN_NUMBERS.test(lines[n])) return null;
  const parts = [lines[n]];
  // The next row's own line, starting with the number after this row's ("10 CalciumCarbonate 6.00 30,000 ..." after
  // "9 Bupivacaine ...", PS 94918), is never this row's numbers line
  const rowNo = leadingNumber(lines[n]);
  // (also with marks before its name: "18 **Butamirate Citrate 50mg tab ...", PhilGEPS 13269780)
  const nextRow = rowNo == null ? null : new RegExp(String.raw`^${rowNo + 1}[.)]?\s+[*•·"'(]{0,3}[A-Za-z]{4,}`);
  for (const next of lines.slice(n + 1, n + ROW_LINES)) {
    // The next row's number alone on its line ("... 2.5mL AMPULE 200 amp 18,800.00" / "2" / "BUPIVACAINE ...", PS 114476)
    // (a lot's heading here; other form lines after the numbers test: a row's numbers may follow its bidder field,
    // "CPR & COD 15,000 pcs 158.00", PS 106895)
    if (!next || nextRow?.test(next) || (rowNo != null && LONE_NUMBER.test(next) && Number(next) === rowNo + 1) || LOT_HEADING.test(next)) break;
    // Its numbers starting with the unit or ending the description's last line, delivery text after them ("ampule
    // 7,000 154.00 1,078,000.00 Fifteen", PhilGEPS 13312124; "800mg TABLET 10,000 Tab 140,000.00", PS 114538)
    if (NUMBERS_LINE.test(next) || ROW_AMOUNTS.test(next) || (SPLIT_UNIT_END.test(parts.join(' ')) && UNIT_AMOUNTS_LINE.test(next))) return [...parts, next].join(' ');
    // The next numbered row ("49 IMATINIB ..."), not a strength going on ("100 mg tablet")
    if (/^\d{1,4}[.)]?\s+(?!(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)\b)[A-Za-z]/i.test(next) || FORM_TEXT.test(next)) break;
    parts.push(next);
  }
  return null;
}

// "<qty> <unit>" alone on a line: the Quantity and Unit columns of the row below it (not a strength: "500 mg")
const QTY_UNIT_LINE = /^(\d[\d,]*)\s+(?!(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|meq|mmol|%)\.?$)([A-Za-z][A-Za-z/.'’]*(?:\s+syringes?)?)$/i;
const MONEY_END = /(?<![\d.,])(\d[\d,]*\.\d{2})$/;

/** A row read without a quantity whose line above is only "<qty> <unit>": QUANTITY | UNIT | DESCRIPTION | ABC/unit
 * forms whose text layer puts the quantity first, then the description, then the ABC/unit ("200 PFS" /
 * "Filgrastim 300 mcg/0.5 mL solution for injection" / "in pre-filled syringe (IV, SC) 1,500.00", PhilGEPS
 * 13298769). The unit price is the amount ending this line or one of the next two, before the next row. */
function quantityAbove(lines, n, parsed) {
  const above = QTY_UNIT_LINE.exec(lines[n - 1] || '');
  // "<Item No.> <Unit>" above a row ending in "<qty> <unit price>": the row's start broken onto the line above
  // ("1 Ampule" / "or Vial Rocuronium Br 10Mg/Ml-5Ml Iv 180 99.78", PhilGEPS 13303642)
  const ends = /(?<![\d.,])(\d[\d,]*)\s+(\d[\d,]*\.\d{2})$/.exec(lines[n]);
  if (above && ends && parsed.item_no == null && /^[a-z]/.test(lines[n])) return { ...parsed, item_no: above[1], unit: above[2], quantity: num(ends[1]), unit_price: num(ends[2]), total: undefined };
  if (parsed.quantity != null || !above) return parsed;
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

/** The row of lines[n] read with the lines it continues on (rowText) when that gives it a price or total, else null */
function pricedRow(lines, n, readText) {
  const row = rowText(lines, n);
  if (row === lines[n]) return null;
  const read = readText(row);
  return read && (read.unit_price != null || read.total != null) ? { ...read, written: row } : null;
}

function readRow(lines, n) {
  const own = { ...parseItemLine(lines[n]), written: lines[n] };
  if (own.unit_price != null) {
    // Its unit and total on the next line ("... 5.00 10,000" / "tablet/capsule 50,000.00", PhilGEPS 13311929)
    const withTotal = own.total == null && own.quantity != null && pricedRow(lines, n, (row) => parseItemLine(row));
    return withTotal && withTotal.quantity === own.quantity && withTotal.total != null ? withTotal : own;
  }
  // A row with its quantity whose description wraps and whose price ends the next line ("48 200 Vial Heparin
  // ... Solution for Injection" / "(IV/SC), 5mL Vial 316.80", PhilGEPS 13309780): read with that line
  const priced = own.quantity != null && own.total == null && pricedRow(lines, n, (row) => parseItemLine(row));
  if (priced && priced.quantity === own.quantity) return priced;
  // "<row no.> <unit> <description> <qty>": its own reading takes the row number as the quantity
  if (!ROW_NO_UNIT.test(lines[n]) && (own.quantity != null || ENDS_IN_NUMBER.test(lines[n]))) return own;
  const row = rowText(lines, n);
  const whole = row === lines[n] ? {} : { ...parseItemLine(row), written: row };
  return whole.quantity != null ? whole : own;
}

/** "<description> <quantity> [unit] <amount>" with no quantity read otherwise ("68 Cefazolin sodium 1 g Vial 70
 * 10,500.00", "18 Cetirizine 10mg tablet 3000 pcs 2,100.00", "1 Amikacin ... 2ml 100 vial 215.00"): the whole number
 * before the amount (and its unit) is the quantity; the amount is the total or the unit price (TOTAL_AT_LEAST) */
function oneAmount(line, parsed) {
  if (parsed.quantity != null) return parsed;
  const m = /^(.*[A-Za-z].*?)\s+(\d{1,3}(?:,\d{3})+|\d+)(?:\s+([A-Za-z][A-Za-z/.'’-]*))?\s+(\d[\d,]*\.\d{2})$/.exec(line);
  if (!m) return parsed;
  const [, before, qtyText, unit, amountText] = m;
  // Not a strength ("... 500 mg 200.00") nor a number glued to the description's last word
  if (unit && /^(?:mg|mcg|g|gm|ml|l|iu|units?|%)\.?$/i.test(unit)) return parsed;
  const quantity = num(qtyText);
  const amount = num(amountText);
  if (!quantity) return parsed;
  // Tablets, capsules, pieces cost little each: a large amount coming to ₱100 or less each is their total. Vials,
  // ampules, syringes, bottles: the amount is the unit price (Sugammadex "40 vial 5,818.00") unless it can't be
  const cheap = !INJECTABLE_FORM.test(`${before} ${unit || ''}`);
  const isTotal = amount > LARGE_AMOUNT || (cheap && amount >= TOTAL_AT_LEAST && amount / quantity >= TOTAL_PER_UNIT_AT_LEAST && amount / quantity <= CHEAP_UNIT_PRICE_UP_TO);
  const item = /^(\d{1,4}(?:\.\d{1,2})?)[.)]?\s+/.exec(before);
  return {
    ...parsed,
    ...(item && { item_no: item[1] }),
    description: item ? before.slice(item[0].length) : before,
    quantity,
    ...(unit && { unit }),
    ...(isTotal ? { total: amount } : { unit_price: amount }),
  };
}

// A heading or place in capitals after a row's last amount ("... 2,150.00 ANTIBACTERIALS", "... 1,038.00 LOT 3: ORAL
// MEDICINES: TABLETS/CAPSULES", "... 2,000.00 GSO WAREHOUSE /"; PS 106978, PhilGEPS 13299861, 13298409)
const HEADING_TAIL = /(\d\.\d{2})\s+[A-Z][A-Z0-9 :;&,/()'.-]{4,}$/;

export function parseItemLine(fullLine) {
  const line = fullLine.replace(DELIVERY_TAIL, '').replace(HEADING_TAIL, '$1');
  // A third amount column after Unit Price and Total ("400 ampule / vial 72.00 28,800.00 14,400.00", PhilGEPS
  // 13282441): read without it when the quantity, unit price and total add up
  const third = /^(.*\s\d[\d,]*\.\d{2}\s+\d[\d,]*\.\d{2})\s+\d[\d,]*\.\d{2}$/.exec(line);
  if (third) {
    const two = parseItemLine(third[1]);
    if (two.unit_price != null && adds(two.quantity, two.unit_price, two.total)) return two;
  }
  const parsed = parseItemColumns(line);
  // A priced row is taken as is when its quantity × unit price gives its total (a row whose own numbers
  // never add up keeps these columns)
  if (parsed.unit_price != null && adds(parsed.quantity, parsed.unit_price, parsed.total)) return parsed;
  // Any other layout ending in "<unit price> <total>": the quantity is the number that times the unit price
  // gives the total, the one nearest the price when several do, e.g. "500 TABLET Amlodipine 5 mg Tablet 2
  // 1,000.00", or "55100000 vial Vancomycin ..., 1gram 3000 450.00 1,350,000.00" (55100000 is a stock number)
  const tail = /^(.*\S)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})$/.exec(line);
  if (!tail) return oneAmount(line, priceBeforeQuantity(line, parsed));
  const [, rest, priceText, totalText] = tail;
  // "... <unit price> <quantity> <total>" ("9 Bupivacaine 0.5%, 5ml Solution for 350.00 2,000 700,000.00", PS 94918):
  // a whole number between two amounts is the quantity
  if (!priceText.includes('.') && /\d\.\d{2}$/.test(rest)) {
    const swapped = priceBeforeQuantity(line, parsed);
    if (swapped.quantity === num(priceText)) return swapped;
  }
  const total = num(totalText);
  // A scan that dropped the unit price's decimal point ("5 vial 75000 3,750.00" for 750.00, "660 vial 171200
  // 1,129,920.00" for 1,712.00, PS 114413): the quantity before it times the price read with its point gives the
  // total to the centavo
  const pointless = !priceText.includes('.') && new RegExp(`(?<![\\d.,])(\\d[\\d,]*)(?:\\s+${KNOWN_UNIT_RE})?$`, 'i').exec(rest);
  if (pointless && Math.abs(num(pointless[1]) * (num(priceText) / 100) - total) < 0.005 && num(pointless[1]) > 0) {
    const before = rest.slice(0, pointless.index).trim();
    const item = /^(\d{1,4}(?:\.\d{1,2})?)[.)]?\s+/.exec(before);
    const unit = new RegExp(`(${KNOWN_UNIT_RE})$`, 'i').exec(rest)?.[1];
    return { ...(item && { item_no: item[1] }), description: item ? before.slice(item[0].length) : before, quantity: num(pointless[1]), ...(unit && { unit }), unit_price: num(priceText) / 100, total };
  }
  const unitPrice = num(priceText);
  const quantity = (rest.match(/\d[\d,]*/g) || []).map(num).findLast((q) => adds(q, unitPrice, total));
  if (quantity == null) {
    // "<description> <quantity> <unit price> <total>" whose numbers don't multiply out (a total over 12 months:
    // "33.01 Amikacin sulfate 250mg/ml, 2ml ampule 2,000 235.00 5,640,000.00", Philippine Heart Center): the
    // whole number right before the unit price is the quantity
    const before = parsed.quantity == null && /^(.*[A-Za-z].*?)\s+(\d[\d,]*)$/.exec(rest);
    if (!before || STRENGTH_UNIT_START.test(priceText)) return oneAmount(line, parsed);
    const item = /^(\d{1,4}(?:\.\d{1,2})?)[.)]?\s+/.exec(before[1]);
    const description = item ? before[1].slice(item[0].length) : before[1];
    const unit = /([A-Za-z]+)$/.exec(description)?.[1];
    return { ...parsed, ...(item && { item_no: item[1] }), description, quantity: num(before[2]), ...(unit && KNOWN_UNIT_WORD.test(unit) && { unit }), unit_price: unitPrice, total };
  }
  // "<stock no.> <unit> <description> <quantity>" (PhilGEPS RFQ tables: Stock/Property No. | Unit | Description | Qty)
  const stock = /^(\S*\d\S*)\s+([A-Za-z][A-Za-z.'’]*)\s+(.+?)\s+([\d,]+)$/.exec(rest);
  if (stock && num(stock[4]) === quantity) {
    // Only a real unit word is the unit ("13 Cetirizine 10 mg Tablet tablet 15,000 ...": Cetirizine is the product)
    if (KNOWN_UNIT_WORD.test(stock[2])) return { item_no: stock[1], unit: stock[2], description: stock[3], quantity, unit_price: unitPrice, total };
    const unit = new RegExp(`(${KNOWN_UNIT_RE})$`, 'i').exec(stock[3])?.[1];
    return { item_no: stock[1], ...(unit && { unit }), description: `${stock[2]} ${stock[3]}`, quantity, unit_price: unitPrice, total };
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
    const m = [...end[1].matchAll(/(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d.,])(?:\s+([A-Za-z][A-Za-z/-]*(?:\s+syringes?)?))?/g)].findLast((x) => adds(whole(x[1]), unitPrice, total));
    if (!m) continue;
    // The name is what comes before the unit price, without the Item No. and Stock No. ("1 23800000 FILGRASTIM 300
    // mcg/ 0.5 ml 1,225.00 259 pre-filled syringes 317,275.00", PhilGEPS 13311841)
    const at = end[1].lastIndexOf(end[1].match(/\d[\d,]*\.\d{2}/g).find((p) => num(p) === unitPrice), m.index);
    const name = at > 0 && at < m.index ? end[1].slice(0, at).trim().replace(/^\d{1,4}[.)]?\s+(?:\d{6,}\s+)?/, '') : null;
    return { ...parsed, ...(name && /[A-Za-z]/.test(name) && { description: name }), quantity: whole(m[1]), unit: m[2] || parsed.unit, unit_price: unitPrice, total };
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
  // (also a two-part unit: "97.00 4,800 ampule/vial", "1,225.00 259 pre-filled syringe", PhilGEPS 13311929, 13311841;
  // the Stock No. after the Item No. is not part of the name: "1 3100000 Amikacin Sulfate, ...")
  const priceQty = new RegExp(`^${ITEM}\\s+(.+?)\\s+${PRICE}\\s+${COUNT}\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}(?:[/-][A-Za-z]{1,12})*\\.?(?:\\s+syringes?)?)$`, 'i').exec(line);
  if (priceQty) return { item_no: priceQty[1], description: priceQty[2].replace(/^\d{6,}\s+/, ''), unit_price: num(priceQty[3]), quantity: count(priceQty[4]), unit: priceQty[5] };
  // The same with its unit on the next line ("2 25200000 Folic Acid, 5mg 5.00 10,000" / "tablet/capsule 50,000.00"):
  // the Stock No. is never the quantity
  const stockPriceQty = new RegExp(`^${ITEM}\\s+\\d{6,}\\s+(.*[A-Za-z].*?)\\s+${PRICE}\\s+${COUNT}$`, 'i').exec(line);
  if (stockPriceQty) return { item_no: stockPriceQty[1], description: stockPriceQty[2], unit_price: num(stockPriceQty[3]), quantity: count(stockPriceQty[4]) };
  // Item | ABC Total | Description | Quantity | Unit: "1 650,000.00 Idarubicin (as hydrochloride) powder, 5 mg vial 100 vial"
  const totalFirst = new RegExp(`^${ITEM}\\s+${PRICE}\\s+(.*[A-Za-z].*?)\\s+${COUNT}\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (totalFirst) return { item_no: totalFirst[1], total: num(totalFirst[2]), description: totalFirst[3], quantity: count(totalFirst[4]), unit: totalFirst[5] };
  // Item | Quantity | Unit | Description, e.g. "21. 5000 TAB LOSARTAN 100 MG"
  const qtyFirst = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+)$`).exec(line);
  if (qtyFirst) {
    // The row's amount after the description ("20 2000 Box Cetirizine ... Box of 100's 1,125.00", PhilGEPS 13309750):
    // the unit price, or the total when large on a sizeable quantity
    const [, item, qtyText, unit, rest] = qtyFirst;
    const quantity = num(qtyText);
    // Item | Qty | Unit | ABC | Description: the amount before the description is the row's ("42 30,000 tablet
    // 555,000.00 Capecitabine 500 mg Tablet", "17 400 vial 23,400.00 Cefepime ...", PhilGEPS 13296270, 13295470,
    // 13298283): the line's total unless only the unit price makes sense (a description never starts with an amount)
    const lead = /^(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?![\d%])\s+(?!(?:mg|mcg|g|gm|ml|l|iu|%)\b)(.*[A-Za-z].*)$/i.exec(rest);
    if (lead && quantity > 0) {
      const amount = num(lead[1]);
      const row = { description: lead[2], unit };
      const asPrice = sensibleUnitPrice(amount, row) && !sensibleUnitPrice(amount / quantity, row);
      return { item_no: item, quantity, unit, description: lead[2], ...(asPrice ? { unit_price: amount } : { total: amount }) };
    }
    const end = /^(.*[A-Za-z].*?)\s+(\d[\d,]*\.\d{2})$/.exec(rest);
    if (!end) return { item_no: item, quantity, unit, description: rest };
    const amount = num(end[2]);
    const isTotal = amount > LARGE_AMOUNT && quantity >= SIZEABLE_QUANTITY;
    return { item_no: item, quantity, unit, description: end[1], ...(isTotal ? { total: amount } : { unit_price: amount }) };
  }
  // Item | Description | Quantity | Unit, e.g. "9 MIDAZOLAM 5MG/ML AMPULE 10’S 40 BX"
  const qtyLast = new RegExp(`^${ITEM}\\s+(.+?)\\s+(\\d[\\d,]*)\\s+(?!(?:mg|ml|mcg|g|gm|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (qtyLast) return { item_no: qtyLast[1], description: qtyLast[2], quantity: num(qtyLast[3]), unit: qtyLast[4] };
  // Item | Description | Unit | Quantity, the unit a pack: "16.Cetirizine, 10mg, tablet, 100's box 50", "74
  // Loratadine 10mg/ tab, 100's/ box box 21"
  const packQty = /^(\d{1,3})[.)]*\s*([A-Za-z].*?)\s+(box(?:es)?|bx|bottles?|btls?|bots?|vials?|amp(?:ule|oule)?s?|packs?|tubes?|sachets?|bags?)\.?\s+(\d[\d,]*)$/i.exec(line);
  if (packQty) return { item_no: packQty[1], description: packQty[2], unit: packQty[3], quantity: num(packQty[4]) };
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

// The files that hold the item table (user, 2026-10-27: "always use the tech specs and price sched")
const TABLE_FILE = /tech\w*[\s._-]*spec|price[\s._-]*sched|schedule[\s._-]*of[\s._-]*req|bill[\s._-]*of[\s._-]*quant|bid[\s._-]*form|\bsor\b/i;
const DOSE = /\d+(?:[.,]\d+)?\s*(?:(?:mg|mcg|µg|g|gm|ml|l|iu)\b|%)/i;

/** The same row read from several files (or pages): one kept, the most complete reading (quantity, then prices),
 * the Technical Specifications / Price Schedule / Schedule of Requirements first when equal (PhilGEPS 13300871,
 * 13300773, 13304186). Rows are the same when they name the same products, Item No. and strength. In place. */
export function keepBestReading(items) {
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Its Item No., else the number its row starts with (a reading that kept none: "41 Docetaxel ... 1,080 550.00
  // 594,000.00" in the Technical Specifications, PhilGEPS 13300871)
  // "Item No. 55 SEVELAMER ... Qty/Unit: 10,000 Tab" (a Technical Specifications form, PS 114538)
  const itemNoOf = (i) => i.item_no ?? /^\W{0,2}(?:item\s*no\.?\s*)?(\d{1,4})[.)]?\s+[A-Za-z]/i.exec(i.written || i.line || '')?.[1] ?? null;
  const keyOf = (i) => (itemNoOf(i) == null ? null : `${[...i.our_products].sort().join('+')}|${itemNoOf(i)}|${flat(DOSE.exec(withOcrUnits(i.written || i.line || i.description || ""))?.[0])}`);
  const score = (i) => (i.quantity != null ? 8 : 0) + (i.unit_price != null && i.computed !== 'unit_price' ? 2 : 0) + (i.total != null && i.computed !== 'total' ? 2 : 0) + (TABLE_FILE.test(i.source || '') ? 1 : 0);
  const best = new Map();
  for (const i of items) {
    const key = keyOf(i);
    if (key && (!best.has(key) || score(i) > score(best.get(key)))) best.set(key, i);
  }
  // A delivery plan lists a share of the quantity per delivery ("80 500 Bottle ..." for 760, PhilGEPS 13300232): its
  // row goes when another file gives the same Item No. for the same products, whatever its strength reads
  const rowOf = (i) => `${[...i.our_products].sort().join('+')}|${itemNoOf(i)}`;
  const elsewhere = new Set(items.filter((i) => itemNoOf(i) != null && !DELIVERY_FILE.test(i.source || '')).map(rowOf));
  for (let k = items.length - 1; k >= 0; k--) {
    const key = keyOf(items[k]);
    if ((key && best.get(key) !== items[k]) || (key && DELIVERY_FILE.test(items[k].source || '') && elsewhere.has(rowOf(items[k])))) items.splice(k, 1);
  }
  // A copy of a row with no amounts (a delivery schedule, a compliance form) goes when a priced reading names the
  // same products, strength and quantity, numbered or not (user, 2026-10-28: one table can't be half filled)
  const sameRow = (i) => `${[...i.our_products].sort().join('+')}|${flat(DOSE.exec(withOcrUnits(i.written || i.line || i.description || ""))?.[0])}|${i.quantity}`;
  const priced = new Set(items.filter((i) => i.quantity != null && (i.unit_price != null || i.total != null)).map(sameRow));
  // and a priced row read twice (the Price Schedule and the delivery schedule) is kept once
  const amounts = new Set();
  for (let k = 0; k < items.length; k++) {
    const i = items[k];
    const both = `${sameRow(i)}|${i.total}`;
    if (i.quantity != null && i.unit_price == null && i.total == null && priced.has(sameRow(i))) items.splice(k--, 1);
    else if (i.quantity != null && i.total != null && amounts.has(both)) items.splice(k--, 1);
    else amounts.add(both);
  }
  return items;
}
const DELIVERY_FILE = /deliver(?:y|ies)[\s._-]*(?:plan|sched)/i;

/** The next lines of a row, where its dosage, form and "in dextrose" may go on ("65 Aztreonam" / "1 g Powder for
 * injection"; "4 BUPIVACAINE" / "HYDROCLORIDE 0.5%," / "4ML W/ 8%" / "(SENPIVAC)DEXTROSE", PS 112682), up to the next
 * row: a dosage of the next row is not this row's ("80 500 Bottle Cetirizine 2.5mg/ml, 10ml-" took the 10 mg of row
 * 81's Cetirizine, PhilGEPS 13300232) */
const ROW_AHEAD = 8;
// (any case: "Tablet Ferrous Salt ...", PhilGEPS 13284382)
const UNIT_FIRST_ROW = /^(?:[Tt]ab|[Tt]ablets?|[Cc]ap|[Cc]apsules?|[Vv]ials?|[Aa]mp\w*|[Bb]ottles?|[Bb]ox|[Pp]fs|PFS|[Ss]achets?|[Tt]ubes?)(?:\/(?:tablets?|capsules?|vials?|amp\w*))?\s+[A-Z][a-z]{3,}/;
// A line ending in a row's quantity and amount(s): "... 10ml bottle 300 72.10 21,630.00"
const ENDS_IN_NUMBERS = /\s\d[\d,]*(?:\s+[A-Za-z][A-Za-z/.'’-]*){0,2}(?:\s+\d[\d,]*\.\d{2}){1,3}\s*$/;
export function rowAhead(lines, n) {
  const ahead = [];
  // A row ending in its numbers, followed by one that does too: rows without numbers, one per line ("Cetirizine 1mg/ml
  // solution ..., 60ml bottle 1,500 73.00 109,500.00" took the 10 mg of the next row's tablet, PS 106360)
  const complete = ENDS_IN_NUMBERS.test(lines[n] || '');
  // The next row's number alone on its line, after this row's own (on the row or alone above it): "10" / "Cetirizi" /
  // "ne" / "syrup" / "288" / "11" / "Dapagli" / "flozin" / "10mg" - the 10 mg is row 11's (PhilGEPS 13305194)
  const own = leadingNumber(lines[n]) ?? (LONE_NUMBER.test(lines[n - 1] || '') ? Number(lines[n - 1]) : null);
  for (const next of lines.slice(n + 1, n + 1 + ROW_AHEAD)) {
    // (also a row starting with its unit: "tablet Ferrous Salt ..." / "tablet/capsule Folic Acid 5mg", PhilGEPS 13286049)
    if (!next || ROW_START.test(withoutRules(next)) || FORM_TEXT.test(next) || UNIT_FIRST_ROW.test(next)) break;
    if (complete && ENDS_IN_NUMBERS.test(next) && /[A-Za-z]{4,}/.test(next)) break;
    if (own != null && LONE_NUMBER.test(next) && Number(next) === own + 1) break;
    ahead.push(next);
  }
  return ahead.join('\n');
}

/** A line read as a table's row: with its quantity, or numbered as a table's rows are (its Item No. on it, the
 * rows around it numbered in order, or its number alone on the line above) */
export function isTableRow(lines, n, row) {
  return row.quantity != null || row.item_no != null || itemNumberOf(lines, n) != null || /^\W{0,2}\d{1,4}[.)]*\s+[A-Za-z]/.test(lines[n]) || LONE_NUMBER.test(lines[n - 1] || '');
}

/** The same product listed again without a quantity (the Technical Specifications, a bid form, a line of a row
 * read with that row): dropped when a row of it with a quantity was read and names the same Item No., or one
 * holds the other's text ("Rocuronium bromide 10mg/ml, 5ml" in "54 Rocuronium bromide 10mg/ml, 5ml vial 200
 * 70,000.00"). In place. */
export function dropRepeatedRows(items) {
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const withQty = items.filter((i) => i.quantity != null);
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k];
    if (item.quantity != null) continue;
    const text = flat(item.written || item.line);
    const repeated = withQty.some(
      (q) =>
        q.our_products.some((p) => item.our_products.includes(p)) &&
        ((item.item_no != null && String(q.item_no) === String(item.item_no)) || (text.length > 8 && (flat(q.written || q.line).includes(text) || text.includes(flat(q.description))))),
    );
    if (repeated) items.splice(k, 1);
  }
  return items;
}

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

// A file download tried again after a dropped connection ("fetch failed"), so a brief network blip doesn't leave a
// tender unread until the next run
const DOWNLOAD_TRIES = 3;
async function downloadWithRetry(supabase, bucket, path) {
  let result;
  for (let attempt = 1; attempt <= DOWNLOAD_TRIES; attempt++) {
    result = await supabase.storage.from(bucket).download(path);
    if (!result.error || !/fetch failed|network|timed? ?out|ECONN|ETIMEDOUT/i.test(result.error.message || '')) return result;
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  return result;
}

/** For checking the readings (tools, never the Syncs): a file's pages as readDocuments reads them (text layer,
 * scanned pages from the OCR cache only — nothing new is read or saved), each page's lines, and per line the two
 * readings before the Quantity column: { pages: [{ lines, quantities }] } */
export async function documentPages(supabase, bucket, doc) {
  const { data: blob, error } = await downloadWithRetry(supabase, bucket, doc.path);
  if (error) throw new Error(`${doc.name}: ${error.message}`);
  let { pages, pdf } = await fileText(doc.name, new Uint8Array(await blob.arrayBuffer()));
  if (pdf) ({ pages } = await withOcr({ storage: { from: (b) => ({ download: (p) => supabase.storage.from(b).download(p), upload: async () => ({}) }) } }, bucket, doc, pdf, pages, 0));
  return { pages: pages.map(quantityColumnOf).map(({ text, quantities }) => ({ lines: text.split('\n').map(clean), quantities })) };
}

/** The two readings of a row, for checking: by its table's header (null without one) and by the row rules */
export function rowReadings(rawLines, n) {
  const lines = cleanLines(rawLines);
  return { byHeader: byHeader(lines, n), byRows: quantityAbove(lines, n, rowColumns(lines, n)) };
}

// Reads a tender's files ([{ name, path }] in Storage bucket `bucket`; also used by the PhilGEPS Sync,
// philgepsSync.mjs) for our products and the bid data sheet. Returns { status: done | skipped, read,
// result: { bid_data_sheet, items }, error }. A file that can't be opened is listed as "unreadable".
// ocrUntil: time (ms) when OCR of scanned pages stops; when it stops before every scanned page is read, this
// throws (the pages read so far are kept), so the caller reads the tender again on its next run.
export async function readDocuments(supabase, bucket, documents, matchProducts, { ocrUntil = Date.now() + OCR_MAX_MS } = {}) {
  const items = [];
  // Lines naming our products outside any table: kept for checking, never shown (isTableRow)
  const outside = [];
  // Rows whose whole reading isn't ours (another form or strength): "product|Item No.", so their copies in other
  // files (a Technical Specifications line with no form) go too
  const rejected = new Set();
  // A Schedule of Requirements asking for the whole as one package or lot ("1 Package Drugs and Medicines 1"):
  // the tender isn't ours to bid on (lib/packageTender.js)
  let isPackage = false;
  const seen = new Set();
  // Priced rows naming our molecule without any strength, by Item No. (paired after reading)
  const undosed = [];
  const read = [];
  const texts = [];
  for (const doc of documents || []) {
    if (!doc.path || !READABLE.test(doc.name)) {
      if (doc.path) read.push({ name: doc.name, kind: 'unsupported' });
      continue;
    }
    const { data: blob, error } = await downloadWithRetry(supabase, bucket, doc.path);
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
    // A long table's header carried on to the pages it goes on to (carryHeader)
    let carried = null;
    marked.forEach(({ text: page, quantities: column }, i) => {
      const raw = page.split('\n').map(clean);
      if ((/schedule\s+of\s+requirements/i.test(page) && raw.some((l) => PACKAGE_ROW.test(l))) || lotSchedule(raw)) isPackage = true;
      const lines = expandVariants(raw);
      carried = carryHeader(lines, carried);
      const quantities = column && columnAgrees(lines, column) ? column : null;
      // Lines already read as part of a row above (a description's second line naming the molecule again, "FOLIC
      // ACID) 5 mg capsule 430 5.00 2,150.00" under "15 CAPSULE FOLIC ACID (VITAMIN B12 AND", PS 106978)
      let coveredUntil = -1;
      lines.forEach((line, n) => {
        // A molecule whose strengths follow as sub-rows: the sub-rows are the rows
        if (isVariantParent(raw, n) || n <= coveredUntil) return;
        // Our molecule on this line in one of our dosages (the dosage may be on the next two lines)
        let products = matchProducts.line(line, rowAhead(lines, n));
        if (!products.length || line.length > 400) {
          // A priced row naming our molecule with no strength at all ("5 Cetirizine, tablet 600,000" / "tablet
          // 204,000.00", PS 107269): kept aside, paired below with the same Item No.'s listing that gives our dosage
          const named = line.length <= 400 && !STRENGTH_IN_TEXT.test(line) ? matchProducts.named?.(line) || [] : [];
          if (named.length) {
            const row = withPageMeaning(lines, n, parseItemRow(lines, n));
            const itemNo = row.item_no ?? leadingNumber(line);
            if (itemNo != null && row.quantity != null && (row.unit_price != null || row.total != null) && !STRENGTH_IN_TEXT.test(row.written || line)) undosed.push({ named, item_no: String(itemNo), row, line, source: `${doc.name}, ${isPdf ? `page ${i + 1}` : 'Word/Excel file'}` });
          }
          return;
        }
        // Table rows often break over several lines ("65 Aztreonam 1 g Powder for" / "injection 50 vials ..."),
        // so keep the next two lines to show with it when the line alone has no quantity
        const context = lines.slice(n, n + 3).filter(Boolean).join(' / ');
        const row = withPageMeaning(lines, n, parseItemRow(lines, n));
        // The same reading met again (a copy of the row in another file) is read once; a copy whose first line is the
        // same but whose numbers differ is read too, keepBestReading chooses (the priced Gemcitabine row behind its
        // unpriced Schedule of Requirements copy, PhilGEPS 13300871; rows 75-77 starting alike, PhilGEPS 13282462)
        const key = [row.written || line, row.quantity, row.unit_price, row.total].join('|').toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        // The whole row read checked again, its unit column too ("44 HYDROXYUREA Oral: 500mg" / "2,400 tablet 31.00
        // ...": a tablet, not our capsule; PhilGEPS 13309534)
        if (row.written && row.written !== line) {
          const whole = new Set(matchProducts.line(row.written, rowAhead(lines, n)));
          const itemNo = row.item_no ?? leadingNumber(line);
          for (const p of products) if (!whole.has(p) && itemNo != null) rejected.add(`${p}|${itemNo}`);
          products = products.filter((p) => whole.has(p));
          if (!products.length) return;
        }
        if (row.quantity != null && row.written) {
          for (let k = n + 1; k < n + ROW_LINES && lines[k] && row.written.includes(withoutRules(lines[k])); k++) coveredUntil = k;
        }
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
        const source = `${doc.name}, ${isPdf ? `page ${i + 1}` : 'Word/Excel file'}`;
        // Only a table's rows (user, 2026-10-27: "As long as they are not in table then dont fetch them"), not
        // specifications, bullet points or terms that name our products (PS 112460)
        if (!isTableRow(lines, n, row)) {
          outside.push({ our_products: products, line, source });
          return;
        }
        items.push({ our_products: products, ...withBothAmounts(row), line, context, source });
      });
    });
  }
  // A listing of ours with its dosage but no numbers takes the numbers of the priced row with the same Item No. and
  // molecule that gives no strength of its own (one such row, the same quantity when both have one)
  for (const item of items) {
    if (item.unit_price != null || item.total != null) continue;
    const itemNo = item.item_no ?? leadingNumber(item.line);
    if (itemNo == null) continue;
    const pairs = undosed.filter((u) => u.item_no === String(itemNo) && u.named.some((p) => item.our_products.includes(p)) && (item.quantity == null || item.quantity === u.row.quantity));
    if (pairs.length !== 1) continue;
    const { row, source } = pairs[0];
    Object.assign(item, withBothAmounts({ ...row, description: item.description || row.description }), { source, paired_with: item.source });
  }
  dropRepeatedRows(items);
  keepBestReading(items);
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k];
    const itemNo = i.item_no ?? leadingNumber(i.written || i.line);
    if (i.quantity == null && itemNo != null && i.our_products.every((p) => rejected.has(`${p}|${itemNo}`))) items.splice(k, 1);
  }
  if (!read.some((d) => d.kind !== 'unsupported')) return { status: 'skipped', read, error: 'No PDF, Word or Excel documents.' };
  if (!texts.length) return { status: 'skipped', read, error: 'No readable text (scanned or damaged documents).' };
  return {
    status: 'done',
    read,
    result: { bid_data_sheet: readBidDataSheet(clean(texts.join('\n'))), items, outside_table: outside.slice(0, 100), ...(isPackage && { package: true }) },
  };
}

/** A table without a header whose rows give one amount after the quantity ("Amiodarone, 150mg/3ml ampule 104
 * 34,008.00", "101 Cetirizine, 10mg tablet 9014 288,448.00", PS 107827): one meaning for the page's rows, 'price' or
 * 'total', by the rows whose amount makes sense only one way (the unit price of 9,014 tablets is not ₱288,448);
 * null when fewer than three rows decide or they split evenly */
const amountMeaningCache = new WeakMap();
const AMOUNT_VOTES_NEEDED = 3;
export function pageAmountMeaning(lines) {
  if (amountMeaningCache.has(lines)) return amountMeaningCache.get(lines);
  let asPrice = 0;
  let asTotal = 0;
  // Whole rows, also those broken over lines ("314 Ondansetron," / "2mg/ml(4mg/ml) 114 21,090.00")
  for (const [n, line] of lines.entries()) {
    if (leadingNumber(line) == null && !/\d\.\d{2}$/.test(line)) continue;
    const row = parseItemRow(lines, n);
    if (!row.quantity || (row.unit_price != null) === (row.total != null)) continue;
    const amount = row.unit_price ?? row.total;
    const price = sensibleUnitPrice(amount, row);
    const total = sensibleUnitPrice(amount / row.quantity, row);
    if (price && !total) asPrice++;
    else if (total && !price) asTotal++;
  }
  const meaning = asPrice + asTotal < AMOUNT_VOTES_NEEDED || asPrice === asTotal ? null : asPrice > asTotal ? 'price' : 'total';
  amountMeaningCache.set(lines, meaning);
  return meaning;
}
/** The row's one amount read by its page's meaning (pageAmountMeaning), unless a header names both amount columns: no
 * header, one naming only the bidder's columns ("Price Schedule for Goods" whose "ABC per line item" is printed far
 * below, PS 107827), or one naming a single amount column the page's rows contradict (a Schedule of Requirements'
 * "Quantity | Total" carried onto a list of unit prices, "Erythromycin 500 mg Tablet Tab 1200 7.38", PhilGEPS
 * 13286557) */
export function withPageMeaning(lines, n, row) {
  if (!row.quantity || (row.unit_price != null) === (row.total != null)) return row;
  const columns = headerFor(cleanLines(lines), n) || [];
  if (columns.includes('price') && (columns.includes('total') || columns.includes('abc'))) return row;
  if (columns.includes('abc')) return row;
  const meaning = pageAmountMeaning(lines);
  if (meaning === 'total' && row.unit_price != null) {
    const { unit_price: amount, ...rest } = row;
    return { ...rest, total: amount };
  }
  if (meaning === 'price' && row.total != null) {
    const { total: amount, ...rest } = row;
    return { ...rest, unit_price: amount };
  }
  return row;
}

// A strength written in a text ("10mg", "2.5 mg/ml", "0.5%", "1000 IU")
const STRENGTH_IN_TEXT = /\d\s*(?:mg|mcg|µg|g|gm|grams?|ml|l|iu|units?|%)(?![A-Za-z])/i;

// The whole tender bought as one in its Schedule of Requirements' Quantity column: "Supply and Delivery of Drugs and
// Medicines 1 lot (160 items only)" (PhilGEPS 13307875), "258 PACK CESAREAN PACK 1 LOT" (PhilGEPS 13270736), "1 package
// Pharmaceutical Supplies 15,832,478.00" (PhilGEPS 13274749). Only below the schedule's own heading: the Bid Data
// Sheet's "number of lot(s): 1 lot" or "single lot" is said of itemised tenders too (PS 97220, PhilGEPS 13296270)
const LOT_QUANTITY = /(?<![\d.,])\b1\s+(?:lots?|packages?|lump[\s-]*sum)\b/i;
const SCHEDULE_HEADING = /schedule\s+of\s+requirements/i;
const SCHEDULE_REACH = 40;
// A price list headed by the whole tender as one lot with its budget ("1 LOT VARIOUS DRUG AND MEDICINES 6,282,909.00",
// ending "Per Lot Basis Total: Php6,282,909.00"; ceiling prices only, no quantities, PhilGEPS 13299815)
const LOT_TOTAL_ROW = /^\W{0,2}1[.)]?\s+(?:lots?|packages?|lump[\s-]*sum)\s+(?=.*\b(?:drugs?|medicines?|supplies|pharmaceutical)\b)[A-Za-z].*?\s\d[\d,]*\.\d{2}$/i;
export function lotSchedule(lines) {
  if (lines.some((line) => LOT_TOTAL_ROW.test(line.trim()))) return true;
  let heading = -Infinity;
  return lines.some((line, n) => {
    // Not a table of contents' entry ("Section VI. Schedule of Requirements ....... 67")
    if (SCHEDULE_HEADING.test(line) && !/\.{4,}|…/.test(line)) heading = n;
    return n - heading <= SCHEDULE_REACH && LOT_QUANTITY.test(line) && !/number\s+of\s+lots?|lot\s*no\b|single\s+lot/i.test(line);
  });
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
  // Screened tenders first (user, 2026-10-27): the ones the team bids on
  const { data: screened } = await supabase.from('screened_tenders').select('ref').eq('source', 'ps');
  const isScreened = new Set((screened || []).map((s) => String(s.ref)));
  const queue = Object.entries(snap?.notices || {})
    .filter(([ref, n]) => (!only || only.includes(ref)) && n.documents?.some((d) => d.path))
    .filter(([ref, n]) => known.get(ref)?.documents_key !== documentsKey(n, matchProducts.key) || ocrPending(known.get(ref).documents_read))
    // Screened tenders first, then those that mention our products
    .sort(([refA, a], [refB, b]) => Number(isScreened.has(refB)) - Number(isScreened.has(refA)) || (b.matched?.length || 0) - (a.matched?.length || 0));

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
