import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { parse } from 'node-html-parser';

// PS-PhilGEPS (philgeps.gov.ph) Sync without a browser, so it runs on the deployed dashboard's server.
// PhilGEPS's lists, notices and document lists are plain HTML; they are fetched with the log-in session
// a person made with `node ps-philgeps-session.js --connect` (table ps_philgeps_session). Same result as
// ps-philgeps-sync.js: Bid Match, My Opportunities and Award Notices lists, each Bid Match notice's
// products (molecules.json) and documents. New documents go to the Storage bucket ps-documents, the
// result to ps_philgeps_snapshot, progress to ps_sync_status (read by every dashboard).
// Reads only: never opens Accept / Refuse / Feedback or anything that changes data on PhilGEPS.
// Plain .mjs (no Next imports) so it can also be run directly with node for testing.

const HOST = 'https://philgeps.gov.ph';
const LISTS = [
  { key: 'bidMatch', label: 'Bid Match', url: `${HOST}/EventManagements/myBidMatch` },
  { key: 'opportunities', label: 'My Opportunities', url: `${HOST}/EventManagements/myOpportunities` },
  { key: 'awards', label: 'Award Notices', url: `${HOST}/EventManagements/myAwardNotices` },
];
const MAX_PAGES = 30;
const NOTICES_AT_ONCE = 6;
const BUCKET = 'ps-documents';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
// A Sync "running" for longer than this was cut off (server time limit) and may be started again
export const STALE_RUN_MS = 6 * 60 * 1000;

export class PsSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) {
    throw new PsSyncError('NOT_CONFIGURED', 'SUPABASE_URL and SUPABASE_KEY (secret key) are not set on this server.');
  }
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------- session (cookies) ----------

// The session's cookies as name → value; PhilGEPS's Set-Cookie headers update them as pages are read
class Session {
  constructor(cookies) {
    this.jar = new Map(cookies.map((c) => [c.name, c]));
  }
  header() {
    return [...this.jar.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }
  update(res) {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const old = this.jar.get(name) || { domain: 'philgeps.gov.ph', path: '/' };
      const deleted = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()));
      if (deleted) this.jar.delete(name);
      else this.jar.set(name, { ...old, name, value });
    }
  }
  cookies() {
    return [...this.jar.values()];
  }
}

async function get(session, url, { ajax = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          cookie: session.header(),
          'user-agent': USER_AGENT,
          // The Documents pop-up loads its list with jQuery; without this header PhilGEPS says "session expired"
          ...(ajax && { 'x-requested-with': 'XMLHttpRequest' }),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      session.update(res);
      if (res.status >= 500 && attempt < 3) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (attempt >= 3) throw new PsSyncError('SITE_DOWN', `PS-PhilGEPS is not responding (${e.message}). Try again in a few minutes.`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// A members-only page that comes back as the log-in form means PhilGEPS ended the session
function isLoginPage(res, html) {
  return /\/(Indexes|users)\/login/i.test(res.url) || /form[^>]+action="[^"]*users\/login/i.test(html) || /session has been expired/i.test(html);
}

async function getPage(session, url, options) {
  const res = await get(session, url, options);
  const html = await res.text();
  if (isLoginPage(res, html)) throw new PsSyncError('NOT_CONNECTED', 'The PS-PhilGEPS session has ended. A person must connect again (captcha).');
  return html;
}

// ---------- reading pages ----------

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const absolute = (href) => {
  try {
    return new URL(href, HOST).href;
  } catch {
    return null;
  }
};

// The page's main data table (the one with the most rows): header texts and, per row, cell texts + links
function readTable(root) {
  const table = root.querySelectorAll('table').sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
  if (!table) return { headers: [], rows: [] };
  const headRow = table.querySelector('thead tr') || table.querySelector('tr');
  const headers = headRow.querySelectorAll('th, td').map((c) => clean(c.text));
  const rows = table
    .querySelectorAll('tbody tr')
    .filter((tr) => tr !== headRow)
    .map((tr) => ({
      cells: tr.querySelectorAll('td').map((td) => clean(td.text)),
      links: tr
        .querySelectorAll('a[href]')
        .map((a) => ({ text: clean(a.text), href: absolute(a.getAttribute('href')) }))
        .filter((l) => l.href?.startsWith('http')),
    }))
    .filter((r) => r.cells.length > 1);
  return { headers, rows };
}

// CakePHP paginator "next" link, or null
function nextPageUrl(root, current) {
  const a =
    root.querySelector('a[rel="next"]') ||
    root.querySelector('.pagination .next a') ||
    root.querySelector('li.next a') ||
    root.querySelectorAll('.pagination a, .paging a').find((x) => /^(next|›|»|>)/i.test(clean(x.text)));
  const href = a && absolute(a.getAttribute('href'));
  return href && !href.startsWith('javascript') && href !== current ? href : null;
}

async function readList(session, list, onPage) {
  const result = { label: list.label, headers: [], rows: [], pages: 0 };
  const seen = new Set();
  let url = list.url;
  while (url && !seen.has(url) && result.pages < MAX_PAGES) {
    seen.add(url);
    const root = parse(await getPage(session, url));
    result.pages++;
    const { headers, rows } = readTable(root);
    if (!result.headers.length) result.headers = headers;
    result.rows.push(...rows);
    onPage(result.pages);
    url = nextPageUrl(root, url);
  }
  return result;
}

// Notice reference number of a list row: its link to the notice page, else a numeric first cell
export function refOf(row) {
  const link = row.links.find((l) => /viewBidNotice\/(\d+)/.test(l.href));
  if (link) return link.href.match(/viewBidNotice\/(\d+)/)[1];
  return /^\d+$/.test(row.cells[0]) ? row.cells[0] : null;
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

// ---------- documents ----------

const TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
// Same Storage key rule as tools/ps-publish.js
const storageName = (name) => name.replace(/[^A-Za-z0-9._()-]/g, '_');

async function readNotice(session, supabase, ref, matchMolecules) {
  const root = parse(await getPage(session, `${HOST}/tenders/viewBidNotice/${ref}`));
  const matched = matchMolecules(root.text);

  // Documents "Preview" pop-up: its list is loaded from href_path
  const links = new Set(root.querySelectorAll('a[href*="/portal_documents/"]').map((a) => absolute(a.getAttribute('href'))));
  for (const preview of root.querySelectorAll('a[href_path*="tender_doc_view"]')) {
    const list = parse(await getPage(session, absolute(preview.getAttribute('href_path')), { ajax: true }));
    for (const a of list.querySelectorAll('a[href*="/portal_documents/"]')) links.add(absolute(a.getAttribute('href')));
  }

  const { data: stored } = await supabase.storage.from(BUCKET).list(ref, { limit: 1000 });
  const have = new Map((stored || []).map((f) => [f.name, f.metadata?.size]));
  const documents = [];
  const errors = [];
  for (const url of links) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/[<>:"/\\|?*]/g, '_');
    const key = storageName(name);
    if (have.has(key)) {
      documents.push({ name, size: have.get(key), url, path: `${ref}/${key}` });
      continue;
    }
    try {
      const res = await get(session, url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const { error } = await supabase.storage.from(BUCKET).upload(`${ref}/${key}`, body, {
        contentType: TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
        upsert: false,
      });
      if (error && !/exists/i.test(error.message)) throw new Error(error.message);
      documents.push({ name, size: body.length, url, path: `${ref}/${key}` });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { matched, documents, errors };
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// ---------- status ----------

async function setStatus(supabase, fields) {
  const { error } = await supabase.from('ps_sync_status').update(fields).eq('id', 'latest');
  if (error) throw new PsSyncError('DB', `Saving the Sync status: ${error.message}`);
}

// Marks the Sync as started, unless one is already running. Returns false when one is running.
export async function claimSync(by) {
  const supabase = admin();
  const { data } = await supabase.from('ps_sync_status').select('status, started_at, connected_at').eq('id', 'latest').single();
  if (data?.status === 'running' && Date.now() - new Date(data.started_at).getTime() < STALE_RUN_MS) return { started: false };
  if (!data?.connected_at) return { started: false, notConnected: true };
  await setStatus(supabase, { status: 'running', percent: 0, stage: 'Starting', error: null, started_by: by, started_at: new Date().toISOString(), finished_at: null });
  return { started: true };
}

// ---------- the Sync ----------

export async function runSync() {
  const supabase = admin();
  const progress = (percent, stage) => setStatus(supabase, { percent: Math.round(percent), stage }).catch(() => {});
  try {
    const { data: saved } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
    if (!saved?.cookies?.length) throw new PsSyncError('NOT_CONNECTED', 'PS-PhilGEPS is not connected. A person must connect (captcha).');
    const session = new Session(saved.cookies);
    const matchMolecules = await loadMatcher();

    const lists = {};
    for (const [i, list] of LISTS.entries()) {
      lists[list.key] = await readList(session, list, (n) => progress(3 + i * 8 + Math.min(n, 7), `Reading ${list.label} (page ${n})`));
    }

    const refs = [...new Set(lists.bidMatch.rows.map(refOf).filter(Boolean))];
    const notices = {};
    let done = 0;
    await inBatches(refs, NOTICES_AT_ONCE, async (ref) => {
      try {
        notices[ref] = await readNotice(session, supabase, ref, matchMolecules);
      } catch (e) {
        if (e.code === 'NOT_CONNECTED' || e.code === 'SITE_DOWN') throw e;
        notices[ref] = { error: e.message };
      }
      done++;
      await progress(28 + (67 * done) / Math.max(refs.length, 1), `Notices and documents (${done} of ${refs.length})`);
    });

    await progress(97, 'Saving');
    const syncedAt = new Date().toISOString();
    const { error } = await supabase.from('ps_philgeps_snapshot').upsert({ id: 'latest', synced_at: syncedAt, lists, notices, updated_at: syncedAt });
    if (error) throw new PsSyncError('DB', `Saving the result: ${error.message}`);
    // Keep the newest cookies PhilGEPS handed out
    await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current');

    const matching = Object.values(notices).filter((n) => n.matched?.length).length;
    const files = Object.values(notices).reduce((sum, n) => sum + (n.documents?.length || 0), 0);
    const stage = `Done: ${lists.bidMatch.rows.length} bid matches (${matching} with our products), ${files} documents, ${lists.opportunities.rows.length} opportunities, ${lists.awards.rows.length} award notices`;
    await setStatus(supabase, { status: 'success', percent: 100, stage, finished_at: new Date().toISOString() });
    return stage;
  } catch (e) {
    const fields = { status: 'failed', error: e.message, finished_at: new Date().toISOString() };
    // Session gone: forget it, so every dashboard shows "not connected" until someone connects again
    if (e.code === 'NOT_CONNECTED') {
      fields.connected_at = null;
      await supabase.from('ps_philgeps_session').delete().eq('id', 'current');
    }
    await setStatus(supabase, fields).catch(() => {});
    throw e;
  }
}

// ---------- keep-alive ----------

// One members-only page with the saved session: keeps it from going idle and stores refreshed cookies.
// A session PhilGEPS already ended is forgotten (every dashboard then shows "not connected").
export async function keepAlive() {
  const supabase = admin();
  const { data: saved } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
  if (!saved?.cookies?.length) return { connected: false };
  const session = new Session(saved.cookies);
  try {
    await getPage(session, LISTS[0].url);
  } catch (e) {
    if (e.code !== 'NOT_CONNECTED') throw e;
    await supabase.from('ps_philgeps_session').delete().eq('id', 'current');
    await setStatus(supabase, { connected_at: null });
    return { connected: false, ended: true };
  }
  await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current');
  return { connected: true };
}
