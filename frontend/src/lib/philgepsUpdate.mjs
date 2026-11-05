import { createClient } from '@supabase/supabase-js';
import { parse } from 'node-html-parser';
import { Session, getPage, postBack, postbackLinks } from './philgepsSync.mjs';
import { expandVariants, isVariantParent, loadMatcher, parseItemRow, rowAhead, withBothAmounts } from './psDocs.mjs';
import { extractSchedule } from './schedule.mjs';
import { logActivity } from './activityLog.mjs';
import { isPackageTender } from './packageTender.js';

// The hourly public PhilGEPS update (6 AM–5 PM) on the deployed server, without a browser: the same steps as
// scraper.js runScrape on the office PC (which this replaces), sent as the pages' own ASP.NET posts:
// open the public Open Opportunities list → "D" → Drugs and Medicines → every results page, read the notice
// page of each tender not seen before (description, ABC, contact, ...), match our products, re-read the bid
// supplement lists of our tenders, save to philgeps_opportunities and log the run on the History page.
// No log-in: these pages are public. Progress goes to philgeps_update (read by every dashboard).

const HOST = 'https://notices.philgeps.gov.ph';
const OPEN_OPPORTUNITIES_URL = `${HOST}/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3`;
const SUPPLEMENTS_URL = (ref) => `${HOST}/GEPSNONPILOT/Tender/SplashBidSupplementsListUI.aspx?menuIndex=3&directFrom=BidAbstract&refID=${ref}`;
const CATEGORY_NAME = 'Drugs and Medicines';
const MAX_PAGES = 60;
const OPEN_TRIES = 8;
const AT_ONCE = 4;
const SUPPLEMENTS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// The host stops a request at 300 s: stop starting new notice / supplement reads after this, and save
const WORK_UNTIL_MS = 230 * 1000;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY (secret key) are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

// The page's text as a browser's innerText gives it (what scraper.js reads): table cells end in a tab,
// rows and blocks in a line break, and the source's own line breaks and indentation collapse to one space
export function pageText(html) {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<\/(tr|p|div|li|h\d|table)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[  ]+/g, ' ')
    .replace(/ ?\t ?/g, '\t')
    // A browser puts a tab between cells, not after a row's last one
    .replace(/\t+(?=\n|$)/g, '')
    .replace(/ *\n */g, '\n');
}

// "20/10/2026" -> "2026-10-20"
function toIsoDate(dmy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(dmy || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// "23/10/2026 01:00 PM" -> "2026-10-23 13:00:00" (Philippine local time, column is TIMESTAMP without zone)
function toTimestamp(dmyTime) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(dmyTime || '');
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') hour += 12;
  return `${m[3]}-${m[2]}-${m[1]} ${String(hour).padStart(2, '0')}:${m[5]}:00`;
}

// Same fields as scraper.js fetchDetails, from a Bid Notice Abstract page. null for a closed or error page.
export function readNotice(html) {
  const text = pageText(html);
  if (!text.includes('Bid Notice Abstract')) return null;
  const start = text.search(/\n\s*Description\s*\n/);
  const end = text.search(/\n\s*Created by/);
  const items = start >= 0 ? text.slice(start, end > start ? end : undefined) : '';
  const abc = /Approved Budget for the Contract:\s*PHP\s*([\d,]+(?:\.\d+)?)/.exec(text);
  const field = (label) => {
    const m = new RegExp(`${label}:?\\t([^\\n]*)`).exec(text);
    return m ? m[1].replace('Printable Version', '').trim() || null : null;
  };
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const afterTitle = lines(text.slice(text.indexOf('Bid Notice Abstract') + 'Bid Notice Abstract'.length));
  const contact = /Contact Person:\t([\s\S]*?)\n\s*Status/.exec(text);
  const contactLines = contact ? lines(contact[1].replace(/\t/g, '\n')) : [];
  const status = /Status\t\s*([^\n\t]+)/.exec(text);
  return {
    items_text: items.replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim(),
    abc_amount: abc ? Number(abc[1].replace(/,/g, '')) : null,
    details: {
      notice_type: afterTitle[0] || null,
      solicitation_no: field('Solicitation Number'),
      procurement_mode: field('Procurement Mode'),
      classification: field('Classification'),
      area_of_delivery: field('Area of Delivery'),
      delivery_period: field('Delivery Period'),
      client_agency: field('Client Agency'),
      contact_name: contactLines[0] || null,
      contact_info: contactLines.slice(1),
      status: status ? status[1].trim() : null,
      last_updated: field('Last Updated / Time'),
    },
  };
}

// Bid supplements listed for a tender: [{ no, title, type, published }]
function readSupplements(html) {
  const cellsOf = (tr) => tr.querySelectorAll('td, th');
  const rows = parse(html).querySelectorAll('tr');
  const header = rows.find((tr) => cellsOf(tr).length >= 4 && /Bid Supplement No\./.test(cellsOf(tr)[0].text));
  if (!header) return [];
  const tableRows = header.closest('table').querySelectorAll('tr');
  return tableRows
    .slice(tableRows.indexOf(header) + 1)
    .map((tr) => tr.querySelectorAll('td').map((td) => decode(td.text).replace(/\s+/g, ' ').trim()))
    // (the list's own header row is read again from a nested table: "Bid Supplement No. | Title | Type")
    .filter((cells) => cells.length >= 4 && /^\d{8}-\d{1,3}$/.test(cells[0]))
    .map(([no, title, type, published]) => ({ no, title, type, published: toIsoDate(published) }));
}

// Runs fn over items, AT_ONCE at a time, while there is time left
async function eachWhileTime(items, deadline, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let item = queue.shift(); item && Date.now() < deadline; item = queue.shift()) await fn(item);
    })
  );
}

// ---------- status (philgeps_sync_relay row 'update', next to the Sync's row 'latest') ----------

async function saveStatus(supabase, job) {
  await supabase
    .from('philgeps_sync_relay')
    .upsert({ id: 'update', job, updated_at: new Date().toISOString() })
    .then(
      () => {},
      () => {}
    );
}

// ---------- the update ----------

// The public tender list of Drugs and Medicines. complete: false when PhilGEPS stopped answering part-way
// (what was read is still saved).
export async function readTenderList(onPage) {
  // PhilGEPS flickers for new visitors; the cookies of a failed try make the next fail too, so each try is fresh
  let session;
  let page;
  for (let attempt = 1; ; attempt++) {
    session = new Session();
    try {
      page = await getPage(session, OPEN_OPPORTUNITIES_URL);
      break;
    } catch (e) {
      if (attempt >= OPEN_TRIES) throw new Error(`PhilGEPS is not responding right now, try again later (${e.message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const open = async (step) => {
    const { res, url } = await step;
    return { html: await res.text(), url };
  };
  // Categories are paged alphabetically: "D", then the category's count link
  page = await open(postBack(session, page, { target: 'pgCtrlOpp$dLB' }));
  const categoryLink = postbackLinks(page.html).find(({ el }) => {
    const row = el.closest('tr');
    return row && row.querySelectorAll('td').some((td) => decode(td.text).trim() === CATEGORY_NAME);
  });
  if (!categoryLink) throw new Error(`Category "${CATEGORY_NAME}" not found on the PhilGEPS category list`);
  const expectedPages = Math.ceil((Number(categoryLink.text.replace(/\D/g, '')) || 0) / 20) || null;
  page = await open(postBack(session, page, { target: categoryLink.target, argument: categoryLink.argument }));

  const byRef = new Map();
  let complete = true;
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const links = parse(page.html)
      .querySelectorAll('a')
      .filter((a) => /refID=/i.test(a.getAttribute('href') || ''));
    if (pageNo === 1 && !links.length) throw new Error(`No tender rows found — PhilGEPS returned ${page.url} (error page or layout change)`);
    for (const a of links) {
      const href = new URL(decode(a.getAttribute('href')), page.url).href;
      const refId = new URL(href).searchParams.get('refID');
      const cells = (a.closest('tr')?.querySelectorAll('td') || []).map((td) => decode(td.text).replace(/\s+/g, ' ').trim());
      // cells: [#, Publish, Closing, "Title, Drugs and Medicines, Procuring Entity"]
      const [, publish, closing, combined = ''] = cells;
      const marker = `, ${CATEGORY_NAME}, `;
      const split = combined.lastIndexOf(marker);
      byRef.set(refId, {
        ref_no: refId,
        publish_date: toIsoDate(publish),
        closing_date: toTimestamp(closing),
        title: split >= 0 ? combined.slice(0, split) : combined,
        procuring_entity: split >= 0 ? combined.slice(split + marker.length) : null,
        category: CATEGORY_NAME,
        detail_link: href,
      });
    }
    await onPage(pageNo, expectedPages, byRef.size);
    if (!postbackLinks(page.html).some((l) => /nextLB/.test(l.target))) break;
    try {
      page = await open(postBack(session, page, { target: 'pgCtrlDetailedSearch$nextLB' }));
    } catch {
      // PhilGEPS flickered to its error page mid-list: keep what was read
      complete = false;
      break;
    }
  }
  return { tenders: [...byRef.values()], complete, expectedPages };
}

// The document fields the Sync owns (philgepsSync.mjs): always kept from the newest copy
function documentFields(details) {
  if (!details) return {};
  return Object.fromEntries(Object.entries(details).filter(([key]) => key.startsWith('documents')));
}

// One public update. by: 'schedule' or a person's email. Returns the History numbers.
export async function runPublicUpdate({ by = 'schedule' } = {}) {
  const supabase = admin();
  const started = Date.now();
  const deadline = started + WORK_UNTIL_MS;
  const job = { status: 'running', percent: 2, stage: 'Opening PhilGEPS', startedAt: started, startedBy: by, finishedAt: null };
  await saveStatus(supabase, job);
  try {
    const matchProducts = await loadMatcher();
    // Products found in the documents count only while still on the list (archived ones drop out at once;
    // the documents are read again at the next Sync, philgepsSync readKey)
    const onList = (names) => (names || []).filter((name) => matchProducts.names.includes(name));

    // 1. The tender list: 5% to 40%
    const { tenders, complete, expectedPages } = await readTenderList(async (pageNo, pages, count) => {
      Object.assign(job, { percent: 5 + 35 * Math.min(1, pageNo / (pages || pageNo + 1)), stage: `Reading tender list (page ${pageNo}${pages ? ` of ${pages}` : ''}, ${count} tenders)` });
      await saveStatus(supabase, job);
    });

    // 2. What is stored already (each notice page is read once)
    const stored = new Map();
    for (let i = 0; i < tenders.length; i += 200) {
      const { data, error } = await supabase
        .from('philgeps_opportunities')
        .select('ref_no, items_text, abc_amount, details')
        .in(
          'ref_no',
          tenders.slice(i, i + 200).map((t) => t.ref_no)
        );
      if (error) throw new Error(`Supabase: ${error.message}`);
      for (const row of data) stored.set(row.ref_no, row);
    }
    const known = (t) => stored.get(t.ref_no)?.items_text != null && stored.get(t.ref_no)?.details != null;

    // 3. Notice pages of new tenders: 40% to 65%
    const fresh = tenders.filter((t) => !known(t));
    let read = 0;
    await eachWhileTime(fresh, deadline, async (t) => {
      try {
        const notice = readNotice((await getPage(new Session(), t.detail_link)).html);
        if (notice) Object.assign(t, notice);
      } catch {
        // Read again next hour
      }
      read++;
      Object.assign(job, { percent: 40 + (25 * read) / fresh.length, stage: `Reading item lists (${read} of ${fresh.length} new tenders)` });
      await saveStatus(supabase, job);
    });

    // 4. Our products: our molecule in one of our dosages, in the description (products.mjs), plus what the Sync
    // found in the documents. A molecule named without our dosage (e.g. only in the title) is kept as
    // named_without_dosage, so the Sync orders the documents to check the dosage there.
    for (const t of tenders) {
      const s = stored.get(t.ref_no);
      if (t.items_text == null && s) Object.assign(t, { items_text: s.items_text, abc_amount: s.abc_amount, details: s.details });
      // Sub-rows of a molecule read as rows of their own (psDocs.mjs expandVariants)
      const raw = (t.items_text || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const lines = expandVariants(raw);
      const found = matchProducts.details(`${t.title}\n${lines.join('\n')}`);
      // None for a tender bought as one package or lot (lib/packageTender.js)
      t.matched_molecules = isPackageTender(t.items_text, t.details?.package) ? [] : [...new Set([...found.matched, ...onList(t.details?.documents_products)])];
      if (t.details) {
        t.details = {
          ...t.details,
          matched_items: lines.flatMap((line, i) => {
            if (isVariantParent(raw, i)) return [];
            const products = matchProducts.line(line, rowAhead(lines, i));
            return products.length ? [{ line, products, ...withBothAmounts(parseItemRow(lines, i)) }] : [];
          }),
          named_without_dosage: found.undosed.filter((name) => !t.matched_molecules.includes(name)),
          ...extractSchedule(t.items_text),
        };
      }
    }
    const matched = tenders.filter((t) => t.matched_molecules.length);

    // 5. Bid supplement lists of our tenders (agencies add bulletins until closing): 65% to 90%
    const checkedBefore = Date.now() - SUPPLEMENTS_MAX_AGE_MS;
    const stale = matched.filter((t) => t.details && !(Date.parse(t.details.supplements_checked_at) > checkedBefore));
    const newSupplements = [];
    let checked = 0;
    await eachWhileTime(stale, deadline, async (t) => {
      try {
        const before = t.details.supplements?.length || 0;
        const supplements = readSupplements((await getPage(new Session(), SUPPLEMENTS_URL(t.ref_no))).html);
        t.details = { ...t.details, supplements, supplements_checked_at: new Date().toISOString() };
        if (supplements.length > before && stored.has(t.ref_no)) {
          newSupplements.push({ ref_no: t.ref_no, title: t.title, procuring_entity: t.procuring_entity, matched_molecules: t.matched_molecules, added: supplements.length - before });
        }
      } catch {
        // Keeps the list from before
      }
      checked++;
      Object.assign(job, { percent: 65 + (25 * checked) / stale.length, stage: `Checking bid supplements (${checked} of ${stale.length})` });
      await saveStatus(supabase, job);
    });

    // 6. Save. The Sync may have written a tender's documents meanwhile: merge onto the newest details
    Object.assign(job, { percent: 92, stage: 'Saving' });
    await saveStatus(supabase, job);
    const current = new Map();
    for (let i = 0; i < tenders.length; i += 200) {
      const { data } = await supabase
        .from('philgeps_opportunities')
        .select('ref_no, details')
        .in(
          'ref_no',
          tenders.slice(i, i + 200).map((t) => t.ref_no)
        );
      for (const row of data || []) current.set(row.ref_no, row.details);
    }
    const rows = tenders.map((t) => {
      const now = current.get(t.ref_no);
      const details = t.details ? { ...(now || {}), ...t.details, ...documentFields(now) } : now || null;
      return {
        ref_no: t.ref_no,
        publish_date: t.publish_date,
        closing_date: t.closing_date,
        title: t.title,
        procuring_entity: t.procuring_entity,
        category: t.category,
        detail_link: t.detail_link,
        items_text: t.items_text ?? null,
        abc_amount: t.abc_amount ?? null,
        details,
        matched_molecules: isPackageTender(t.items_text, details?.package) ? [] : [...new Set([...t.matched_molecules, ...onList(details?.documents_products)])],
      };
    });
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('philgeps_opportunities').upsert(rows.slice(i, i + 200), { onConflict: 'ref_no' });
      if (error) throw new Error(`Supabase: ${error.message}`);
    }

    const summarize = (r) => ({ ref_no: r.ref_no, title: r.title, procuring_entity: r.procuring_entity, matched_molecules: r.matched_molecules });
    const stats = {
      found: tenders.length,
      matched: rows.filter((r) => r.matched_molecules.length).length,
      new_tenders: tenders.filter((t) => !stored.has(t.ref_no)).length,
      new_matched: rows.filter((r) => r.matched_molecules.length && !stored.has(r.ref_no)).map(summarize),
      new_supplements: newSupplements,
      duration_ms: Date.now() - started,
    };
    const unread = fresh.length - read;
    const parts = [`${stats.found} tenders screened`, `${stats.matched} mention our products`];
    if (stats.new_tenders) parts.push(`${stats.new_tenders} new`);
    if (stats.new_matched.length) parts.push(`${stats.new_matched.length} new matching`);
    if (newSupplements.length) parts.push(`${newSupplements.length} with new bid supplements`);
    if (!complete) parts.push(`PhilGEPS stopped answering part-way through the list${expectedPages ? ` of ${expectedPages} pages` : ''}`);
    if (unread) parts.push(`${unread} new tenders' item lists wait for the next update`);
    const summary = parts.join(', ');
    Object.assign(job, { status: 'success', percent: 100, stage: summary, finishedAt: Date.now() });
    await saveStatus(supabase, job);
    await logActivity({ event: 'scrape', status: 'success', by, summary, details: stats });
    return stats;
  } catch (e) {
    Object.assign(job, { status: 'failed', error: e.message, finishedAt: Date.now() });
    await saveStatus(supabase, job);
    await logActivity({ event: 'scrape', status: 'failed', by, summary: e.message, details: { duration_ms: Date.now() - started } });
    throw e;
  }
}
