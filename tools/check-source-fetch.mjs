// Proves a bid document fetched again from PS-PhilGEPS (frontend/src/lib/sourceFetch.mjs fetchOne) is saved on the
// server's disk only when it really is the file: the right size, not PS-PhilGEPS's log-in page, not an error page.
// Uses a small local web server in place of PS-PhilGEPS and a temporary folder; nothing outside is touched.
//   node tools/check-source-fetch.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createDiskStorage } from '../frontend/src/lib/db/diskStorage.mjs';
import { Session } from '../frontend/src/lib/psSync.mjs';
import { fetchOne } from '../frontend/src/lib/sourceFetch.mjs';

const pdf = Buffer.from('%PDF-1.4 scanned bid form\n');
let cookieSeen = '';
const server = http.createServer((req, res) => {
  cookieSeen = req.headers.cookie || '';
  if (req.url === '/file.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'set-cookie': 'PHPSESSID=renewed; path=/' });
    return res.end(pdf);
  }
  if (req.url === '/expired.pdf') {
    res.writeHead(302, { location: '/Indexes/login' });
    return res.end();
  }
  if (req.url === '/Indexes/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<form action="/users/login" method="post"><input name="password"></form>');
  }
  if (req.url === '/missing.pdf') {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('not found');
  }
  res.writeHead(500);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fetch-'));
const storage = createDiskStorage(root);
const session = new Session([{ name: 'PHPSESSID', value: 'abc', domain: 'philgeps.gov.ph', path: '/' }]);
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => (cond ? passed++ : (failed++, console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`)));
const attempt = (doc) => fetchOne(storage, session, doc).then((n) => ({ n }), (e) => ({ e }));

const good = await attempt({ url: `${base}/file.pdf`, path: '111/Bid Form.pdf', size: pdf.length });
ok('the file is saved', good.n === pdf.length && fs.readFileSync(path.join(root, 'ps-documents/111/Bid Form.pdf')).equals(pdf), good.e?.message);
ok('sent with the session cookie', cookieSeen.includes('PHPSESSID=abc'), cookieSeen);
ok('the session takes renewed cookies', session.header().includes('PHPSESSID=renewed'), session.header());

const wrongSize = await attempt({ url: `${base}/file.pdf`, path: '111/Other.pdf', size: pdf.length + 10 });
ok('wrong size: not saved', wrongSize.e && !storage.exists('ps-documents', '111/Other.pdf'), wrongSize.e?.message);

const loginPage = await attempt({ url: `${base}/expired.pdf`, path: '111/Expired.pdf', size: 0 });
ok('log-in page: session ended, not saved', loginPage.e?.code === 'NOT_CONNECTED' && !storage.exists('ps-documents', '111/Expired.pdf'), loginPage.e?.message);

const notFound = await attempt({ url: `${base}/missing.pdf`, path: '111/Missing.pdf', size: 0 });
ok('error page: not saved', notFound.e && notFound.e.code !== 'NOT_CONNECTED' && !storage.exists('ps-documents', '111/Missing.pdf'), notFound.e?.message);

const unsized = await attempt({ url: `${base}/file.pdf`, path: '111/No Size.pdf' });
ok('a file without a recorded size is saved', unsized.n === pdf.length);

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
