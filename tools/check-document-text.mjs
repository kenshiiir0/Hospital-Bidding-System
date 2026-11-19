// A document read once is never downloaded again (lib/psDocs.mjs savedTexts / saveTexts, 2026-11-19, Supabase
// egress): reads a made-up Word file twice through a stand-in Supabase (storage + document_text in memory) and
// checks the second reading downloads nothing and reads the same lines; a changed file (another size) is
// downloaded again. Nothing real is touched.
//   node tools/check-document-text.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const front = path.resolve('frontend');
const JSZip = createRequire(`${front}/package.json`)('jszip');
const { readDocuments } = await import(pathToFileURL(`${front}/src/lib/psDocs.mjs`).href);
const { buildMatcher } = await import(pathToFileURL(`${front}/src/lib/products.mjs`).href);

const match = buildMatcher([{ generic_name: 'Cetirizine', brand_name: 'x', dosage: '10 mg', dosage_form: 'Tablet' }]);

// A Word file with a small Schedule of Requirements table
const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const row = (...cells) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
const zip = new JSZip();
zip.file(
  'word/document.xml',
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>${"The supplier shall deliver the goods listed below to the hospital pharmacy within thirty days of the notice to proceed. ".repeat(3)}</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>Section VI. Schedule of Requirements</w:t></w:r></w:p><w:tbl>` +
    row('Item No.', 'Description', 'Quantity', 'Unit', 'ABC per Unit', 'Total ABC') +
    row('1', 'Cetirizine 10 mg tablet', '1,000', 'tablet', '2.00', '2,000.00') +
    row('2', 'Paracetamol 500 mg tablet', '500', 'tablet', '1.00', '500.00') +
    `</w:tbl></w:body></w:document>`
);
const bytes = await zip.generateAsync({ type: 'uint8array' });

let downloads = 0;
const store = new Map();
const supabase = {
  storage: { from: () => ({ download: async () => (downloads++, { data: new Blob([bytes]), error: null }) }) },
  rpc: async () => ({ data: 0, error: null }),
  from(table) {
    const q = {
      _f: {},
      select() {
        return q;
      },
      eq(k, v) {
        q._f[k] = v;
        return q;
      },
      in(k, v) {
        q._f[k] = v;
        return q;
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve) {
        const data = table === 'document_text' ? [...store.values()].filter((r) => (q._f.path || []).includes(r.path)) : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
      upsert: async (rows) => {
        if (table === 'document_text') for (const r of rows) store.set(`${r.bucket}/${r.path}`, r);
        return { error: null };
      },
    };
    return q;
  },
};

const docs = [{ name: 'Bidding Documents.docx', path: '1/bd.docx', size: bytes.length }];
const first = await readDocuments(supabase, 'ps-documents', docs, match);
const lines = (r) => r.result.items.map((i) => [i.description || i.line, i.quantity, i.unit_price, i.total].join('|'));
if (first.status !== 'done') console.log(JSON.stringify(first));
assert.equal(first.status, 'done');
assert.ok(first.result.items.length >= 1, 'the Cetirizine line is read');
assert.equal(downloads, 1);
assert.equal(store.size, 1, 'the text is saved');
console.log('  ok    first reading downloads the file once and saves its text');

const second = await readDocuments(supabase, 'ps-documents', docs, match);
assert.equal(downloads, 1, 'the second reading downloaded the file again');
assert.deepEqual(lines(second), lines(first));
assert.deepEqual(second.read, first.read);
console.log('  ok    reading again downloads nothing and reads the same lines');

await readDocuments(supabase, 'ps-documents', [{ ...docs[0], size: bytes.length + 1 }], match);
assert.equal(downloads, 2, 'a changed file (other size) must be downloaded');
console.log('  ok    a changed file is downloaded again');

const none = new Map();
store.clear();
await readDocuments(supabase, 'ps-documents', docs, buildMatcher([{ generic_name: 'Loratadine', brand_name: 'x', dosage: '10 mg' }]));
assert.equal(store.size, none.size, 'a tender with none of our products keeps no text');
console.log('  ok    a tender with none of ours keeps no text (its files are let go)');
console.log('\nDocument text check passed (4 checks).');
