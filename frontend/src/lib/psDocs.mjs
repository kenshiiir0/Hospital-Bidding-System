import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { extractText, getDocumentProxy } from 'unpdf';

// Reads each PS-PhilGEPS tender's bid documents (Storage bucket ps-documents) with free, rule-based text
// reading and stores per tender in ps_tender_analysis:
// - bid_data_sheet: the sentences giving the pre-bid conference, bid opening, submission deadline,
//   delivery period, bid validity and bid security (as written in the documents),
// - items (molecule tracker): every line that names one of our products (molecules.json), with item no.,
//   quantity, unit, unit price and total where the line's layout allows (same rules as parseItemLine in
//   scraper.js); the raw line is always kept.
// Scanned PDFs (no text layer) can't be read this way; they are listed in documents_read as "scanned".
// A tender is read again only when its documents change or RULES_VERSION changes.
// Plain .mjs (no Next imports) so it can also be run directly with node.

const RULES_VERSION = 'rules-2';
const BUCKET = 'ps-documents';
const TEXT_PAGE_MIN_CHARS = 200; // fewer letters per page than this on average = scanned
const TENDERS_AT_ONCE = 3;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------- our products (same rules as molecules.js in the repo root) ----------

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function loadMatcher() {
  // molecules.json sits in the repo root, outside what the bundler imports (as in /api/products)
  const molecules = JSON.parse(await readFile(path.resolve(process.cwd(), '..', 'molecules.json'), 'utf8'));
  const compiled = molecules.map(({ name, match }) => ({
    name,
    alternatives: match.map((alias) =>
      alias.split('+').map((part) => new RegExp(`\\b${escapeRegex(part.trim()).replace(/\s+/g, '[\\s-]+')}\\b`, 'i'))
    ),
  }));
  return (text) => (text ? compiled.filter(({ alternatives }) => alternatives.some((parts) => parts.every((re) => re.test(text)))).map(({ name }) => name) : []);
}

// ---------- item lines (ported from scraper.js parseItemLine / parseItemColumns; keep in step) ----------

const num = (s) => Number(s.replace(/,/g, ''));

function parseItemLine(line) {
  const parsed = parseItemColumns(line);
  if (parsed.unit_price != null) return parsed;
  // Any other layout ending in "<unit price> <total>": accept the pair only when a quantity in the line
  // times the unit price gives the total, e.g. "500 TABLET Amlodipine 5 mg Tablet 2 1,000.00"
  const tail = /^(.*\S)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})$/.exec(line);
  if (!tail) return parsed;
  const [, rest, priceText, totalText] = tail;
  const unitPrice = num(priceText);
  const total = num(totalText);
  const quantity = (rest.match(/\d[\d,]*/g) || []).map(num).find((q) => q > 0 && Math.abs(q * unitPrice - total) <= total * 0.01);
  if (quantity == null) return parsed;
  const base = parseItemColumns(rest);
  return { ...base, description: base.description || rest, quantity: base.quantity ?? quantity, unit_price: unitPrice, total };
}

function parseItemColumns(line) {
  const ITEM = String.raw`(\d+)[.)]*`;
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

// ---------- one tender ----------

// Which documents changed since the last reading (and which rules read them)
export const documentsKey = (notice) => `${RULES_VERSION}|${(notice.documents || []).map((d) => `${d.path}:${d.size}`).sort().join('|')}`;

async function readTender(supabase, matchProducts, notice) {
  const items = [];
  const seen = new Set();
  const read = [];
  const texts = [];
  for (const doc of notice.documents || []) {
    if (!doc.path || !/\.pdf$/i.test(doc.name)) continue;
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(doc.path);
    if (error) throw new Error(`${doc.name}: ${error.message}`);
    const pdf = await getDocumentProxy(new Uint8Array(await blob.arrayBuffer()));
    const { text: pages } = await extractText(pdf, { mergePages: false });
    const letters = pages.join('').replace(/\s/g, '').length;
    if (letters / Math.max(pages.length, 1) < TEXT_PAGE_MIN_CHARS) {
      read.push({ name: doc.name, kind: 'scanned', pages: pages.length });
      continue;
    }
    read.push({ name: doc.name, kind: 'text', pages: pages.length });
    texts.push(pages.join('\n'));
    pages.forEach((page, i) => {
      const lines = page.split('\n').map(clean);
      lines.forEach((line, n) => {
        const products = matchProducts(line);
        if (!products.length || line.length > 400) return;
        const key = line.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        // Table rows often break over several lines ("65 Aztreonam 1 g Powder for" / "injection 50 vials ..."),
        // so keep the next two lines to show with it when the line alone has no quantity
        const context = lines.slice(n, n + 3).filter(Boolean).join(' / ');
        items.push({ our_products: products, ...parseItemLine(line), line, context, source: `${doc.name}, page ${i + 1}` });
      });
    });
  }
  if (!read.length) return { status: 'skipped', read, error: 'No PDF documents.' };
  if (!texts.length) return { status: 'skipped', read, error: 'Only scanned documents (no text to read).' };
  return {
    status: 'done',
    read,
    result: { bid_data_sheet: readBidDataSheet(clean(texts.join('\n'))), items },
  };
}

// Reads the tenders whose documents are new or changed, a few at a time, until maxMs has passed.
// Returns { read, failed, left }.
export async function analyzePending({ maxMs = 200000, refs: only } = {}) {
  const started = Date.now();
  const supabase = admin();
  const matchProducts = await loadMatcher();

  const { data: snap } = await supabase.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').maybeSingle();
  const { data: done } = await supabase.from('ps_tender_analysis').select('ref, documents_key');
  const known = new Map((done || []).map((r) => [r.ref, r.documents_key]));
  const queue = Object.entries(snap?.notices || {})
    .filter(([ref, n]) => (!only || only.includes(ref)) && n.documents?.some((d) => d.path))
    .filter(([ref, n]) => known.get(ref) !== documentsKey(n))
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
        outcome = await readTender(supabase, matchProducts, notice);
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
        documents_key: outcome.status === 'failed' ? null : documentsKey(notice),
        error: outcome.error || null,
        model: RULES_VERSION,
        analyzed_at: new Date().toISOString(),
      });
    }
  };
  await Promise.all(Array.from({ length: TENDERS_AT_ONCE }, worker));
  return { read: readCount, failed, left: queue.length - next };
}
