import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadMatcher } from './products.mjs';
import { parse } from 'node-html-parser';
import { logActivity } from './activityLog.mjs';
import { analyzePending } from './psDocs.mjs';
import { notifyPendingAwards } from './awardNotify.mjs';
import { triggerOcr } from './ocrTrigger.mjs';

// PS-PhilGEPS (philgeps.gov.ph) Sync without a browser, so it runs on the deployed dashboard's server.
// PhilGEPS's lists, notices and document lists are plain HTML; they are fetched with the log-in session
// a person made with `node ps-philgeps-session.js --connect` (table ps_philgeps_session). Same result as
// ps-philgeps-sync.js: Bid Match, My Opportunities and Award Notices lists, each Bid Match notice's
// products (table products) and documents. New documents go to the Storage bucket ps-documents, the
// result to ps_philgeps_snapshot, progress to ps_sync_status (read by every dashboard).
// Reads only: never opens Accept / Refuse / Feedback or anything that changes data on PhilGEPS (accepting or
// refusing an award is psAward.mjs, started only by a person).
// Plain .mjs (no Next imports) so it can also be run directly with node for testing.

const HOST = 'https://philgeps.gov.ph';
export const LISTS = [
  { key: 'bidMatch', label: 'Bid Match', url: `${HOST}/EventManagements/myBidMatch` },
  { key: 'opportunities', label: 'My Opportunities', url: `${HOST}/EventManagements/myOpportunities` },
  { key: 'awards', label: 'Award Notices', url: `${HOST}/EventManagements/myAwardNotices` },
];
const MAX_PAGES = 30;
// Notices read at the same time (each needs 3 requests: page, Schedule of activity, Document Preview). At 6
// PhilGEPS answered about half of them with near-empty pages (2026-10-24).
const NOTICES_AT_ONCE = 3;
// From the Sync's start, no new notice is started after this (the host stops the request at 300 s and the
// result must be saved); notices not reached keep what the last Sync read, and the next Sync reads them
const NOTICES_UNTIL_MS = 210 * 1000;
const BUCKET = 'ps-documents';
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
// A Sync "running" for longer than this was cut off (server time limit) and may be started again
export const STALE_RUN_MS = 6 * 60 * 1000;

export class PsSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) {
    throw new PsSyncError('NOT_CONFIGURED', 'SUPABASE_URL and SUPABASE_KEY (secret key) are not set on this server.');
  }
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------- session (cookies) ----------

// The session's cookies as name → value; PhilGEPS's Set-Cookie headers update them as pages are read
export class Session {
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
export function isLoginPage(res, html) {
  return /\/(Indexes|users)\/login/i.test(res.url) || /form[^>]+action="[^"]*users\/login/i.test(html) || /session has been expired/i.test(html);
}

export async function getPage(session, url, options) {
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
  // Rows in a tbody, or straight in the table (Open Opportunities has no tbody)
  const bodyRows = table.querySelectorAll('tbody tr');
  const rows = (bodyRows.length ? bodyRows : table.querySelectorAll('tr'))
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

export async function readList(session, list, onPage = () => {}) {
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

// ---------- Open Opportunities (every open notice, not only our Bid Match) ----------

// Bid Match lists only the notices PhilGEPS pairs with our account's criteria: on 2026-10-26 it had 62 of the
// 134 open medicine notices (Cagayan Valley Medical Center's lots, DOH Region X, ... were missing). The Bulletin
// Board's Open Opportunities lists every open notice: searched by title words here (read-only searches), the
// medicine notices not in Bid Match are added to it, so they are read and matched like the others.
const OPEN_OPPORTUNITIES_URL = `${HOST}/Indexes/index`;
const MEDICINE_TITLE_WORDS = ['medicine', 'drug', 'pharma', 'oncology', 'cancer', 'antibiotic', 'injectable', 'vaccine', 'insulin'];
// Not medicines although the title has one of the words ("Drug Testing Supplies", "Anti-Drug Abuse Office" meals,
// "College of Medicine Building", "HPV DNA Kit"...)
const NOT_MEDICINE = /\b(?:testing|test kits?|kits?|ict|equipment|machines?|subscription|vehicle|building|construction|completion|repair|renovation|furniture|meals|catering|training|seminar|janitorial|security services|command center|reporting system|advocates|abuse office)\b/i;

// The search answers with the newest 100 notices only, no next page: on 2026-10-28 "medicine" gave those published
// 20-28 Oct, so 101007 (published 15 Oct, open until 4 Nov) dropped out of Bid Match. Each word is therefore searched
// by publish date, and a range that comes back full is split in two until every part has room (searchByPublishDate).
const SEARCH_LIMIT = 100;
// How far back an open notice may have been published
const OPEN_SINCE_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The form's dates: "15-Oct-2026" (days counted in Philippine time)
const psDate = (day) => {
  const d = new Date(day * DAY_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
};

// fields: other search fields of the form (searchPublishDateFrom / searchPublishDateTo, searchRefNo...)
export async function searchOpenOpportunities(session, word, fields = {}) {
  const page = parse(await getPage(session, OPEN_OPPORTUNITIES_URL));
  const form = page.querySelectorAll('form').find((f) => f.querySelector('[name=searchNoticeTitle]'));
  if (!form) throw new PsSyncError('LAYOUT', 'PS-PhilGEPS Open Opportunities has no search form (layout changed).');
  const body = new URLSearchParams();
  for (const field of form.querySelectorAll('input, select')) if (field.getAttribute('name')) body.set(field.getAttribute('name'), field.getAttribute('value') || '');
  body.set('searchNoticeTitle', word);
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(OPEN_OPPORTUNITIES_URL, {
        method: 'POST',
        body,
        redirect: 'manual',
        headers: { cookie: session.header(), 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded', referer: OPEN_OPPORTUNITIES_URL, origin: HOST },
        signal: AbortSignal.timeout(30000),
      });
      session.update(res);
      const html = res.status >= 300 && res.status < 400 ? await getPage(session, absolute(res.headers.get('location'))) : await res.text();
      return readTable(parse(html));
    } catch (e) {
      if (e.code === 'NOT_CONNECTED' || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Every notice whose title has the word, published between the two days (day numbers, both included): one search
 * per range, a full one split in two. Returns [{ headers, rows }]. */
export async function searchByPublishDate(session, word, fromDay, toDay) {
  const result = await searchOpenOpportunities(session, word, { searchPublishDateFrom: psDate(fromDay), searchPublishDateTo: psDate(toDay) });
  // A single day with 100 or more notices keeps what the site gives
  if (result.rows.length < SEARCH_LIMIT || fromDay >= toDay) return [result];
  const mid = Math.floor((fromDay + toDay) / 2);
  return [...(await searchByPublishDate(session, word, fromDay, mid)), ...(await searchByPublishDate(session, word, mid + 1, toDay))];
}

/** Open medicine notices from Open Opportunities, as rows in Bid Match's columns (headers), for refs not in it */
export async function openMedicineNotices(session, headers, known) {
  const byRef = new Map();
  const today = Math.floor((Date.now() + 8 * 60 * 60 * 1000) / DAY_MS);
  const results = [];
  for (const word of MEDICINE_TITLE_WORDS) results.push(...(await searchByPublishDate(session, word, today - OPEN_SINCE_DAYS, today)));
  for (const { headers: found, rows } of results) {
    const at = (name) => found.findIndex((h) => h.toLowerCase().startsWith(name));
    for (const row of rows) {
      const ref = row.cells[at('bid notice reference')] || row.cells[0];
      const title = row.cells[at('notice title')] || '';
      if (!/^\d+$/.test(ref) || known.has(ref) || byRef.has(ref) || NOT_MEDICINE.test(title)) continue;
      const value = { 'notice reference number': ref, 'notice title': title, 'mode of procurement': row.cells[at('mode of procurement')], classification: row.cells[at('classification')], 'publish date': row.cells[at('publish date')], 'closing date': row.cells[at('closing date')], 'agency name': row.cells[at('agency name')], status: 'Active' };
      byRef.set(ref, {
        cells: headers.map((h) => value[h.toLowerCase()] ?? ''),
        links: [{ text: ref, href: `${HOST}/tenders/viewBidNotice/${ref}` }],
        from: 'open-opportunities',
      });
    }
  }
  return [...byRef.values()];
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
    // "Opening of Bid Envelopes – ..." as PhilGEPS's Taguig notices write it (lib/schedule.mjs)
    bidOpening: inText('(?:bid opening|opening of bids|opening of (?:the )?bid (?:envelopes|proposals))'),
    closing: field(String.raw`Closing Date:\s*(${FIELD_DATE})`),
    lastUpdated: field(String.raw`Date Last updated:\s*(${FIELD_DATE})`),
  };
}

// The agency's address, centered under its name at the top of the notice: the lines between the name and the
// notice type ("Invitation to Bid", "Request for Quotation"), e.g. "DOH Adela Serra Ty Memorial Medical Center,
// Tandag, Surigao Del Sur, Caraga". null when the page doesn't give one.
const NOTICE_TYPE_LINE = /^(?:invitation|request|notice|expression|call|negotiated|small value|shopping)\b/i;
export function readAgencyAddress(root) {
  const lines = root.querySelectorAll('center.verdhana_twelvepx').map((c) => clean(c.text));
  const end = lines.findIndex((line, i) => i > 0 && NOTICE_TYPE_LINE.test(line));
  // A line may end in its own comma ("Carig,"): drop it so the parts don't read "Carig,, Tuguegarao City"
  return lines.slice(1, end < 0 ? 3 : end).map((line) => line.replace(/[\s,]+$/, '')).filter(Boolean).join(', ') || null;
}

// The notice's "View all activity" pop-up: PhilGEPS's own Schedule of activity, on every notice (pre-bid meeting
// date or "Not Required", venue, clarification deadline, submission deadline, bid opening). Label -> value.
async function readActivity(session, ref) {
  const root = parse(await getPage(session, `${HOST}/Tenders/tender_shedule/${ref}`, { ajax: true }));
  const rows = {};
  for (const row of root.querySelectorAll('.table-row')) {
    const [label, value] = row.querySelectorAll('.table-col-label, .table-col-value').map((c) => clean(c.text));
    if (label && value) rows[label.replace(/\s*:$/, '')] = value;
  }
  return rows;
}

// The schedule fields shown on the dashboard, from the Schedule of activity (preferred) and the notice page
function scheduleFrom(activity, page) {
  const pick = (re) => Object.entries(activity).find(([label]) => re.test(label))?.[1] || null;
  const prebidMeeting = pick(/^Pre-Bid Meeting$/i);
  return {
    ...page,
    prebid: /not required/i.test(prebidMeeting || '') ? 'Not required' : pick(/^Pre-Bid Meeting Start/i) || page.prebid,
    prebidVenue: pick(/^Pre-Bid Venue/i) || page.prebidVenue,
    clarification: pick(/clarification/i),
    deadline: pick(/Submission Deadline/i),
    bidOpening: pick(/^Bid Opening Start/i) || page.bidOpening,
    closing: page.closing || pick(/Submission Deadline/i),
    published: pick(/Published Date/i),
    activity,
  };
}

// A notice page PhilGEPS answered in full: it names its reference number and has its closing date or its
// Document Preview. A busy PhilGEPS sometimes sends the page frame without the notice.
const noticeIsComplete = (root, ref) => root.structuredText.includes(ref) && (/closing date/i.test(root.structuredText) || Boolean(root.querySelector('a[href_path*="tender_doc_view"]')));

async function readNotice(session, supabase, ref, matchMolecules) {
  let root;
  for (let attempt = 1; ; attempt++) {
    root = parse(await getPage(session, `${HOST}/tenders/viewBidNotice/${ref}`));
    if (noticeIsComplete(root, ref)) break;
    if (attempt >= 3) throw new PsSyncError('INCOMPLETE', 'PhilGEPS sent an incomplete notice page (asked 3 times).');
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  // Line by line: our molecule in one of our dosages (products.mjs)
  const matched = matchMolecules(root.structuredText);
  const activity = await readActivity(session, ref).catch((e) => {
    if (e.code === 'NOT_CONNECTED') throw e;
    return {};
  });
  const schedule = scheduleFrom(activity, readSchedule(root));
  const errors = [];

  // Documents "Preview" pop-up: its list is loaded from href_path. An empty answer is asked again once (PhilGEPS
  // sometimes answers empty while busy); still empty is noted, and the next Sync asks again.
  const links = new Set(root.querySelectorAll('a[href*="/portal_documents/"]').map((a) => absolute(a.getAttribute('href'))));
  for (const preview of root.querySelectorAll('a[href_path*="tender_doc_view"]')) {
    let found = [];
    for (let attempt = 1; attempt <= 2 && !found.length; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 2000));
      const list = parse(await getPage(session, absolute(preview.getAttribute('href_path')), { ajax: true }));
      found = list.querySelectorAll('a[href*="/portal_documents/"]').map((a) => absolute(a.getAttribute('href')));
    }
    if (!found.length) errors.push('The Document Preview showed no files (asked twice); the next Sync asks again.');
    for (const url of found) links.add(url);
  }

  const { data: stored } = await supabase.storage.from(BUCKET).list(ref, { limit: 1000 });
  const have = new Map((stored || []).map((f) => [f.name, f.metadata?.size]));
  const documents = [];
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
  return { matched, schedule, address: readAgencyAddress(root), documents, errors };
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

    // Open medicine notices Bid Match doesn't list (openMedicineNotices), added to it. A failed search never stops
    // the Sync: Bid Match is read as before.
    try {
      await progress(27, 'Searching Open Opportunities for medicine notices');
      const known = new Set(lists.bidMatch.rows.map(refOf).filter(Boolean));
      const extra = await withSession(() => openMedicineNotices(session, lists.bidMatch.headers, known));
      lists.bidMatch.rows.push(...extra);
      lists.bidMatch.fromOpenOpportunities = extra.length;
    } catch (e) {
      if (e.code === 'NOT_CONNECTED') throw e;
      lists.bidMatch.openOpportunitiesError = e.message;
    }
    await saveCookies();

    // A notice that can't be read this time (incomplete page, error, out of time) keeps what the last Sync read,
    // marked, instead of being emptied
    const { data: previous } = await supabase.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').maybeSingle();
    // Notices never read (or last read with an error) first, so new ones are read even when time runs out
    const readBefore = (ref) => previous?.notices?.[ref] && !previous.notices[ref].error;
    const refs = [...new Set(lists.bidMatch.rows.map(refOf).filter(Boolean))].sort((a, b) => Number(readBefore(a)) - Number(readBefore(b)));
    const notices = {};
    const keepPrevious = (ref, why) => {
      const last = previous?.notices?.[ref];
      notices[ref] = last && !last.error ? { ...last, errors: [...(last.errors || []).filter((e) => !/^Not read this time/.test(e)), `Not read this time (${why}); showing the last Sync.`] } : { error: why };
    };
    let done = 0;
    await inBatches(refs, NOTICES_AT_ONCE, async (ref) => {
      if (Date.now() - syncStarted > NOTICES_UNTIL_MS) keepPrevious(ref, 'out of time; the next Sync reads it');
      else
        try {
          notices[ref] = await withSession(() => readNotice(session, supabase, ref, matchMolecules));
        } catch (e) {
          if (e.code === 'NOT_CONNECTED' || e.code === 'SITE_DOWN') throw e;
          keepPrevious(ref, e.message);
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

    const summarize = async (reading) => {
      const { data: analyses } = await supabase.from('ps_tender_analysis').select('ref, result').in('ref', refs);
      const inDocuments = new Set((analyses || []).filter((a) => a.result?.items?.length).map((a) => a.ref));
      const ours = refs.filter((ref) => notices[ref]?.matched?.length || inDocuments.has(ref));
      const onlyInDocuments = ours.filter((ref) => !notices[ref]?.matched?.length).length;
      const files = Object.values(notices).reduce((sum, n) => sum + (n.documents?.length || 0), 0);
      const notRead = Object.values(notices).filter((n) => (n.errors || []).some((e) => /^Not read this time/.test(e))).length;
      const leftToRead = reading === undefined ? ' (reading the documents)' : reading?.left ? ` (${reading.left} tenders' documents still being read)` : '';
      const stage =
        `Done: ${lists.bidMatch.rows.length} bid matches (${lists.bidMatch.fromOpenOpportunities ? `${lists.bidMatch.fromOpenOpportunities} added from Open Opportunities, ` : ''}${ours.length} with our products, ${onlyInDocuments} found only in the documents), ` +
        `${files} documents${leftToRead}, ${lists.opportunities.rows.length} opportunities, ${lists.awards.rows.length} award notices` +
        (notRead ? ` · ${notRead} notices kept from the last Sync (PhilGEPS answered incompletely)` : '');
      return { stage, details: { bid_matches: lists.bidMatch.rows.length, matching: ours.length, only_in_documents: onlyInDocuments, files, not_read: notRead, opportunities: lists.opportunities.rows.length, awards: lists.awards.rows.length } };
    };

    // The Sync is done once its lists and notices are saved: marked finished and in History now, so a slow
    // document (e.g. a long OCR) that runs into the host's time limit can't leave it "running"
    const first = await summarize(undefined);
    await setStatus(supabase, { status: 'success', percent: 100, stage: first.stage, finished_at: new Date().toISOString() });
    await logActivity({ event: 'ps-sync', status: 'success', by: started?.started_by, summary: first.stage, details: { duration_ms: tookMs(), ...first.details } });
    // Scanned documents already waiting: read them now on GitHub (ocrTrigger.mjs; never fails the Sync)
    await triggerOcr('ps-sync');

    // Awards waiting for our answer: email the hospital's representative, once per award (awardNotify.mjs)
    await notifyPendingAwards(supabase, lists.awards, (url) => withSession(() => getPage(session, url))).catch(() => {});
    await saveCookies().catch(() => {});

    // Our products are often only in the documents (a notice titled "Drugs and Medicines" lists its items in
    // the bid documents): read the new and changed documents now (psDocs.mjs), as time allows; the rest are read
    // by the 5-minute keep-alive
    const reading = await analyzePending({
      maxMs: Math.max(0, READ_UNTIL_MS - (Date.now() - syncStarted)),
      refs,
      onProgress: (n, total) => setStatus(supabase, { stage: `${first.stage} · reading the documents for our products (${n} of ${total})` }).catch(() => {}),
    }).catch(() => null);
    const { stage } = await summarize(reading);
    await setStatus(supabase, { stage }).catch(() => {});
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
