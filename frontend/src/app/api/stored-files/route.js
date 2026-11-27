import fs from 'node:fs';
import { Readable } from 'node:stream';
import { requireUser } from '@/lib/auth';
import { USES_DISK } from '@/lib/db/index.mjs';
import { BUCKETS, checkLink, filePath, signLink, typeOf } from '@/lib/db/diskStorage.mjs';

// The bid documents kept on this server's disk (STORAGE_BACKEND=disk, lib/db/diskStorage.mjs), for the pages
// (lib/supabase.js with NEXT_PUBLIC_DOCUMENTS_ON_SERVER=1), the way Supabase Storage serves them:
//   POST { bucket, path, seconds?, download? }  signed-in team member -> { signedUrl } (a short-lived link)
//   GET  ?b=&p=&e=&d=&s=                          the file, when the link is signed and not expired
// The link carries its own permission because a new tab or Office opening it sends no sign-in.

const answer = (body, status = 200) => Response.json(body, { status });

export async function POST(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  if (!USES_DISK) return answer({ data: null, error: { message: 'The documents are not kept on this server.' } }, 404);
  const body = await request.json().catch(() => null);
  const bucket = body?.bucket;
  const key = body?.path;
  const download = typeof body?.download === 'string' ? body.download.slice(0, 300) : body?.download === true ? key?.split('/').pop() : '';
  if (!BUCKETS.has(bucket) || !filePath(process.env.DOCUMENTS_DIR || '/', bucket, key)) {
    return answer({ data: null, error: { message: 'Bad document path.' } }, 400);
  }
  try {
    return answer({ data: { signedUrl: signLink(bucket, key, Number(body.seconds) || 3600, download) }, error: null });
  } catch (e) {
    return answer({ data: null, error: { message: e.message } }, 500);
  }
}

export async function GET(request) {
  const root = process.env.DOCUMENTS_DIR;
  if (!USES_DISK || !root) return new Response('Not found', { status: 404 });
  const link = checkLink(new URL(request.url).searchParams);
  if (!link) return new Response('This link is not valid or has expired. Open the document again from the dashboard.', { status: 403 });
  const file = filePath(root, link.bucket, link.key);
  const stat = file && (await fs.promises.stat(file).catch(() => null));
  if (!stat?.isFile()) return new Response('Document not found', { status: 404 });
  const name = link.download || link.key.split('/').pop();
  const disposition = `${link.download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    headers: {
      'Content-Type': typeOf(link.key),
      'Content-Length': String(stat.size),
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
