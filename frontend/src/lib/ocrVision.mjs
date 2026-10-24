import { extractText, getDocumentProxy } from 'unpdf';
import { OCR_VERSION } from './ocr.mjs';
import { rereadTender, saveOcrStatus, scannedWaiting } from './ocrQueue.mjs';

// Layer 2 of reading scanned documents: Google Cloud Vision, run on the deployed server after each keep-alive
// call (the reading happens at Google, so it costs the server almost no computing time). It takes:
// - documents still waiting for OCR after WAIT_MS (layer 1, the hourly GitHub job, isn't keeping up or stopped),
// - documents tesseract already read without finding text (poor scans; Vision reads those far better).
// It writes the text into the same OCR cache psDocs.mjs reads (_ocr/<path>.json in the document's bucket,
// engine "vision", never tried twice) and has the tender read again. Needs GOOGLE_VISION_API_KEY (a Google
// Cloud API key restricted to the Cloud Vision API); without it this does nothing.
// Never costs money: at most VISION_MONTHLY_PAGES pages a month (Google's free amount is 1,000), counted in
// ocr_status.vision_pages; a document that would go over the limit waits for next month.

const VISION_URL = 'https://vision.googleapis.com/v1/files:annotate';
export const VISION_MONTHLY_PAGES = Number(process.env.VISION_MONTHLY_PAGES || 900);
const WAIT_MS = 6 * 60 * 60 * 1000;
const PAGES_PER_REQUEST = 5; // the API's limit for a PDF sent inline
const MAX_PAGES = 40; // same as layer 1 (psDocs.mjs OCR_MAX_PAGES)
const MAX_BYTES = 7 * 1024 * 1024; // a bigger PDF is too large to send inline; layer 1 / a person reads it
const TEXT_PAGE_MIN_CHARS = 200; // same as psDocs.mjs
const cachePath = (doc) => `_ocr/${doc.path}.json`;
const letterCount = (text) => (text || '').replace(/\s/g, '').length;
const month = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7); // Philippine month

async function readCache(supabase, bucket, doc) {
  const { data: blob } = await supabase.storage.from(bucket).download(cachePath(doc));
  if (!blob) return null;
  try {
    const saved = JSON.parse(await blob.text());
    return saved.version === OCR_VERSION && saved.size === doc.size ? saved : null;
  } catch {
    return null;
  }
}

// Text of the given pages (1-based) of a PDF, read by Vision: { [page]: text }
async function visionPages(bytes, pages, key) {
  const content = Buffer.from(bytes).toString('base64');
  const texts = {};
  for (let i = 0; i < pages.length; i += PAGES_PER_REQUEST) {
    const batch = pages.slice(i, i + PAGES_PER_REQUEST);
    const res = await fetch(`${VISION_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{ inputConfig: { content, mimeType: 'application/pdf' }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], pages: batch }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Vision: ${body.error?.message || `HTTP ${res.status}`}`);
    const answers = body.responses?.[0]?.responses || [];
    batch.forEach((page, n) => {
      const a = answers.find((x) => x.context?.pageNumber === page) || answers[n];
      if (a?.error) throw new Error(`Google Vision page ${page}: ${a.error.message}`);
      texts[page] = a?.fullTextAnnotation?.text || '';
    });
  }
  return texts;
}

// Returns { read: documents read, pages: pages sent, skipped, error }
export async function visionBackfill(supabase, { maxMs = 60000 } = {}) {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) {
    // Still keep the dashboard's waiting count fresh
    await saveOcrStatus(supabase);
    return { read: 0, pages: 0, disabled: 'GOOGLE_VISION_API_KEY is not set' };
  }
  const started = Date.now();

  const { data: status } = await supabase.from('ocr_status').select('vision_month, vision_pages').eq('id', 'latest').single();
  let used = status?.vision_month === month() ? status.vision_pages : 0;

  const due = (await scannedWaiting(supabase, { includeTried: true })).filter(
    (w) => w.tried || !w.since || Date.now() - new Date(w.since).getTime() > WAIT_MS
  );
  let read = 0;
  let sent = 0;
  let skipped = 0;
  let lastError = null;
  for (const w of due) {
    if (Date.now() - started > maxMs) break;
    if (w.doc.size > MAX_BYTES) {
      skipped++;
      continue;
    }
    const cached = await readCache(supabase, w.bucket, w.doc);
    if (cached?.engine === 'vision') continue; // Vision read it already; still no text there
    try {
      const { data: blob, error } = await supabase.storage.from(w.bucket).download(w.doc.path);
      if (error) throw new Error(error.message);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: false });
      const scannedPages = text.map((p, i) => (letterCount(p) < TEXT_PAGE_MIN_CHARS ? i + 1 : null)).filter(Boolean).slice(0, MAX_PAGES);
      if (!scannedPages.length) continue;
      if (used + scannedPages.length > VISION_MONTHLY_PAGES) {
        skipped++;
        continue;
      }
      const texts = await visionPages(bytes, scannedPages, key);
      used += scannedPages.length;
      sent += scannedPages.length;
      await supabase.storage.from(w.bucket).upload(
        cachePath(w.doc),
        JSON.stringify({ version: OCR_VERSION, size: w.doc.size, engine: 'vision', pages: { ...(cached?.pages || {}), ...texts } }),
        { contentType: 'application/json', upsert: true }
      );
      await rereadTender(supabase, w.side, w.ref);
      read++;
    } catch (e) {
      lastError = e.message;
      // A key or quota problem affects every document: stop here
      if (/API key|quota|billing|permission|disabled/i.test(e.message)) break;
    }
  }

  await saveOcrStatus(supabase, {
    vision_month: month(),
    vision_pages: used,
    ...(read || lastError
      ? {
          vision_last_run_at: new Date().toISOString(),
          vision_last_result: lastError ? `Error: ${lastError}`.slice(0, 300) : `Read ${read} document(s), ${sent} page(s)`,
        }
      : {}),
  });
  return { read, pages: sent, skipped, error: lastError };
}
