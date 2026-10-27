import { createClient } from '@supabase/supabase-js';
import { parse } from 'node-html-parser';
import { checkLogin, recordLogin } from './loginGuard.mjs';
import { logActivity } from './activityLog.mjs';
import { loadMatcher, ocrPending, readDocuments } from './psDocs.mjs';
import { triggerOcr } from './ocrTrigger.mjs';
import { isPackageTender } from './packageTender.js';

// PhilGEPS (notices.philgeps.gov.ph) document Sync without a browser, so it runs on the deployed dashboard's
// server. Same steps the team does by hand (and documents.js does with Chrome on a team computer), sent as the
// pages' own ASP.NET form posts:
// - already ordered: My Opportunities' "Ordered By" page → order → each document link answers with the file,
// - not ordered yet: notice → Order → Order Basket (every amount 0.00) → Continue → (5-day notice → Continue
//   Order) → Order Confirmation (every amount 0.00) → Submit → each document link.
// Files go to the Storage bucket philgeps-documents, results to philgeps_opportunities.details, progress to
// philgeps_sync_relay.job (read by every dashboard). Never pays: anything above 0.00 stops at that tender.
// Session safety: one Sync at a time (claimSync), the session's cookies are saved in philgeps_session the moment
// the log-in is sent, one log-in serves every round of a Sync (the next round reuses it), the last round (or a
// failed one) logs out and confirms it, and sweepSession() (every 5 minutes) logs out a session left idle.
// Account safety: every log-in passes loginGuard.mjs first (few log-ins, none after a refused password). A round stops starting tenders after ROUND_MS (the host allows 300 s)
// and the next round continues with the rest.
// Plain .mjs (no Next imports) so it can also be run directly with node for testing.

// PHILGEPS_TEST_HOST: the stand-in PhilGEPS of tools/check-sync-safety.mjs (this computer only; anything else
// is ignored, so the real account can never be pointed elsewhere)
const TEST_HOST = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.PHILGEPS_TEST_HOST || '') ? process.env.PHILGEPS_TEST_HOST : null;
const HOST = TEST_HOST || 'https://notices.philgeps.gov.ph';
const LOGIN_PAGE = `${HOST}/GEPS/log-in.aspx`;
const LOGIN_ACTION = `${HOST}/GEPS/logInAction.aspx`;
const LOGOUT_URL = `${HOST}/GEPS/LogoutRedirect.aspx`;
// Members-only page: answers with a redirect to log-in.aspx once the session is closed
const MEMBERS_URL = `${HOST}/GEPS/Tender/PendingTaskUI.aspx?EPSSubMenuID=45`;
// The logged-in user's id ("<id>-<role>-<org>-..."; a redirect script when logged out), and the call PhilGEPS's
// Log-out button makes before leaving (clears its record of the logged-in user)
const USER_DETAILS_URL = `${HOST}/GEPS/responsewrite.aspx`;
const CLEAR_LOCK_URL = (userId) => `${HOST}/p4_webservices/GEPSR3_Common_Service.asmx/ClearPassPhraseCached?userID=${userId}`;
const NOTICE_URL = (ref) => `${HOST}/GEPS/Tender/BidNoticeAbstractUI.aspx?refID=${ref}&DirectFrom=OpenOpp&Type=category&BusCatID=99`;
const ORDERED_URL = (ref) => `${HOST}/GEPS/Tender/ViewOrderAssocCompUI.aspx?directFrom=MyOpportunitiesUI&EPSSubMenuID=32&refID=${ref}`;
const BASKET_URL = `${HOST}/GEPS/Tender/OrderBasketUI.aspx?ClickFrom=OpenOpp&OrginFrom=PendTask`;
// An order's page, as the "Ordered By" list's order number opens it (the list's own link only works in a browser)
const ORDER_URL = (orderNo, ref) => `${HOST}/GEPS/Tender/OrderConfirmationUI.aspx?DirectFrom=MyOpportunities&OrderID=${orderNo}&refID=${ref}`;
const BUCKET = 'philgeps-documents';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
// Time a round may start new tenders in; the host stops a request at 300 s and the log-out needs a moment
export const ROUND_MS = 200 * 1000;
// A Sync whose progress hasn't moved for this long was cut off (host time limit) and may be started again
export const STALE_RUN_MS = 6 * 60 * 1000;
const RECHECK_MS = 24 * 60 * 60 * 1000;
// A description shorter than this has no item list ("Please see attachment", "Drugs and Medicines"), so a
// tender that doesn't name our products there gets its documents ordered and read too
const DESCRIPTION_ITEMS_MIN = 1500;
// Version of the document reading stored per tender (documents_read_key); a change reads them again
// read-37: psDocs.mjs rules-39. read-36: psDocs.mjs rules-38. read-35: psDocs.mjs rules-37. read-34: psDocs.mjs rules-36. read-33: psDocs.mjs rules-35. read-32: psDocs.mjs rules-34. read-31: psDocs.mjs rules-33. read-30: psDocs.mjs rules-32. read-29: psDocs.mjs rules-31, package or lot tenders get no molecules. read-28: psDocs.mjs rules-30. read-27: psDocs.mjs rules-29. read-26: psDocs.mjs rules-28. read-25: psDocs.mjs rules-27. read-24: psDocs.mjs rules-26. read-23: psDocs.mjs rules-25. read-22: psDocs.mjs rules-24. read-21: psDocs.mjs rules-23. read-20: psDocs.mjs rules-22. read-19: psDocs.mjs rules-21. read-18: psDocs.mjs rules-20. read-17: psDocs.mjs rules-19. read-16: psDocs.mjs rules-18. read-15: psDocs.mjs rules-17. read-14: psDocs.mjs rules-16. read-13: psDocs.mjs rules-15. read-12: psDocs.mjs rules-14. read-11: psDocs.mjs rules-13. read-10: psDocs.mjs rules-12. read-9: psDocs.mjs rules-11. read-8: psDocs.mjs rules-10. read-7: row numbers no longer read as quantities (psDocs.mjs rules-9). read-6: misspelled names (lib/products.mjs)
const READ_RULES = 'read-37';
// Loads of the log-in page (PhilGEPS flickers); the password itself is sent at most LOGIN_POSTS times
const LOGIN_TRIES = 4;
const LOGIN_POSTS = 2;
// A saved session with no Sync progress for this long is logged out by sweepSession()
const SESSION_IDLE_MS = 5 * 60 * 1000;
// After a confirmed log-out the session's cookies are kept this long, and the 5-minute clean-up checks with
// them that PhilGEPS really closed it (logging out again if not), so a wrong confirmation can still be undone
const RECHECK_AFTER_LOGOUT_MS = 60 * 60 * 1000;

const TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const storageName = (name) => name.replace(/[^A-Za-z0-9._()-]/g, '_');

export class PhilgepsSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new PhilgepsSyncError('NOT_CONFIGURED', 'SUPABASE_URL and SUPABASE_KEY (secret key) are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ---------- HTTP session ----------

export class Session {
  constructor(cookies = []) {
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
      if (attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()))) this.jar.delete(name);
      else this.jar.set(name, { name, value, domain: 'notices.philgeps.gov.ph', path: '/' });
    }
  }
  cookies() {
    return [...this.jar.values()];
  }
}

// One request with the session's cookies. Redirects are followed by hand so every Set-Cookie on the way is
// kept (ASP.NET sets the log-in cookie on a redirect). Returns { res, url } (url = the final address).
// follow: false returns the first answer as it is (no redirects followed).
async function request(session, url, { method = 'GET', form, timeout = 45000, follow = true, referer } = {}) {
  let current = url;
  let options = { method, body: form ? new URLSearchParams(form).toString() : undefined, referer };
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(current, {
      method: options.method,
      body: options.body,
      redirect: 'manual',
      // What a browser sends: PhilGEPS holds back form posts that don't say where they come from
      headers: {
        cookie: session.header(),
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        'upgrade-insecure-requests': '1',
        ...(options.body && { 'content-type': 'application/x-www-form-urlencoded', origin: HOST, referer: options.referer || url }),
      },
      signal: AbortSignal.timeout(timeout),
    }).catch((e) => {
      throw new PhilgepsSyncError('SITE_DOWN', `PhilGEPS is not responding (${e.message}).`);
    });
    session.update(res);
    const location = res.headers.get('location');
    if (!follow) return { res, url: current };
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      options = { method: 'GET' };
      continue;
    }
    if (/ErrorPage/i.test(current)) throw new PhilgepsSyncError('SITE_DOWN', 'PhilGEPS showed its error page.');
    return { res, url: current };
  }
  throw new PhilgepsSyncError('SITE_DOWN', 'PhilGEPS kept redirecting.');
}

export async function getPage(session, url) {
  const { res, url: finalUrl } = await request(session, url);
  const html = await res.text();
  if (/log-in\.aspx/i.test(finalUrl)) throw new PhilgepsSyncError('SESSION_ENDED', 'PhilGEPS ended the session (sent back to the log-in page).');
  return { html, url: finalUrl };
}

// ---------- reading ASP.NET pages ----------

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Every alert() message in the page's scripts, e.g. "You have already ordered this document…"
export function alertsOf(html) {
  return [...html.matchAll(/alert\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g)].map((m) => m[2].replace(/\\(['"])/g, '$1'));
}

// The fields a browser would send for the page's form (hidden fields, text fields, checked boxes, selects)
// and the address it posts to, resolved against the page's own address
export function formFields(html, pageUrl = `${HOST}/GEPS/Tender/`) {
  const root = parse(html);
  // PhilGEPS's HTML is too messy for the parser to always see the <form> (a browser repairs it). An ASP.NET page
  // has exactly one form, so without it the whole page's fields and the form tag's own action are used.
  const scope = root.querySelector('form') || root;
  const fields = {};
  for (const input of scope.querySelectorAll('input')) {
    const name = input.getAttribute('name');
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !input.hasAttribute('checked')) continue;
    fields[name] = input.getAttribute('value') ?? (type === 'checkbox' ? 'on' : '');
  }
  for (const select of scope.querySelectorAll('select')) {
    const name = select.getAttribute('name');
    const option = select.querySelector('option[selected]') || select.querySelector('option');
    if (name && option) fields[name] = option.getAttribute('value') ?? clean(option.text);
  }
  const rawAction = /<form[^>]*action="([^"]*)"/i.exec(html)?.[1]?.replace(/&amp;/g, '&');
  return { fields, action: new URL(rawAction || pageUrl, pageUrl).href };
}

// Posts the page's form back: a link's __doPostBack(target, argument), or a submit button (name = value)
export async function postBack(session, page, { target, argument = '', button }) {
  const { fields, action } = formFields(page.html, page.url);
  const form = { ...fields, __EVENTTARGET: target || '', __EVENTARGUMENT: argument };
  if (button) form[button.name] = button.value;
  return request(session, action, { method: 'POST', form, referer: page.url });
}

// Postback links: [{ target, argument, text, el }]
export function postbackLinks(html) {
  const root = parse(html);
  return root
    .querySelectorAll('a')
    .map((a) => {
      const m = /__doPostBack\('([^']*)','([^']*)'\)/.exec(a.getAttribute('href') || '');
      return m && { target: m[1], argument: m[2], text: clean(a.text), el: a };
    })
    .filter(Boolean);
}

const buttonOf = (html, name) => {
  const input = parse(html).querySelector(`input[name="${name}"]`);
  return input && { name, value: input.getAttribute('value') || '' };
};

// Free order: PhilGEPS's own totals (Handling Fees, Subtotal, Tax, Total) are all 0.00. Numbers inside titles
// don't count; the Subtotal covers every item's price.
export function allAmountsZero(html) {
  const text = clean(parse(html).text);
  const totals = [...text.matchAll(/\b(Handling Fees|Subtotal|Tax|Total)\s+(?:Php\s*)?([\d,]+\.\d{2})\b/gi)].map((m) => Number(m[2].replace(/,/g, '')));
  return totals.length >= 2 && totals.every((a) => a === 0);
}

// The delivery method PhilGEPS shows for this tender on an order page ('Download', 'Pick-Up', ...)
export function deliveryMethodOf(html, ref) {
  const m = new RegExp(`${ref} .*?(Download|Pick-Up|Courier|E-?mail)`, 'i').exec(clean(parse(html).text));
  return m ? m[1] : null;
}

// On an order page, this tender's document links only (an order can include other tenders from the basket):
// postback links whose nearest surrounding element that names a tender reference number names only this one
export function itemLinksOf(html, ref) {
  const SKIP = /^(log-?out|pending task|my opportunities|help|contact us|sitemap|submit|previous|back|close|delete|continue|done|add more items|pay online|manual payment)$/i;
  return postbackLinks(html).filter(({ text, target, el }) => {
    if (!text || SKIP.test(text) || /LoginMenu/i.test(target)) return false;
    for (let node = el.parentNode; node && node.tagName; node = node.parentNode) {
      const refs = (node.text.match(/\b\d{8}\b/g) || []).filter((n) => n.slice(0, 2) === ref.slice(0, 2));
      if (refs.length) return refs.includes(ref) && new Set(refs).size === 1;
    }
    return false;
  });
}

// ---------- log-in / log-out ----------

// Logs in with the company account (PHILGEPS_USERNAME / PHILGEPS_PASSWORD). onSubmitted(session) runs right
// after the form is sent (before anything is checked), to save the cookies. trigger: 'person' | 'schedule'
// (loginGuard.mjs: a schedule waits longer after "account in use"). Throws LOGIN_PAUSED when the guard says no.
export async function login(session, onSubmitted, { trigger = 'person', source = 'server' } = {}) {
  const { PHILGEPS_USERNAME, PHILGEPS_PASSWORD } = process.env;
  if (!PHILGEPS_USERNAME || !PHILGEPS_PASSWORD) throw new PhilgepsSyncError('NOT_CONFIGURED', 'PHILGEPS_USERNAME / PHILGEPS_PASSWORD are not set on this server.');
  await checkLogin('philgeps', { trigger });
  await recordLogin('philgeps', 'started', { source });
  try {
    await sendLogin(session, onSubmitted, PHILGEPS_USERNAME, PHILGEPS_PASSWORD);
    await recordLogin('philgeps', 'ok', { source });
  } catch (e) {
    const outcome = e.code === 'ACCOUNT_BUSY' ? 'busy' : e.code === 'LOGIN_REJECTED' ? 'rejected' : 'error';
    await recordLogin('philgeps', outcome, { source, detail: e.message });
    throw e;
  }
}

async function sendLogin(session, onSubmitted, PHILGEPS_USERNAME, PHILGEPS_PASSWORD) {
  // PhilGEPS sometimes answers a fresh visitor with its error page (it flickers; the cookies of a failed try
  // make the next fail too), so each try starts with no cookies. A refused password is never sent again.
  let lastProblem = '';
  let posts = 0;
  for (let attempt = 1; attempt <= LOGIN_TRIES && posts < LOGIN_POSTS; attempt++) {
    session.jar.clear();
    let fields;
    try {
      const { res: pageRes } = await request(session, LOGIN_PAGE);
      ({ fields } = formFields(await pageRes.text(), LOGIN_PAGE));
    } catch (e) {
      lastProblem = e.message;
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    // Only the log-in answer itself: a redirect away from the log-in page means accepted. The page it
    // redirects to (Pending Task) counts every notice of the account and can take over a minute to build.
    let answer;
    posts++;
    try {
      answer = await request(session, LOGIN_ACTION, { method: 'POST', form: { ...fields, userName: PHILGEPS_USERNAME, password: PHILGEPS_PASSWORD }, follow: false, timeout: 40000, referer: LOGIN_PAGE });
    } catch (e) {
      lastProblem = e.message;
      continue;
    } finally {
      await onSubmitted(session);
    }
    const location = answer.res.headers.get('location') || '';
    const html = await answer.res.text();
    const said = alertsOf(html).join(' / ');
    if (/in use/i.test(said)) throw new PhilgepsSyncError('ACCOUNT_BUSY', 'The PhilGEPS account is logged in on another device or browser. Log out there, then Sync again.');
    if (/ErrorPage/i.test(location)) {
      lastProblem = 'PhilGEPS answered with its error page';
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const accepted = location ? !/log-in\.aspx/i.test(location) : /Log-?\s?out/i.test(html);
    if (accepted) return;
    // Refused: PhilGEPS sends the browser back to the log-in page, which pops up the reason ("The user id you
    // have provided is currently in use", a wrong password, ...). Open that page with the same cookies to read
    // it (no new log-in is sent).
    const reason = said || (location ? await refusalReason(session, new URL(location, LOGIN_ACTION).href) : '');
    if (/in use/i.test(reason)) throw new PhilgepsSyncError('ACCOUNT_BUSY', `The PhilGEPS account is logged in on another device or browser (PhilGEPS: "${reason}"). Log out there, then Sync again.`);
    throw new PhilgepsSyncError('LOGIN_REJECTED', `PhilGEPS did not accept the log-in${reason ? `: "${reason}"` : location ? ` (sent to ${location}, no reason given)` : '.'}`);
  }
  throw new PhilgepsSyncError('SITE_DOWN', `PhilGEPS did not let the log-in through (${lastProblem}). Try again in a few minutes.`);
}

// The message on the log-in page PhilGEPS sent a refused log-in back to: its alert() text, else a sentence
// about the account being in use or the password. '' when it shows none. Never throws.
async function refusalReason(session, url) {
  try {
    const { res } = await request(session, url, { timeout: 30000 });
    const html = await res.text();
    const alerts = alertsOf(html).join(' / ');
    if (alerts) return alerts;
    const text = clean(parse(html).text);
    return text.match(/[^.]*(?:in use|invalid|incorrect|locked|disabled|expired|not (?:found|registered|valid))[^.]*/i)?.[0].trim() || '';
  } catch {
    return '';
  }
}

// One GET with exactly these cookies; the answer's cookies are NOT kept. The log-out and its check must use the
// session's own cookies: following the log-out page to log-in.aspx hands out a fresh anonymous session, and a
// check made with that one always looks logged out, even when PhilGEPS still holds our session.
function fetchAs(cookie, url, headers = {}) {
  return fetch(url, { redirect: 'manual', headers: { cookie, 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(30000) });
}

// The account's user id while these cookies are logged in (PhilGEPS's own pages read it from
// responsewrite.aspx: "<user id>-<role>-<org>-..."), else null
async function loggedInUserId(cookie) {
  const res = await fetchAs(cookie, USER_DETAILS_URL);
  if (/ErrorPage/i.test(res.headers.get('location') || '')) throw new Error('PhilGEPS showed its error page');
  if (res.status !== 200) return null;
  return /^\s*(\d+)-\d+-/.exec(await res.text())?.[1] || null;
}

// Is the session closed? Both with the session's own cookies: no user id any more, and the members page
// answers with a redirect to the log-in page
async function isLoggedOut(session) {
  const cookie = session.header();
  if (await loggedInUserId(cookie)) return false;
  const res = await fetchAs(cookie, MEMBERS_URL);
  const location = res.headers.get('location') || '';
  if (/ErrorPage/i.test(location)) throw new Error('PhilGEPS showed its error page');
  return /log-in\.aspx/i.test(location) || (res.status === 200 && /id="userName"/.test(await res.text()));
}

// Logs out the way PhilGEPS's own Log-out button does (logOut() in its pages): first
// ClearPassPhraseCached for the user id (PhilGEPS's record of the logged-in user), then LogoutRedirect.aspx,
// and confirms it with the session's own cookies (5 tries, 5 s apart). Returns true when confirmed. Never throws.
export async function logout(session) {
  const cookie = session.header();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const userId = await loggedInUserId(cookie);
      if (userId) await fetchAs(cookie, CLEAR_LOCK_URL(userId), { accept: 'application/json', 'content-type': 'application/json;charset=utf-8' }).catch(() => {});
      await fetchAs(cookie, LOGOUT_URL).catch(() => {});
      if (await isLoggedOut(session)) return true;
    } catch {
      // PhilGEPS flickering: try again
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

// ---------- one tender ----------

// Downloads this tender's files from the order page in `page`; returns [{ name, title, size, path, order_no }]
async function downloadItems(session, supabase, page, ref, orderNo, trail) {
  if (/pick-?up/i.test(deliveryMethodOf(page.html, ref) || '')) {
    trail.push('delivery method: Pick-Up');
    return { files: [], pickUp: true };
  }
  const files = [];
  const seen = new Set();
  for (const link of itemLinksOf(page.html, ref)) {
    if (seen.has(link.text)) continue;
    seen.add(link.text);
    const { res } = await postBack(session, page, { target: link.target, argument: link.argument });
    const type = res.headers.get('content-type') || '';
    const disposition = res.headers.get('content-disposition') || '';
    if (/text\/html/i.test(type) && !/attachment/i.test(disposition)) {
      trail.push(`"${link.text}": PhilGEPS answered with a page, not a file`);
      await res.text();
      continue;
    }
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    const name = (star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : `${link.text}.pdf`).replace(/[<>:"/\\|?*]/g, '_');
    const body = Buffer.from(await res.arrayBuffer());
    const key = `${ref}/${storageName(name)}`;
    const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const { error } = await supabase.storage.from(BUCKET).upload(key, body, { contentType: TYPES[ext] || type.split(';')[0] || 'application/octet-stream', upsert: true });
    if (error) {
      trail.push(`"${name}": upload failed (${error.message})`);
      continue;
    }
    trail.push(`downloaded "${name}" (${body.length} bytes)`);
    files.push({ name, title: link.text, size: body.length, path: key, order_no: orderNo || null });
  }
  return { files, pickUp: false };
}

// Already-ordered route: null when PhilGEPS lists no order for this tender
async function fromOrdered(session, supabase, ref, trail, step) {
  const list = await getPage(session, ORDERED_URL(ref));
  // The grid links each order number more than once: open every order once
  const orders = postbackLinks(list.html)
    .filter((l) => /dgOrderDoc/.test(l.target) && /^\d+$/.test(l.text))
    .filter((l, i, all) => all.findIndex((o) => o.text === l.text) === i);
  trail.push(`orders: ${orders.map((o) => o.text).join(', ') || 'none'}`);
  if (!orders.length) return null;
  step(40);
  const files = [];
  let pickUp = false;
  for (const order of orders) {
    const page = await getPage(session, ORDER_URL(order.text, ref));
    const got = await downloadItems(session, supabase, page, ref, order.text, trail);
    files.push(...got.files);
    pickUp ||= got.pickUp;
  }
  return { files, pickUp, orderNos: orders.map((o) => o.text) };
}

// Not-ordered route: returns { status: 'ordered' | 'already-ordered' | 'closed' | 'needs-payment' |
// 'no-order-link' | 'order-flow-changed', page?, orderNo?, said? }
async function placeOrder(session, ref, trail, step) {
  const notice = await getPage(session, NOTICE_URL(ref));
  const order = postbackLinks(notice.html).find((l) => /lbtnNosOfAssoc/.test(l.target));
  if (!order) return { status: 'no-order-link' };
  step(30);
  const after = await postBack(session, notice, { target: order.target });
  const afterHtml = await after.res.text();
  const said = alertsOf(afterHtml);
  if (said.some((m) => /already ordered/i.test(m))) return { status: 'already-ordered' };
  if (said.some((m) => /notice is closed/i.test(m))) return { status: 'closed', said: said.join(' / ') };

  // The tender is now in the basket (PhilGEPS's basket screen only lists it); open the basket form
  step(45);
  let page = await getPage(session, BASKET_URL);
  if (!/OrderBasketUI/i.test(page.url) || !page.html.includes(ref)) return { status: 'order-flow-changed', said: 'The tender did not appear in the order basket.' };
  if (!allAmountsZero(page.html)) return { status: 'needs-payment' };
  step(60);
  let next = await postBack(session, page, { button: buttonOf(page.html, 'btnCont') });
  page = { html: await next.res.text(), url: next.url };

  // Notice for tenders closing within 5 days: go on (any other warning stops)
  if (/WarningUI/i.test(page.url)) {
    if (!/calendar days or less remaining/i.test(clean(parse(page.html).text)) || !buttonOf(page.html, 'btnContinueOrder')) {
      return { status: 'order-flow-changed', said: clean(parse(page.html).text).slice(0, 200) };
    }
    next = await postBack(session, page, { button: buttonOf(page.html, 'btnContinueOrder') });
    page = { html: await next.res.text(), url: next.url };
  }
  if (!/OrderConfirmationUI/i.test(page.url)) return { status: 'order-flow-changed', said: `Unexpected page: ${page.url}` };
  if (!allAmountsZero(page.html)) return { status: 'needs-payment' };
  step(75);
  next = await postBack(session, page, { button: buttonOf(page.html, 'btnSubmit') });
  page = { html: await next.res.text(), url: next.url };
  const orderNo = /OrderID=(\d+)/i.exec(page.url)?.[1];
  if (!orderNo) return { status: 'order-flow-changed', said: `No order number after Submit (${page.url})` };
  trail.push(`ordered: order ${orderNo}`);
  return { status: 'ordered', page, orderNo };
}

function remarkFor({ status, files, ordered, orderNos, said }) {
  const orders = orderNos.length ? ` (order ${orderNos.join(', ')})` : '';
  const how = ordered ? `Ordered by the system on PhilGEPS (free)${orders}` : `Already ordered on PhilGEPS${orders}`;
  const philgepsSaid = said ? ` PhilGEPS said: "${said}"` : '';
  switch (status) {
    case 'downloaded':
      return `${how}; ${files} file${files === 1 ? '' : 's'} downloaded${ordered ? '' : ' from My Opportunities'}.`;
    case 'pick-up':
      return `${how}, but PhilGEPS lists the delivery method as Pick-Up: the procuring entity hands out these bid documents in person, so there is no file to download.`;
    case 'closed':
      return 'PhilGEPS said: "Tender Bid Notice is closed." Bidding has ended, so the documents can no longer be ordered.';
    case 'needs-payment':
      return 'The PhilGEPS order basket shows a fee, so the system did not order (it never pays). Order it on PhilGEPS by hand if the documents are needed.';
    case 'no-order-link':
      return 'The PhilGEPS notice has no Order link, so there are no documents to order yet. Sync checks again next time.';
    case 'order-flow-changed':
      return `PhilGEPS showed an unexpected page while ordering, so the system stopped for this tender.${philgepsSaid} Sync tries again next time.`;
    default:
      return `${how}, but no download link for this tender was found on the order page. Sync tries again next time.`;
  }
}

export async function fetchTender(session, supabase, o, step) {
  const ref = o.ref_no;
  const trail = [];
  let files = [];
  let status = null;
  let ordered = false;
  let orderNos = [];
  let said = null;
  step(10);
  const done = await fromOrdered(session, supabase, ref, trail, step);
  if (done) {
    files = done.files;
    orderNos = done.orderNos;
    if (done.pickUp && !files.length) status = 'pick-up';
  } else {
    const result = await placeOrder(session, ref, trail, step);
    said = result.said || null;
    if (result.status === 'ordered') {
      ordered = true;
      orderNos = [result.orderNo];
      step(85);
      const got = await downloadItems(session, supabase, result.page, ref, result.orderNo, trail);
      files = got.files;
      if (got.pickUp && !files.length) status = 'pick-up';
    } else if (result.status === 'already-ordered') {
      const again = await fromOrdered(session, supabase, ref, trail, step);
      files = again?.files || [];
      orderNos = again?.orderNos || [];
      if (again?.pickUp && !files.length) status = 'pick-up';
    } else {
      status = result.status;
    }
  }
  status ||= files.length ? 'downloaded' : 'none-found';
  const now = new Date().toISOString();
  const documents = files.map((f) => ({ ...f, source: 'order', downloaded_at: now }));
  return { documents, status, ordered, remark: remarkFor({ status, files: documents.length, ordered, orderNos, said }), trail };
}

// ---------- which tenders ----------

// Same rule as documents.js needsDocuments (with recheckEmpty, as Sync does)
export function needsDocuments(o, now = Date.now()) {
  const d = o.details || {};
  if (o.closing_date && Date.parse(String(o.closing_date).replace(' ', 'T').replace(/(\+\d\d:\d\d|Z)?$/, (z) => z || '+08:00')) < now) return false;
  if (!d.documents_checked_at) return true;
  if ((d.supplements?.length || 0) > (d.documents_supplements_seen || 0)) return true;
  if (d.documents?.length || d.documents_status === 'pick-up' || d.documents_status === 'closed') return false;
  return true;
}
export { RECHECK_MS };

// The Sync orders (₱0.00) and reads the documents of every open tender: a description's item list can leave out
// lines the documents have (user, 2026-10-26: order all). These go first: those asking for our products, those
// naming one of our molecules without our dosage (the documents may give it), and those whose description has
// no item list (our products can only be in the documents).
export function wantsDocuments(o) {
  return (
    (o.matched_molecules || []).length > 0 ||
    (o.details?.named_without_dosage || []).length > 0 ||
    (o.items_text || '').length < DESCRIPTION_ITEMS_MIN
  );
}

// listKey: the product list's fingerprint (matcher.key), so a changed product list reads the documents again
const readKey = (documents, listKey = '') => `${READ_RULES}|${listKey}|${(documents || []).map((d) => `${d.path}:${d.size}`).sort().join('|')}`;

// Downloaded documents not read yet (or changed since, or scanned and not read with OCR yet): no PhilGEPS log-in needed
export const needsReading = (o, listKey) =>
  (o.details?.documents || []).some((d) => d.path) && (o.details?.documents_read_key !== readKey(o.details.documents, listKey) || ocrPending(o.details?.documents_read));

// Reads a tender's downloaded documents (PDF, Word, Excel) for our products and returns the details fields
// to store, plus matched_molecules (description matches with today's list + products found in the documents)
/** PhilGEPS tenders with the Screened ones first (user, 2026-10-27: the ones the team bids on), else in their order */
export async function screenedFirst(supabase, tenders) {
  const { data } = await supabase.from('screened_tenders').select('ref').neq('source', 'ps');
  const isScreened = new Set((data || []).map((s) => String(s.ref)));
  return [...tenders].sort((a, b) => Number(isScreened.has(String(b.ref_no))) - Number(isScreened.has(String(a.ref_no))));
}

export async function readTenderDocuments(supabase, matchProducts, o, details) {
  const outcome = await readDocuments(supabase, BUCKET, details.documents, matchProducts);
  const items = outcome.result?.items || [];
  const products = [...new Set(items.flatMap((i) => i.our_products))];
  // A tender bought as one package or lot isn't ours to bid on: no molecules (lib/packageTender.js)
  const packaged = isPackageTender(o.items_text, outcome.result?.package);
  return {
    matched_molecules: packaged ? [] : [...new Set([...matchProducts(`${o.title || ''}\n${o.items_text || ''}`), ...products])],
    details: {
      ...details,
      package: outcome.result?.package || undefined,
      documents_products: packaged ? [] : products,
      documents_items: items.slice(0, 300),
      // Lines naming our products outside any table: not shown, kept for checking (psDocs.mjs isTableRow)
      documents_outside_table: outcome.result?.outside_table || [],
      documents_read: outcome.read,
      documents_read_note: outcome.status === 'done' ? null : outcome.error,
      // Pre-bid, bid opening, submission deadline, ... as written in the documents (the notice page has no schedule)
      documents_bid_data_sheet: outcome.result?.bid_data_sheet || null,
      documents_read_key: readKey(details.documents, matchProducts.key),
    },
  };
}

// ---------- status (philgeps_sync_relay.job, read by every dashboard) ----------

async function readJob(supabase) {
  const { data } = await supabase.from('philgeps_sync_relay').select('job, updated_at').eq('id', 'latest').maybeSingle();
  return data || {};
}

async function saveJob(supabase, job) {
  const { error } = await supabase.from('philgeps_sync_relay').upsert({ id: 'latest', job, updated_at: new Date().toISOString() });
  if (error) throw new PhilgepsSyncError('DB', `Saving the Sync progress: ${error.message}`);
}

// Marks a Sync as started unless one is running (its progress moved within STALE_RUN_MS).
// Returns { started } ; started false = already running.
export async function claimSync(by) {
  const supabase = admin();
  const current = await readJob(supabase);
  const running = current.job?.kind === 'sync' && current.job.status === 'running' && Date.now() - Date.parse(current.updated_at) < STALE_RUN_MS;
  if (running) return { started: false };
  await saveJob(supabase, { kind: 'sync', status: 'running', percent: 0, stage: 'Starting', startedAt: Date.now(), finishedAt: null, startedBy: by || null, round: 0 });
  return { started: true };
}

// The finished Sync on the History page: how many tenders ended in each state
function logRun(job) {
  const counts = {};
  for (const state of Object.values(job.tenders || {})) counts[state] = (counts[state] || 0) + 1;
  const failed = job.status === 'failed';
  return logActivity({
    event: 'documents',
    status: failed ? 'failed' : 'success',
    by: job.startedBy,
    summary: failed ? job.error : job.stage,
    details: { duration_ms: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null, tenders: job.total || 0, files: job.files || 0, found_in_documents: job.foundInDocuments || 0, counts, errors: job.tenderErrors || null },
  });
}

// The Sync's core is: log in, order and download, log out. Everything added around it (reading documents for
// our products, History, ...) runs through optional(): a failure there is noted on the Sync (job.addonErrors)
// and skipped, and never stops the Sync, its saving or its log-out. New add-ons go through it too.
export async function optional(job, label, fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    (job.addonErrors ??= []).push(`${label}: ${e.message}`.slice(0, 200));
    console.error(`[philgeps-sync] ${label} skipped: ${e.message}`);
    return fallback;
  }
}

// ---------- the Sync (one round) ----------

// Runs one round of the Sync (claimSync first). Returns { more } : true when tenders are left for another round.
export async function runSyncRound() {
  const supabase = admin();
  const { job: claimed } = await readJob(supabase);
  const job = { ...claimed, round: (claimed?.round || 0) + 1 };
  const save = () => saveJob(supabase, job).catch(() => {});
  const roundStarted = Date.now();
  let session = new Session();
  let loginSent = false;
  let more = false;
  try {
    const { data, error } = await supabase.from('philgeps_opportunities').select('ref_no, title, publish_date, closing_date, matched_molecules, items_text, details');
    if (error) throw new PhilgepsSyncError('DB', error.message);
    // Without the product list the documents are still downloaded, just not read
    const matchProducts = await optional(job, 'Loading our product list', () => loadMatcher());

    // Documents already downloaded but not read for our products yet: read them first (no log-in)
    if (job.round === 1 && matchProducts) {
      await optional(job, 'Reading downloaded documents', async () => {
        const unread = await screenedFirst(supabase, data.filter((o) => needsReading(o, matchProducts.key)));
        for (const [i, o] of unread.entries()) {
          if (Date.now() - roundStarted > ROUND_MS / 2) break;
          job.stage = `Reading downloaded documents for our products (${i + 1} of ${unread.length})`;
          await save();
          const update = await readTenderDocuments(supabase, matchProducts, o, o.details).catch(() => null);
          if (!update) continue;
          await supabase.from('philgeps_opportunities').update(update).eq('ref_no', o.ref_no);
          Object.assign(o, update);
        }
      });
    }
    // Every open tender; the likeliest to be ours first (wantsDocuments), then the dashboard's default order:
    // newest published first, then highest reference number
    let pending = data
      .filter((o) => needsDocuments(o))
      .sort(
        (a, b) =>
          Number(wantsDocuments(b)) - Number(wantsDocuments(a)) ||
          (b.publish_date || '').localeCompare(a.publish_date || '') ||
          (b.ref_no || '').localeCompare(a.ref_no || '')
      );
    // Later rounds: only this Sync's tenders not tried yet (a tender that failed isn't retried in the same Sync)
    if (job.round > 1) pending = pending.filter((o) => job.tenders?.[o.ref_no] === 'waiting');
    if (job.round === 1) {
      job.total = pending.length;
      job.tenders = Object.fromEntries(pending.map((o) => [o.ref_no, 'waiting']));
      job.tenderPercent = {};
      job.files = 0;
    }
    if (!pending.length) {
      Object.assign(job, { status: 'success', percent: 100, stage: job.files ? `${job.files} new documents` : 'Everything is up to date — no new documents', finishedAt: Date.now() });
      await save();
      await optional(job, 'History', () => logRun(job));
      return { more: false };
    }

    // Later rounds continue in the log-in of the first (one log-in per Sync); a new log-in only if it ended
    const saved = job.round > 1 ? (await supabase.from('philgeps_session').select('cookies, logged_out_at').eq('id', 'current').maybeSingle()).data : null;
    if (saved?.cookies?.length && !saved.logged_out_at) {
      session = new Session(saved.cookies);
      loginSent = true;
      if (await isLoggedOut(session).catch(() => false)) {
        await markLoggedOut(supabase);
        session = new Session();
        loginSent = false;
      }
    }
    if (!loginSent) {
      job.stage = 'Logging in to PhilGEPS';
      await save();
      await login(
        session,
        async (s) => {
          loginSent = true;
          await supabase.from('philgeps_session').upsert({ id: 'current', cookies: s.cookies(), saved_at: new Date().toISOString(), logged_out_at: null });
        },
        { trigger: job.startedBy === 'schedule' ? 'schedule' : 'person' }
      );
    }

    let done = Object.values(job.tenders).filter((state) => state !== 'waiting').length;
    for (const o of pending) {
      if (Date.now() - roundStarted > ROUND_MS) break;
      job.tenders[o.ref_no] = 'working';
      job.tenderPercent[o.ref_no] = 0;
      job.stage = `Downloading documents (${done + 1} of ${job.total} tenders)`;
      await save();
      let result;
      try {
        result = await fetchTender(session, supabase, o, (p) => {
          job.tenderPercent[o.ref_no] = p;
        });
      } catch (e) {
        if (e.code === 'SESSION_ENDED' || e.code === 'SITE_DOWN') throw e;
        job.tenders[o.ref_no] = 'failed';
        (job.tenderErrors ??= {})[o.ref_no] = e.message;
        done++;
        continue;
      }
      const previous = o.details?.documents || [];
      // One entry per stored file (the same file may come from more than one order)
      result.documents = result.documents.filter((d, i, all) => all.findIndex((x) => x.path === d.path) === i);
      const names = new Set(result.documents.map((d) => d.name));
      let details = {
        ...(o.details || {}),
        documents: [...previous.filter((d) => !names.has(d.name)), ...result.documents],
        documents_status: previous.length || result.documents.length ? 'downloaded' : result.status,
        documents_remark: result.remark,
        documents_checked_at: new Date().toISOString(),
        documents_supplements_seen: o.details?.supplements?.length || 0,
      };
      // Our products are often only in the documents: read them now (PDF, Word, Excel)
      let matched = o.matched_molecules || [];
      if (matchProducts && needsReading({ details }, matchProducts.key)) {
        job.stage = `Reading the documents of ${o.ref_no} for our products`;
        await save();
        const update = await optional(job, `Reading the documents of ${o.ref_no}`, () => readTenderDocuments(supabase, matchProducts, o, details));
        if (update) ({ details, matched_molecules: matched } = update);
      }
      if (matched.length > (o.matched_molecules || []).length) job.foundInDocuments = (job.foundInDocuments || 0) + 1;
      await supabase.from('philgeps_opportunities').update({ details, matched_molecules: matched }).eq('ref_no', o.ref_no);
      job.tenders[o.ref_no] = details.documents_status;
      job.tenderPercent[o.ref_no] = 100;
      job.files += result.documents.length;
      done++;
      job.percent = Math.round((95 * done) / Math.max(job.total, 1));
      await save();
    }
    more = done < job.total;
    job.stage = more ? `Continuing (${done} of ${job.total} tenders done)` : 'Logging out of PhilGEPS';
    // The next round reuses this log-in: keep the newest cookies for it
    if (more) await supabase.from('philgeps_session').upsert({ id: 'current', cookies: session.cookies(), saved_at: new Date().toISOString(), logged_out_at: null });
    await save();
    return { more, done };
  } catch (e) {
    const message =
      ['ACCOUNT_BUSY', 'LOGIN_REJECTED', 'LOGIN_PAUSED', 'NOT_CONFIGURED', 'SITE_DOWN', 'SESSION_ENDED'].includes(e.code)
        ? e.message
        : `Sync stopped: ${e.message}`;
    Object.assign(job, { status: 'failed', error: message, finishedAt: Date.now() });
    for (const ref of Object.keys(job.tenders || {})) if (['waiting', 'working'].includes(job.tenders[ref])) job.tenders[ref] = 'not-reached';
    await save();
    await optional(job, 'History', () => logRun(job));
    return { more: false, failed: true };
  } finally {
    // The log-out runs whatever happened above; nothing in here may throw
    if (loginSent && !more) {
      const loggedOut = await logout(session);
      if (loggedOut) await optional(job, 'Recording the log-out', () => markLoggedOut(supabase));
      else {
        job.warning = 'The PhilGEPS log-out could not be confirmed; the 5-minute clean-up keeps trying.';
        await save();
      }
    }
  }
}

// Ends a running Sync as failed with `message` (e.g. its next round could not be started), so the dashboard
// shows the error at once instead of a Sync that looks busy until it goes stale
export async function failSync(message) {
  try {
    const supabase = admin();
    const { job } = await readJob(supabase);
    if (!job || job.status !== 'running') return;
    for (const ref of Object.keys(job.tenders || {})) if (['waiting', 'working'].includes(job.tenders[ref])) job.tenders[ref] = 'not-reached';
    Object.assign(job, { status: 'failed', error: message, finishedAt: Date.now() });
    await saveJob(supabase, job);
    await optional(job, 'History', () => logRun(job));
  } catch (e) {
    console.error(`[philgeps-sync] could not record the failure: ${e.message}`);
  }
}

// Tender outcomes that mean the Sync did not get the documents, as they read in the Sync warning
const PROBLEM_OUTCOMES = {
  failed: 'failed',
  'not-reached': 'not reached in time',
  'order-flow-changed': 'stopped (PhilGEPS order page changed)',
  'needs-payment': 'need a payment (order them by hand)',
  'no-order-link': 'have no Order link on PhilGEPS yet',
  ordered: 'ordered but no file found yet',
  'already-ordered': 'ordered but no file found yet',
};

// Marks the Sync finished after its last round
export async function finishSync() {
  const supabase = admin();
  const { job } = await readJob(supabase);
  if (!job || job.status !== 'running') return;
  for (const ref of Object.keys(job.tenders || {})) if (['waiting', 'working'].includes(job.tenders[ref])) job.tenders[ref] = 'not-reached';
  // Tenders whose documents this Sync could not get: never report those as "up to date". The warning shows as
  // "Synced with a warning" on the dashboard (ScrapeProgress) and goes to the History / Report Log.
  const problems = {};
  for (const outcome of Object.values(job.tenders || {})) {
    if (PROBLEM_OUTCOMES[outcome]) problems[outcome] = (problems[outcome] || 0) + 1;
  }
  const problemCount = Object.values(problems).reduce((a, b) => a + b, 0);
  if (problemCount) {
    const detail = Object.entries(problems).map(([outcome, n]) => `${n} ${PROBLEM_OUTCOMES[outcome]}`).join(', ');
    const message = `${problemCount} tender${problemCount > 1 ? 's' : ''} without documents this Sync (${detail}). Sync again, or check them on PhilGEPS.`;
    job.warning = job.warning ? `${job.warning} ${message}` : message;
  }
  Object.assign(job, {
    status: 'success',
    percent: 100,
    stage:
      (job.files ? `${job.files} new document${job.files > 1 ? 's' : ''}` : problemCount ? 'No new documents' : 'Everything is up to date — no new documents') +
      (job.foundInDocuments ? ` · ${job.foundInDocuments} more tender${job.foundInDocuments > 1 ? 's' : ''} with our products found in the documents` : ''),
    finishedAt: Date.now(),
  });
  await saveJob(supabase, job);
  await optional(job, 'History', () => logRun(job));
  // Scanned documents this Sync read without OCR: read them now on GitHub (ocrTrigger.mjs; never throws)
  await triggerOcr('philgeps-sync');
}

// ---------- 5-minute clean-up ----------

// A confirmed log-out keeps the cookies (RECHECK_AFTER_LOGOUT_MS) for the clean-up's re-check
function markLoggedOut(supabase) {
  return supabase.from('philgeps_session').update({ logged_out_at: new Date().toISOString() }).eq('id', 'current');
}

// Logs out a PhilGEPS session left behind: a cut-off round, or a Sync whose progress hasn't moved for
// SESSION_IDLE_MS (a running Sync saves progress every tender). A session already logged out is checked again
// with its own cookies for RECHECK_AFTER_LOGOUT_MS (logged out again if PhilGEPS still has it), then forgotten.
// Never throws.
export async function sweepSession() {
  try {
    const supabase = admin();
    const { data } = await supabase.from('philgeps_session').select('cookies, saved_at, logged_out_at').eq('id', 'current').maybeSingle();
    if (!data?.cookies?.length) return { open: false };
    if (data.logged_out_at) {
      if (Date.now() - Date.parse(data.logged_out_at) > RECHECK_AFTER_LOGOUT_MS) {
        await supabase.from('philgeps_session').delete().eq('id', 'current');
        return { open: false, forgotten: true };
      }
      const session = new Session(data.cookies);
      if (await isLoggedOut(session)) return { open: false, rechecked: true };
      // PhilGEPS still has the session although its log-out was confirmed: log out again
      const loggedOut = await logout(session);
      return { open: !loggedOut, reopened: true, loggedOut };
    }
    const current = await readJob(supabase);
    const busy = current.job?.status === 'running' && Date.now() - Math.max(Date.parse(current.updated_at), Date.parse(data.saved_at)) < SESSION_IDLE_MS;
    if (busy) return { open: true, skipped: 'sync running' };
    return { open: !(await closeSession()), loggedOut: true };
  } catch (e) {
    return { error: e.message };
  }
}

// Logs out the saved session now (the next round could not be started). Returns true when confirmed. Never throws.
export async function closeSession() {
  try {
    const supabase = admin();
    const { data } = await supabase.from('philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
    if (!data?.cookies?.length) return true;
    const loggedOut = await logout(new Session(data.cookies));
    if (loggedOut) await markLoggedOut(supabase);
    return loggedOut;
  } catch {
    return false;
  }
}
