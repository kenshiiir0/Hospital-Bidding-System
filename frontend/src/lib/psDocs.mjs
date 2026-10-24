import { createClient } from '@supabase/supabase-js';
import { loadMatcher } from './products.mjs';
import JSZip from 'jszip';
import { extractText, getDocumentProxy } from 'unpdf';
import { OCR_VERSION, ocrPdfPages } from './ocr.mjs';

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

// rules-8: misspelled names ("Rocorunium", "Epoeitin"). rules-7: molecule AND dosage (lib/products.mjs; B2B price list + PRODUCT LIST). rules-6: table products. rules-4: Word and Excel files, item codes like "DM14"
const RULES_VERSION = 'rules-8';
const READABLE = /\.(pdf|docx|xlsx)$/i;
const BUCKET = 'ps-documents';
const TEXT_PAGE_MIN_CHARS = 200; // fewer letters per page than this on average = scanned
const TENDERS_AT_ONCE = 3;
const OCR_MAX_MS = 90 * 1000; // OCR time per readDocuments call when the caller gives no deadline
// OCR is heavy on CPU. On the deployed server (Vercel Hobby: 4 h of CPU a month, 98% used on 2026-10-24, mostly
// by OCR retried every 5 minutes) it runs only with the setting OCR_ON_SERVER=on; on a team computer always.
// Pages OCR'd before stay in use from the cache.
export const OCR_ENABLED = !process.env.VERCEL || process.env.OCR_ON_SERVER === 'on';
const OCR_MAX_PAGES = 40; // pages per document; a longer scan is read up to here
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

// quantity × unit price gives the total (1% for rounded prices)
const adds = (quantity, unitPrice, total) => quantity > 0 && Math.abs(quantity * unitPrice - total) <= total * 0.01;

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
  if (!tail) return parsed;
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

function parseItemColumns(line) {
  // Item numbers may carry a letter code, e.g. "DM14"
  const ITEM = String.raw`([A-Z]{0,4}-?\d+)[.)]*`;
  const UNIT = String.raw`([A-Za-z][A-Za-z.'’]*)`;
  const QTY = String.raw`([\d,]+(?:\.\d+)?)`;
  const PRICE = String.raw`([\d,]+\.\d{2})`;
  // Item | Quantity | Unit | Description | Unit Price | Total
  const priced = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+?)\\s+${PRICE}\\s+${PRICE}$`).exec(line);
  if (priced) return { item_no: priced[1], quantity: num(priced[2]), unit: priced[3], description: priced[4], unit_price: num(priced[5]), total: num(priced[6]) };
  // Item | Quantity | Unit | Description, e.g. "21. 5000 TAB LOSARTAN 100 MG"
  const qtyFirst = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+)$`).exec(line);
  if (qtyFirst) return { item_no: qtyFirst[1], quantity: num(qtyFirst[2]), unit: qtyFirst[3], description: qtyFirst[4] };
  // Item | Description | Quantity | Unit, e.g. "9 MIDAZOLAM 5MG/ML AMPULE 10’S 40 BX"
  const qtyLast = new RegExp(`^${ITEM}\\s+(.+?)\\s+([\\d,]+)\\s+(?!(?:mg|ml|mcg|g|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
  if (qtyLast) return { item_no: qtyLast[1], description: qtyLast[2], quantity: num(qtyLast[3]), unit: qtyLast[4] };
  // The remaining layouts have no fixed column order, so their unit must be a known one
  const KNOWN_UNIT = String.raw`((?:tab|tablet|cap|capsule|bottle|btl|botl|bot|vial|vl|amp|ampule|ampoule|box|bx|pc|piece|pack|sachet|tube|inhaler|nebule|syringe|bag|kit|set|unit|each|ea)(?:e?s)?\.?(?:\s?\/\s?(?:vial|amp|bottle|bot)s?)?)`;
  const descPriced = new RegExp(`^${ITEM}\\s+(.+?)\\s+${QTY}\\s+${KNOWN_UNIT}\\s+${PRICE}\\s+${PRICE}$`, 'i').exec(line);
  if (descPriced) return { item_no: descPriced[1], description: descPriced[2], quantity: num(descPriced[3]), unit: descPriced[4], unit_price: num(descPriced[5]), total: num(descPriced[6]) };
  const noItem = new RegExp(`^${QTY}\\s+${KNOWN_UNIT}\\s+(.+)$`, 'i').exec(line);
  if (noItem) return { quantity: num(noItem[1]), unit: noItem[2], description: noItem[3] };
  const descNoItem = new RegExp(`^(.*[A-Za-z].*?)\\s+([\\d,]+)\\s+${KNOWN_UNIT}$`, 'i').exec(line);
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

// Replaces the PDF's pages that have too little text with their OCR text (cached in Storage). Returns
// { pages, ocrPages: how many pages came from OCR, complete: false when time ran out first, error: OCR failed }
async function withOcr(supabase, bucket, doc, pdf, pages, until) {
  const scanned = pages.map((p, i) => (letterCount(p) < TEXT_PAGE_MIN_CHARS ? i + 1 : null)).filter(Boolean).slice(0, OCR_MAX_PAGES);
  if (!scanned.length) return { pages, ocrPages: 0, complete: true };
  let cached = {};
  const { data: blob } = await supabase.storage.from(bucket).download(ocrCachePath(doc));
  if (blob) {
    try {
      const saved = JSON.parse(await blob.text());
      if (saved.version === OCR_VERSION && saved.size === doc.size) cached = saved.pages || {};
    } catch {
      // unreadable cache: OCR again
    }
  }
  const todo = scanned.filter((n) => cached[n] == null);
  if (todo.length && !OCR_ENABLED) {
    // No new OCR here: what the cache has, and the document counts as read (no retry every few minutes)
    const merged = pages.map((p, i) => (cached[i + 1] != null && letterCount(cached[i + 1]) > letterCount(p) ? cached[i + 1] : p));
    return { pages: merged, ocrPages: scanned.filter((n) => letterCount(cached[n]) > letterCount(pages[n - 1])).length, complete: true, error: 'OCR is off on the server' };
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
  return { pages: merged, ocrPages: scanned.filter((n) => letterCount(cached[n]) > letterCount(pages[n - 1])).length, complete };
}

// Documents read before OCR, or by an older OCR, that were scanned: read them again
// (never while OCR is off here: they would be queued again every few minutes)
export const ocrPending = (read) => OCR_ENABLED && (read || []).some((d) => d.kind === 'scanned' && d.ocr !== OCR_VERSION);

// ---------- one tender ----------

// Which documents changed since the last reading (and which rules and product list read them)
export const documentsKey = (notice, listKey = '') => `${RULES_VERSION}|${listKey}|${(notice.documents || []).map((d) => `${d.path}:${d.size}`).sort().join('|')}`;

function readTender(supabase, matchProducts, notice, options) {
  return readDocuments(supabase, BUCKET, notice.documents, matchProducts, options);
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
    if (pdf) {
      const ocr = await withOcr(supabase, bucket, doc, pdf, pages, ocrUntil);
      if (!ocr.complete) throw new Error(`${doc.name}: scanned pages are still being read (OCR); the next run continues.`);
      ({ pages, ocrPages, error: ocrError } = ocr);
    }
    const letters = pages.join('').replace(/\s/g, '').length;
    if (letters / Math.max(pages.length, 1) < TEXT_PAGE_MIN_CHARS) {
      // ocr: OCR found no more text, so it isn't tried again; without it (OCR failed) the next run tries again
      read.push({ name: doc.name, kind: 'scanned', pages: pages.length, ...(pdf && (ocrError ? { ocr_error: ocrError.slice(0, 200) } : { ocr: OCR_VERSION })) });
      continue;
    }
    read.push({ name: doc.name, kind: 'text', pages: pages.length, ...(ocrPages && { ocr_pages: ocrPages }) });
    texts.push(pages.join('\n'));
    pages.forEach((page, i) => {
      const lines = page.split('\n').map(clean);
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
        items.push({ our_products: products, ...parseItemLine(line), line, context, source: `${doc.name}, ${isPdf ? `page ${i + 1}` : 'Word/Excel file'}` });
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
