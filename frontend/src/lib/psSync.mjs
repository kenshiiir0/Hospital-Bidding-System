import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadMatcher } from './products.mjs';
import { parse } from 'node-html-parser';
import { logActivity } from './activityLog.mjs';
import { analyzePending } from './psDocs.mjs';

// PS-PhilGEPS (philgeps.gov.ph) Sync without a browser, so it runs on the deployed dashboard's server.
// PhilGEPS's lists, notices and document lists are plain HTML; they are fetched with the log-in session
// a person made with `node ps-philgeps-session.js --connect` (table ps_philgeps_session). Same result as
// ps-philgeps-sync.js: Bid Match, My Opportunities and Award Notices lists, each Bid Match notice's
// products (table products) and documents. New documents go to the Storage bucket ps-documents, the
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
    this.load(cookies);
  }
  load(cookies) {
    this.jar = new Map(cookies.map((c) => [c.name, c]));
  }
  // To tell whether the saved copy was changed by someone else
  fingerprint() {
    return this.header();
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

// ---------- our products ----------

// The matcher for our product list (table products, lib/products.mjs: the PRODUCT LIST plus Add Molecule)

// ---------- documents ----------

const TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
// Same Storage key rule as tools/ps-publish.js
const storageName = (name) => name.replace(/[^A-Za-z0-9._()-]/g, '_');

// Key dates from a notice page. The right-hand column has labelled fields ("Prebid Conference: Date: ...
// Venue: ...", "Closing Date: ...", "Date Last updated: ..."); the bid opening is usually only in the
// description ("BID OPENING : November 17, 2026", "Bid opening shall be on ..."), so it's taken from there.
// The page writes its line breaks as "</br>", which the HTML parser doesn't treat as breaks, so all the
// labels can come out on one line: values are read from the text right after each label, up to the next one.
const DATE = String.raw`(?:[A-Z][a-z]+\.? \d{1,2},? \d{4}|\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{4})(?:[ ,(]+(?:at )?\d{1,2}:\d{2} ?(?:[AaPp]\.?[Mm]\.?)?)?`;
// PhilGEPS's own field format: "17-Nov-2026 09:30 AM"
const FIELD_DATE = String.raw`\d{1,2}-[A-Za-z]{3}-\d{4}(?: \d{1,2}:\d{2} ?[AaPp][Mm])?`;
const NEXT_LABEL = String.raw`(?=\s+(?:Closing Date|Date Last updated|Documents|Bid Form Fee|Bid Supplements|Published Date|Prebid Conference):|$)`;
function readSchedule(root) {
  const text = root.structuredText.split('\n').map(clean).filter(Boolean).join(' ');
  const field = (re) => text.match(new RegExp(re, 'i'))?.[1]?.trim() || null;
  const inText = (words) => text.match(new RegExp(`${words}[^.]{0,60}?(${DATE})`, 'i'))?.[1] || null;
  return {
    prebid: field(String.raw`Prebid Conference:\s*Date:\s*(${FIELD_DATE})`) || inText('pre-?bid conference'),
    prebidVenue: field(String.raw`Prebid Conference:\s*Date:\s*${FIELD_DATE}\s*Venue:\s*(.{1,200}?)${NEXT_LABEL}`),
    bidOpening: inText('(?:bid opening|opening of bids)'),
    closing: field(String.raw`Closing Date:\s*(${FIELD_DATE})`),
    lastUpdated: field(String.raw`Date Last updated:\s*(${FIELD_DATE})`),
  };
}

async function readNotice(session, supabase, ref, matchMolecules) {
  const root = parse(await getPage(session, `${HOST}/tenders/viewBidNotice/${ref}`));
  const matched = matchMolecules(root.text);
  const schedule = readSchedule(root);

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
  return { matched, schedule, documents, errors };
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

// Time from the Sync's start until it stops reading documents (the host stops a request at 300 s); tenders
// not read by then are read by the 5-minute keep-alive (/api/ps-keepalive)
const READ_UNTIL_MS = 260 * 1000;

export async function runSync() {
  const syncStarted = Date.now();
  const supabase = admin();
  // For the History page (activityLog.mjs)
  const { data: started } = await supabase.from('ps_sync_status').select('started_by, started_at').eq('id', 'latest').maybeSingle();
  const tookMs = () => (started?.started_at ? Date.now() - Date.parse(started.started_at) : null);
  const progress = (percent, stage) => setStatus(supabase, { percent: Math.round(percent), stage }).catch(() => {});
  try {
    const { data: saved } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
    if (!saved?.cookies?.length) throw new PsSyncError('NOT_CONNECTED', 'PS-PhilGEPS is not connected. A person must connect (captcha).');
    const session = new Session(saved.cookies);
    const matchMolecules = await loadMatcher();

    // The saved session is shared (keep-alive, other computers). Keep the saved copy up to date while
    // reading, and if PhilGEPS shows the log-in page, first check whether someone saved a newer copy
    // (then carry on with it) before calling the session ended.
    let savedPrint = new Session(saved.cookies).fingerprint();
    const saveCookies = async () => {
      if (session.fingerprint() === savedPrint) return;
      await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current');
      savedPrint = session.fingerprint();
    };
    const withSession = async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e.code !== 'NOT_CONNECTED') throw e;
        const { data: now } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
        if (!now?.cookies?.length || new Session(now.cookies).fingerprint() === session.fingerprint()) throw e;
        session.load(now.cookies);
        savedPrint = session.fingerprint();
        return fn();
      }
    };

    const lists = {};
    for (const [i, list] of LISTS.entries()) {
      lists[list.key] = await withSession(() => readList(session, list, (n) => progress(3 + i * 8 + Math.min(n, 7), `Reading ${list.label} (page ${n})`)));
    }
    await saveCookies();

    const refs = [...new Set(lists.bidMatch.rows.map(refOf).filter(Boolean))];
    const notices = {};
    let done = 0;
    await inBatches(refs, NOTICES_AT_ONCE, async (ref) => {
      try {
        notices[ref] = await withSession(() => readNotice(session, supabase, ref, matchMolecules));
      } catch (e) {
        if (e.code === 'NOT_CONNECTED' || e.code === 'SITE_DOWN') throw e;
        notices[ref] = { error: e.message };
      }
      done++;
      if (done % 10 === 0) await saveCookies();
      await progress(28 + (55 * done) / Math.max(refs.length, 1), `Notices and documents (${done} of ${refs.length})`);
    });

    await progress(84, 'Saving');
    const syncedAt = new Date().toISOString();
    const { error } = await supabase.from('ps_philgeps_snapshot').upsert({ id: 'latest', synced_at: syncedAt, lists, notices, updated_at: syncedAt });
    if (error) throw new PsSyncError('DB', `Saving the result: ${error.message}`);
    await saveCookies();

    // Our products are often only in the documents (a notice titled "Drugs and Medicines" lists its items in
    // the bid documents): read the new and changed documents now (psDocs.mjs)
    await progress(85, 'Reading the documents for our products');
    const reading = await analyzePending({
      maxMs: Math.max(0, READ_UNTIL_MS - (Date.now() - syncStarted)),
      refs,
      onProgress: (n, total) => progress(85 + (12 * n) / Math.max(total, 1), `Reading the documents for our products (${n} of ${total})`),
    }).catch(() => null);
    const { data: analyses } = await supabase.from('ps_tender_analysis').select('ref, result').in('ref', refs);
    const inDocuments = new Set((analyses || []).filter((a) => a.result?.items?.length).map((a) => a.ref));

    const ours = refs.filter((ref) => notices[ref]?.matched?.length || inDocuments.has(ref));
    const matching = ours.length;
    const onlyInDocuments = ours.filter((ref) => !notices[ref]?.matched?.length).length;
    const files = Object.values(notices).reduce((sum, n) => sum + (n.documents?.length || 0), 0);
    const leftToRead = reading?.left ? ` (${reading.left} tenders' documents still being read)` : '';
    const stage = `Done: ${lists.bidMatch.rows.length} bid matches (${matching} with our products, ${onlyInDocuments} found only in the documents), ${files} documents${leftToRead}, ${lists.opportunities.rows.length} opportunities, ${lists.awards.rows.length} award notices`;
    await setStatus(supabase, { status: 'success', percent: 100, stage, finished_at: new Date().toISOString() });
    await logActivity({
      event: 'ps-sync',
      status: 'success',
      by: started?.started_by,
      summary: stage,
      details: { duration_ms: tookMs(), bid_matches: lists.bidMatch.rows.length, matching, only_in_documents: onlyInDocuments, files, opportunities: lists.opportunities.rows.length, awards: lists.awards.rows.length },
    });
    return stage;
  } catch (e) {
    const fields = { status: 'failed', error: e.message, finished_at: new Date().toISOString() };
    // Session gone: forget it, so every dashboard shows "not connected" until someone connects again
    if (e.code === 'NOT_CONNECTED') {
      fields.connected_at = null;
      await supabase.from('ps_philgeps_session').delete().eq('id', 'current');
    }
    await setStatus(supabase, fields).catch(() => {});
    await logActivity({ event: 'ps-sync', status: 'failed', by: started?.started_by, summary: e.message, details: { duration_ms: tookMs() } });
    throw e;
  }
}

// ---------- keep-alive ----------

// One members-only page with the saved session: keeps it from going idle and stores refreshed cookies.
// A session PhilGEPS already ended is forgotten (every dashboard then shows "not connected").
export async function keepAlive() {
  const supabase = admin();
  // A running Sync keeps the session busy itself; using the same session at the same time can end it
  const { data: status } = await supabase.from('ps_sync_status').select('status, started_at').eq('id', 'latest').single();
  if (status?.status === 'running' && Date.now() - new Date(status.started_at).getTime() < STALE_RUN_MS) return { skipped: 'sync running' };
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
