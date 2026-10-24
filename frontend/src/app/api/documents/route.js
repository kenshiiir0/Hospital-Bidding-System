import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { rejectNonLocal } from '@/lib/localRequest';

// Bid documents downloaded by the scraper (documents.js) live in <repo root>/documents/<ref>/<file>;
// PS-PhilGEPS ones (ps-philgeps-sync.js, ?source=ps) in documents/ps/<ref>/<file>
const DOCS_DIR = path.resolve(process.cwd(), '..', 'documents');

const TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// GET /api/documents?ref=13299786&name=Bidding%20Documents.pdf[&source=ps]
export async function GET(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(request.url);
  const ref = searchParams.get('ref') || '';
  const name = searchParams.get('name') || '';
  // Only a plain file name inside a numeric tender folder: no way out of documents/
  if (!/^\d+$/.test(ref) || !name || name !== path.basename(name) || name.startsWith('.')) {
    return Response.json({ error: 'Invalid document' }, { status: 400 });
  }

  try {
    const base = searchParams.get('source') === 'ps' ? path.join(DOCS_DIR, 'ps') : DOCS_DIR;
    const body = await readFile(path.join(base, ref, name));
    const type = TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    // PDFs and images open in the browser; everything else downloads
    const inline = type === 'application/pdf' || type.startsWith('image/');
    return new Response(body, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch {
    return Response.json({ error: 'Document not found' }, { status: 404 });
  }
}
