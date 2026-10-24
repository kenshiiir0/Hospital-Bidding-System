import { createWorker } from 'tesseract.js';
import { getResolvedPDFJS, renderPageAsImage } from 'unpdf';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// OCR for scanned bid documents: a PDF page with no text layer is a picture of the page (a JPEG or a fax-style
// 1-bit image). That picture is taken out of the PDF (no browser or canvas needed) and read with tesseract.js
// (WebAssembly, so the same code runs on the deployed server and on a team computer). The English model
// ships with the app (@tesseract.js-data/eng); it is only downloaded when that copy can't be found.
// psDocs.mjs readDocuments calls ocrPdfPages for the pages that have too little text.

// ocr-2: pages without one big scanned picture (vector-outline text, small scans) are drawn and read
export const OCR_VERSION = 'ocr-2';
const LANG_DIR = '4.0.0_best_int';
const MIN_IMAGE_SIDE = 1000; // smaller pictures are logos or stamps, not a scanned page
const INK_THRESHOLD = 150; // lighter grey is paper, or text showing through from the back of the sheet
const PSM_SINGLE_COLUMN = '4';

// The model in frontend/node_modules (the server's working folder is frontend/, here and when deployed; the
// next.config.mjs tracing includes it). Not require.resolve: the bundler replaces that with a module id.
function localLangPath() {
  const dir = path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', LANG_DIR);
  return existsSync(path.join(dir, 'eng.traineddata.gz')) ? dir : null;
}

async function startWorker() {
  const local = localLangPath();
  let worker;
  if (local) {
    try {
      worker = await createWorker('eng', 1, { langPath: local, cacheMethod: 'none' });
    } catch {
      // fall back to the download below
    }
  }
  worker ||= await createWorker('eng', 1, { cachePath: tmpdir() });
  // Lines read across the whole page width: keeps an item table's row (item no. ... description ... qty) on
  // one line, where tesseract's default layout analysis splits the columns into separate blocks
  await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_COLUMN });
  return worker;
}

// The biggest picture drawn on the page, or null when there is none big enough to be the scanned page
async function pageImage(pdf, pageNumber) {
  const { OPS } = await getResolvedPDFJS();
  const page = await pdf.getPage(pageNumber);
  const ops = await page.getOperatorList();
  let best = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    let image;
    if (ops.fnArray[i] === OPS.paintImageXObject) {
      const key = ops.argsArray[i][0];
      image = await new Promise((resolve) => (key.startsWith('g_') ? page.commonObjs : page.objs).get(key, resolve));
    } else if (ops.fnArray[i] === OPS.paintInlineImageXObject) {
      image = ops.argsArray[i][0];
    }
    if (!image?.data || !image.width || !image.height) continue;
    if (!best || image.width * image.height > best.width * best.height) best = image;
  }
  return best && Math.max(best.width, best.height) >= MIN_IMAGE_SIDE ? best : null;
}

// The picture as greyscale (0 = ink, 255 = paper) at a size tesseract reads well, as a PGM file:
// - 1-bit scans (fax-style, ~200 dpi): lone specks removed, then doubled in size,
// - colour or grey scans: anything lighter than INK_THRESHOLD becomes paper.
function toPgm({ data, width, height }) {
  let gray = new Uint8Array(width * height);
  const rowBytes = Math.ceil(width / 8);
  const oneBit = data.length === rowBytes * height;
  if (oneBit) {
    let set = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      gray[y * width + x] = bit ? 255 : 0;
      set += bit;
    }
    // Mostly "ink" means the bits are the other way round
    if (set < gray.length / 2) for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
    const cleaned = gray.slice();
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (gray[i] || gray[i - 1] === 0 || gray[i + 1] === 0) continue;
      let neighbours = 0;
      for (const j of [i - width - 1, i - width, i - width + 1, i + width - 1, i + width, i + width + 1]) if (gray[j] === 0) neighbours++;
      if (!neighbours) cleaned[i] = 255;
    }
    gray = cleaned;
  } else {
    const channels = Math.round(data.length / (width * height)) || 1;
    for (let i = 0; i < gray.length; i++) {
      const p = i * channels;
      const v = channels >= 3 ? data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114 : data[p];
      gray[i] = v < INK_THRESHOLD ? 0 : 255;
    }
  }
  const scale = width < 2000 ? 2 : width > 4000 ? 0.5 : 1;
  const W = Math.round(width * scale);
  const H = Math.round(height * scale);
  let out = gray;
  if (scale !== 1) {
    out = new Uint8Array(W * H);
    for (let Y = 0; Y < H; Y++) {
      const fy = Math.min(Y / scale, height - 1.001);
      const y0 = fy | 0;
      const ay = fy - y0;
      for (let X = 0; X < W; X++) {
        const fx = Math.min(X / scale, width - 1.001);
        const x0 = fx | 0;
        const ax = fx - x0;
        const i = y0 * width + x0;
        out[Y * W + X] = (gray[i] * (1 - ax) + gray[i + 1] * ax) * (1 - ay) + (gray[i + width] * (1 - ax) + gray[i + width + 1] * ax) * ay;
      }
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), out]);
}

// Common OCR slips in dosages, so lib/products.mjs can read them: "50mgimL" / "50mg/mt" -> "50mg/mL"
const fixDosages = (text) =>
  text
    .replace(/(\d\s*(?:mg|mcg|g|iu|units?))\s*[il1|]\s*m[lLt1I]\b/gi, '$1/mL')
    .replace(/(\d\s*(?:mg|mcg|g|iu|units?)\s*\/\s*)m[t1I]\b/gi, '$1mL');

// The whole page drawn as a picture (PNG), for pages whose text is neither a text layer nor one big scanned
// picture: letters drawn as vector outlines ("print to PDF" as curves), or a scan smaller than MIN_IMAGE_SIDE.
// Needs @napi-rs/canvas, installed only where OCR runs (the GitHub OCR job, a team computer; not the deployed
// server, which doesn't OCR); null without it.
const RENDER_SCALE = 3; // ~216 dpi for an A4 / letter page
async function renderedPage(pdf, pageNumber) {
  let canvas;
  try {
    const name = '@napi-rs/canvas';
    canvas = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ name);
  } catch {
    return null;
  }
  // From the file's bytes: a document opened without a canvas can't be drawn ("not available in this environment")
  return Buffer.from(await renderPageAsImage(await pdf.getData(), pageNumber, { canvasImport: async () => canvas, scale: RENDER_SCALE }));
}

const letterCount = (text) => (text || '').replace(/\s/g, '').length;
const FEW_LETTERS = 40; // a page read from its picture with fewer letters than this is drawn and read again

// Reads the given pages (1-based) of a PDF (a pdf.js document) until `until` (a time in ms).
// Returns { texts: { [page]: text }, done: pages finished }. A page with nothing readable gives ''.
// Each page: its biggest scanned picture first; when there is none (or it gives almost no text), the whole
// page drawn as a picture.
export async function ocrPdfPages(pdf, pageNumbers, { until = Infinity, onPage } = {}) {
  const texts = {};
  let worker;
  try {
    for (const n of pageNumbers) {
      if (Date.now() >= until) break;
      // A page whose picture pdf.js can't decode counts as having none
      const image = await pageImage(pdf, n).catch(() => null);
      let text = '';
      if (image) {
        worker ||= await startWorker();
        text = (await worker.recognize(toPgm(image))).data.text || '';
      }
      if (letterCount(text) < FEW_LETTERS) {
        const drawn = await renderedPage(pdf, n).catch(() => null);
        if (drawn) {
          worker ||= await startWorker();
          const again = (await worker.recognize(drawn)).data.text || '';
          if (letterCount(again) > letterCount(text)) text = again;
        }
      }
      texts[n] = fixDosages(text);
      await onPage?.(n, texts[n]);
    }
  } finally {
    await worker?.terminate();
  }
  return { texts, done: Object.keys(texts).length };
}
