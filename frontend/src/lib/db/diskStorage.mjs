import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Bid documents on the server's own disk instead of Supabase Storage (STORAGE_BACKEND=disk + DOCUMENTS_DIR, the private
// server: Coolify Persistent Storage). Answers like supabase.storage.from(bucket) for what the code uses
// (upload, download, list, remove, createSignedUrl), so Sync, reading, OCR and the clean-up don't change.
// Files are kept as <DOCUMENTS_DIR>/<bucket>/<path>, the same paths as in Storage (<ref>/<file>, _ocr/<ref>/<file>.json).
// Reading them costs no Supabase egress. The pages open them through /api/stored-files with short-lived signed
// links, like Storage's createSignedUrl.

export const BUCKETS = new Set(['ps-documents', 'philgeps-documents']);
const LINK_SECONDS_MAX = 24 * 3600;

export const TYPES = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.htm': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
};
export const typeOf = (name) => TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';

const fail = (message, statusCode = '400') => ({ data: null, error: { name: 'StorageError', message, statusCode } });

// The file's place on disk, or null for a bucket or path that could reach outside it ("..", absolute, backslashes)
export function filePath(root, bucket, key) {
  if (!BUCKETS.has(bucket) || typeof key !== 'string' || !key || key.length > 1024) return null;
  const parts = key.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) return null;
  const base = path.resolve(root, bucket);
  const full = path.resolve(base, ...parts);
  return full.startsWith(base + path.sep) ? full : null;
}

async function bytesOf(body) {
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body && typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  throw new Error('Unsupported file body');
}

// Short-lived links for the pages (no sign-in header can go with a link opened in a new tab or by Office).
// Signed with a key made from CRON_SECRET, for this purpose only.
function linkKey() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is not set: document links cannot be signed.');
  return createHash('sha256').update(`stored-files:${secret}`).digest();
}
const signature = (bucket, key, expires, download) =>
  createHmac('sha256', linkKey()).update(JSON.stringify([bucket, key, expires, download || ''])).digest('base64url');

export function signLink(bucket, key, seconds, download) {
  const expires = Math.floor(Date.now() / 1000) + Math.min(Math.max(1, Math.floor(seconds) || 3600), LINK_SECONDS_MAX);
  const q = new URLSearchParams({ b: bucket, p: key, e: String(expires) });
  if (download) q.set('d', download);
  q.set('s', signature(bucket, key, expires, download));
  return `/api/stored-files?${q}`;
}

// The link's { bucket, key, download } when its signature is right and it hasn't expired, else null
export function checkLink(params) {
  const bucket = params.get('b');
  const key = params.get('p');
  const expires = Number(params.get('e'));
  const download = params.get('d') || '';
  const given = Buffer.from(params.get('s') || '');
  if (!bucket || !key || !Number.isInteger(expires) || expires < Date.now() / 1000) return null;
  const wanted = Buffer.from(signature(bucket, key, expires, download));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return { bucket, key, download };
}

export function createDiskStorage(root) {
  const from = (bucket) => ({
    async upload(key, body, options = {}) {
      const file = filePath(root, bucket, key);
      if (!file) return fail('Invalid key');
      try {
        const bytes = await bytesOf(body);
        if (!options.upsert) {
          const exists = await fs.stat(file).then(() => true, () => false);
          if (exists) return fail('The resource already exists', '409');
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        // Written beside it and then renamed: a reader never sees half a file
        const part = `${file}.${process.pid}.${Date.now()}.part`;
        await fs.writeFile(part, bytes);
        await fs.rename(part, file);
        return { data: { path: key, id: key, fullPath: `${bucket}/${key}` }, error: null };
      } catch (e) {
        return fail(e.message, '500');
      }
    },

    async download(key) {
      const file = filePath(root, bucket, key);
      if (!file) return fail('Invalid key');
      try {
        const bytes = await fs.readFile(file);
        return { data: new Blob([bytes], { type: typeOf(key) }), error: null };
      } catch (e) {
        return e.code === 'ENOENT' || e.code === 'EISDIR' ? fail('Object not found', '404') : fail(e.message, '500');
      }
    },

    // The files and folders directly in a folder, as Storage lists them (folders: id null, no metadata)
    async list(prefix = '', options = {}) {
      const dir = prefix ? filePath(root, bucket, prefix.replace(/\/+$/, '')) : path.resolve(root, bucket);
      if (!dir || !BUCKETS.has(bucket)) return fail('Invalid key');
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { data: [], error: null };
        return fail(e.message, '500');
      }
      const out = [];
      for (const entry of entries) {
        if (entry.name.endsWith('.part')) continue;
        if (options.search && !entry.name.toLowerCase().includes(String(options.search).toLowerCase())) continue;
        if (entry.isDirectory()) {
          out.push({ name: entry.name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
          continue;
        }
        const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (!stat) continue;
        const at = stat.mtime.toISOString();
        out.push({
          name: entry.name,
          id: `${bucket}/${prefix ? `${prefix.replace(/\/+$/, '')}/` : ''}${entry.name}`,
          updated_at: at,
          created_at: at,
          last_accessed_at: at,
          metadata: { size: stat.size, mimetype: typeOf(entry.name), lastModified: at },
        });
      }
      const by = options.sortBy?.column || 'name';
      const desc = options.sortBy?.order === 'desc';
      out.sort((a, b) => (a[by] ?? '').localeCompare(b[by] ?? '') * (desc ? -1 : 1));
      const offset = options.offset || 0;
      return { data: out.slice(offset, offset + (options.limit || 100)), error: null };
    },

    async remove(keys) {
      const removed = [];
      for (const key of keys || []) {
        const file = filePath(root, bucket, key);
        if (!file) continue;
        const gone = await fs.unlink(file).then(() => true, (e) => (e.code === 'ENOENT' ? false : Promise.reject(e))).catch(() => false);
        if (gone) removed.push({ name: key, bucket_id: bucket });
      }
      return { data: removed, error: null };
    },

    async createSignedUrl(key, seconds, options = {}) {
      if (!filePath(root, bucket, key)) return fail('Invalid key');
      const download = options.download === true ? path.basename(key) : options.download || '';
      try {
        return { data: { signedUrl: signLink(bucket, key, seconds, download) }, error: null };
      } catch (e) {
        return fail(e.message, '500');
      }
    },
  });
  return { local: true, root, from };
}
