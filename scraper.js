require('dotenv').config({ quiet: true });
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { matchMolecules, matchItemLines } = require('./molecules');
const { extractSchedule } = require('./schedule');
const { withPhilgepsSession, hasCredentials } = require('./philgeps-session');
const { needsDocuments, fetchDocuments } = require('./documents');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Public (no-login) PhilGEPS pages live under /GEPSNONPILOT/. The /GEPS/ equivalents redirect to log-in.aspx.
const OPEN_OPPORTUNITIES_URL = 'https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3';
const CATEGORY_NAME = 'Drugs and Medicines';
const MAX_PAGES = 60; // ~20 rows per page; safety cap in case the pager never ends
const DETAIL_CONCURRENCY = 4; // detail pages opened in parallel
// Public list of a tender's bid bulletins/addenda. The files themselves need a PhilGEPS log-in, so only the list is read.
const SUPPLEMENTS_URL = (ref) =>
    `https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashBidSupplementsListUI.aspx?menuIndex=3&directFrom=BidAbstract&refID=${ref}`;

// node scraper.js --dry-run: first results page only, no database reads or writes, prints matches
const DRY_RUN = process.argv.includes('--dry-run');
// Supplement lists checked less than this long ago are reused, so a Refresh shortly after another run is quick.
// node scraper.js --full re-checks every tender.
const SUPPLEMENTS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const FULL_RUN = process.argv.includes('--full');
// node scraper.js --progress (set by /api/scrape): print "PROGRESS {percent, stage}" lines for the dashboard's progress ring
const REPORT_PROGRESS = process.argv.includes('--progress');
const ROWS_PER_PAGE = 20;
// node scraper.js --no-login: public data only, no PhilGEPS log-in for documents (hourly automatic fetch)
const NO_LOGIN = process.argv.includes('--no-login');
// node scraper.js --documents-only: the dashboard's Sync. Logs in for the screened tenders' documents only
// (the public list is the automatic fetch's job) and fails if the account can't be used.
const DOCUMENTS_ONLY = process.argv.includes('--documents-only');
// Tries to open the first PhilGEPS page (it flickers to a redirect loop for new visitors)
const OPEN_TRIES = 8;

// Per-tender Sync state for the dashboard's rolling number circles: "TENDERS {queue | current | finished}" lines
function tenderEvent(event) {
    if (REPORT_PROGRESS) console.log(`TENDERS ${JSON.stringify(event)}`);
}

// Warnings are shown in the ring after the run (e.g. documents skipped because the account is in use)
const warnings = [];
function progress(percent, stage, warning) {
    if (warning) warnings.push(warning);
    if (REPORT_PROGRESS) {
        console.log(`PROGRESS ${JSON.stringify({ percent: Math.round(percent), stage, ...(warnings.length && { warning: warnings.join(' · ') }) })}`);
    }
}

// Read the item list (Description + Line Items), ABC and notice details from a tender's
// Bid Notice Abstract page. Returns null for closed/error pages so the tender is retried on the next run.
async function fetchDetails(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return page.evaluate(() => {
        const text = document.body.innerText;
        if (!text.includes('Bid Notice Abstract')) return null;
        const start = text.search(/\n\s*Description\s*\n/);
        const end = text.search(/\n\s*Created by/);
        const items = start >= 0 ? text.slice(start, end > start ? end : undefined) : '';
        const abc = /Approved Budget for the Contract:\s*PHP\s*([\d,]+(?:\.\d+)?)/.exec(text);

        // Header rows are "Label:<tab>value" (or "Label<tab>value" for the boxed fields)
        const field = (label) => {
            const m = new RegExp(`${label}:?\\t([^\\n]*)`).exec(text);
            return m ? m[1].replace('Printable Version', '').trim() || null : null;
        };
        const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
        const afterTitle = lines(text.slice(text.indexOf('Bid Notice Abstract') + 'Bid Notice Abstract'.length));
        // Contact block: name, designation, address, phones, email; ends at the Status box
        const contact = /Contact Person:\t([\s\S]*?)\n\s*Status/.exec(text);
        const contactLines = contact ? lines(contact[1]) : [];
        const status = /\tStatus\t\s*\n+\s*([^\n]+)/.exec(text);

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
                last_updated: field('Last Updated / Time')
            }
        };
    });
}

// Bid supplements (bulletins, addenda) listed for a tender: [{ no, title, type, published }]
async function fetchSupplements(page, ref) {
    await page.goto(SUPPLEMENTS_URL(ref), { waitUntil: 'domcontentloaded', timeout: 45000 });
    const rows = await page.evaluate(() => {
        const header = Array.from(document.querySelectorAll('tr'))
            .find((tr) => tr.cells.length >= 4 && /Bid Supplement No\./.test(tr.cells[0].innerText));
        if (!header) return [];
        const table = header.closest('table');
        return Array.from(table.rows)
            .slice(Array.from(table.rows).indexOf(header) + 1)
            .map((tr) => Array.from(tr.cells).map((td) => td.innerText.trim()))
            .filter((cells) => cells.length >= 4 && cells[0]);
    });
    return rows.map(([no, title, type, published]) => ({ no, title, type, published: toIsoDate(published) }));
}

// "7 1000 bottle Cetirizine 5mg/5ml, 60ml SYRUP 113.98 113,980.00" -> columns.
// Item lists aren't uniform across agencies, so lines that don't fit keep only the raw text.
function parseItemLine({ line, products }) {
    const parsed = parseItemColumns({ line, products });
    if (parsed.unit_price != null) return parsed;

    // Any other layout ending in "<unit price> <total>": accept the pair only when a quantity in the line
    // times the unit price gives the total, e.g. "500 TABLET Amlodipine 5 mg Tablet 2 1,000.00"
    const num = (s) => Number(s.replace(/,/g, ''));
    const tail = /^(.*\S)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})$/.exec(line);
    if (!tail) return parsed;
    const [, rest, priceText, totalText] = tail;
    const unitPrice = num(priceText);
    const total = num(totalText);
    const quantity = (rest.match(/\d[\d,]*/g) || []).map(num).find((q) => q > 0 && Math.abs(q * unitPrice - total) <= total * 0.01);
    if (quantity == null) return parsed;
    const base = parseItemColumns({ line: rest, products });
    return {
        ...base,
        line,
        description: base.description || rest,
        quantity: base.quantity ?? quantity,
        unit_price: unitPrice,
        total
    };
}

function parseItemColumns({ line, products }) {
    const num = (s) => Number(s.replace(/,/g, ''));
    // Item numbers come as "7", "21." or "3.)"
    const ITEM = String.raw`(\d+)[.)]*`;
    const UNIT = String.raw`([A-Za-z][A-Za-z.'’]*)`;
    const QTY = String.raw`([\d,]+(?:\.\d+)?)`;
    const PRICE = String.raw`([\d,]+\.\d{2})`;
    // Item | Quantity | Unit | Description | Unit Price | Total
    const priced = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+?)\\s+${PRICE}\\s+${PRICE}$`).exec(line);
    if (priced) {
        return {
            line,
            products,
            item_no: priced[1],
            quantity: num(priced[2]),
            unit: priced[3],
            description: priced[4],
            unit_price: num(priced[5]),
            total: num(priced[6])
        };
    }
    // Item | Quantity | Unit | Description, e.g. "21. 5000 TAB LOSARTAN 100 MG"
    const qtyFirst = new RegExp(`^${ITEM}\\s+${QTY}\\s+${UNIT}\\s+(.+)$`).exec(line);
    if (qtyFirst) {
        return { line, products, item_no: qtyFirst[1], quantity: num(qtyFirst[2]), unit: qtyFirst[3], description: qtyFirst[4] };
    }
    // Item | Description | Quantity | Unit (RFQs without prices), e.g. "9 MIDAZOLAM 5MG/ML AMPULE 10’S 40 BX"
    // (a strength or volume like "60 ml" at the end is part of the description, not a quantity)
    const qtyLast = new RegExp(`^${ITEM}\\s+(.+?)\\s+([\\d,]+)\\s+(?!(?:mg|ml|mcg|g|kg|l|iu|units?|%)\\.?$)([A-Za-z]{1,12}\\.?)$`, 'i').exec(line);
    if (qtyLast) {
        return { line, products, item_no: qtyLast[1], description: qtyLast[2], quantity: num(qtyLast[3]), unit: qtyLast[4] };
    }
    // The remaining layouts have no fixed column order, so their unit must be a known one; otherwise
    // "1 BUPIVACAINE ..." would read as quantity 1 of unit "BUPIVACAINE" and "500 mg" as 500 of unit "mg".
    const KNOWN_UNIT = String.raw`((?:tab|tablet|cap|capsule|bottle|btl|botl|bot|vial|vl|amp|ampule|ampoule|box|bx|pc|piece|pack|sachet|tube|inhaler|nebule|syringe|bag|kit|set|unit|each|ea)(?:e?s)?\.?(?:\s?\/\s?(?:vial|amp|bottle|bot)s?)?)`;
    // Item | Description | Quantity | Unit | Unit Price | Total, e.g. "6 Propofol, Inj: 10mg/ml, 20ml 120 amps 390.00 46,800.00"
    const descPriced = new RegExp(`^${ITEM}\\s+(.+?)\\s+${QTY}\\s+${KNOWN_UNIT}\\s+${PRICE}\\s+${PRICE}$`, 'i').exec(line);
    if (descPriced) {
        return {
            line,
            products,
            item_no: descPriced[1],
            description: descPriced[2],
            quantity: num(descPriced[3]),
            unit: descPriced[4],
            unit_price: num(descPriced[5]),
            total: num(descPriced[6])
        };
    }
    // Quantity | Unit | Description with no item number, e.g. "2,325 tab Amlodipine Besilate 10mg tab"
    const noItem = new RegExp(`^${QTY}\\s+${KNOWN_UNIT}\\s+(.+)$`, 'i').exec(line);
    if (noItem) {
        return { line, products, quantity: num(noItem[1]), unit: noItem[2], description: noItem[3] };
    }
    // Description | Quantity | Unit with no item number, e.g. "Cetirizine 10mg tab 200 box"
    const descNoItem = new RegExp(`^(.*[A-Za-z].*?)\\s+([\\d,]+)\\s+${KNOWN_UNIT}$`, 'i').exec(line);
    if (descNoItem) {
        return { line, products, description: descNoItem[1], quantity: num(descNoItem[2]), unit: descNoItem[3] };
    }
    return { line, products };
}

// Run fn over items with a few browser tabs in parallel
async function withPages(browser, items, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, async () => {
        const page = await browser.newPage();
        for (let item = queue.shift(); item; item = queue.shift()) await fn(page, item);
        await page.close();
    }));
}

// Details already stored for these refs, so each tender's page is only opened once.
// Every ref already in the database is added to `existing`, so the run can tell which tenders are new.
async function loadStoredDetails(refs, existing) {
    const stored = new Map();
    for (let i = 0; i < refs.length; i += 200) {
        const { data, error } = await supabase
            .from('philgeps_opportunities')
            .select('ref_no, items_text, abc_amount, details')
            .in('ref_no', refs.slice(i, i + 200));
        if (error) throw new Error(`Supabase Database Error: ${error.message}`);
        for (const row of data) existing.add(row.ref_no);
        // Rows saved before details were captured get their page read once more
        for (const row of data) if (row.items_text != null && row.details != null) stored.set(row.ref_no, row);
    }
    return stored;
}

// Click an ASP.NET postback link and wait for the resulting page load
async function postBack(page, clickFn, arg) {
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }),
        page.evaluate(clickFn, arg)
    ]);
}

// Returns the report for the History page: { status: 'done' | 'skipped' | 'failed', reason?, code?, checked, files, logged_out }.
// Progress runs from `start` to `end` percent. pending: the tenders to check (default: those needsDocuments picks).
async function fetchDocumentsLoggedIn(browser, matched, { start = 83, end = 94, pending = matched.filter((o) => needsDocuments(o)) } = {}) {
    if (NO_LOGIN || DRY_RUN) return { status: 'skipped', reason: 'log-in turned off for this run' };
    if (!hasCredentials()) return { status: 'skipped', reason: 'PhilGEPS log-in not set up (.env)' };
    if (pending.length === 0) return { status: 'done', checked: 0, files: 0 };

    console.log(`Fetching documents of ${pending.length} screened tenders (logged in)...`);
    tenderEvent({ queue: pending.map((o) => o.ref_no) });
    progress(start, 'Logging in to PhilGEPS');
    const session = {};
    try {
        const report = await withPhilgepsSession(browser, (page, { deadline }) =>
            fetchDocuments(page, pending, {
                deadline,
                onStart: (o) => tenderEvent({ current: o.ref_no }),
                // Saved per tender, so the dashboard shows each result at once and an interrupted run keeps them
                onDone: async (o, status, error) => {
                    if (status) await saveTenderDetails(o);
                    tenderEvent({ finished: o.ref_no, status: status || 'failed', ...(error && { error }) });
                },
                onStep: (o, percent) => tenderEvent({ step: o.ref_no, percent }),
                onProgress: (done, total) => progress(start + 1 + (end - start - 1) * done / total, `Downloading documents (${done} of ${total} tenders)`)
            }), session);
        progress(end, 'Logged out of PhilGEPS');
        return { status: 'done', ...report, logged_out: session.loggedOut };
    } catch (err) {
        // Documents wait for the next run; the tenders keep the documents found earlier
        console.warn(`Documents skipped: ${err.message}`);
        // Sync reports this as its error instead of a warning
        if (!DOCUMENTS_ONLY) progress(end, session.loggedIn ? 'Logged out of PhilGEPS' : 'Documents skipped', `Documents not fetched: ${err.message}`);
        return {
            status: err.code === 'ACCOUNT_BUSY' || err.code === 'LOCKED' ? 'skipped' : 'failed',
            reason: err.message,
            code: err.code,
            logged_out: session.loggedOut
        };
    }
}

// One tender's details (documents and their status) right after its documents were fetched.
// A failed save only costs the early update: the end of the run saves again.
async function saveTenderDetails(o) {
    if (DRY_RUN) return;
    const { error } = await supabase.from('philgeps_opportunities').update({ details: o.details }).eq('ref_no', o.ref_no);
    if (error) console.warn(`Could not save documents of ${o.ref_no}: ${error.message}`);
}

// What the History page shows of a tender
function summarize(o) {
    return { ref_no: o.ref_no, title: o.title, procuring_entity: o.procuring_entity, matched_molecules: o.matched_molecules };
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

// One entry on the dashboard's History page. A missing activity_log table (schema.sql not run yet)
// only costs the entry, never the run.
async function logActivity(entry) {
    const { error } = await supabase.from('activity_log').insert({ event: 'scrape', ...entry });
    if (error) console.warn(`Could not write to activity_log: ${error.message}`);
}

// Sync: documents of the screened open tenders, from the database. Every tender without documents is
// re-checked (someone clicked Sync for a reason), plus never-checked ones and ones with new supplements.
// Throws when the log-in can't be used, so the dashboard shows Sync as failed.
async function runDocumentsOnly() {
    progress(3, 'Loading screened tenders');
    const { data, error } = await supabase
        .from('philgeps_opportunities')
        .select('ref_no, title, procuring_entity, publish_date, closing_date, matched_molecules, details')
        .not('matched_molecules', 'eq', '{}');
    if (error) throw new Error(`Supabase Database Error: ${error.message}`);
    // The dashboard's default order (newest published first, then highest reference number), so the
    // number circles fill 1, 2, 3...
    const pending = data.filter((o) => needsDocuments(o, { recheckEmpty: true }))
        .sort((a, b) => (b.publish_date || '').localeCompare(a.publish_date || '') || (b.ref_no || '').localeCompare(a.ref_no || ''));
    console.log(`${pending.length} of ${data.length} screened tenders need a document check.`);
    if (pending.length === 0) {
        progress(100, 'Everything is up to date — no new documents');
        return { documents: { status: 'done', checked: 0, files: 0 } };
    }
    if (!hasCredentials()) throw new Error('PhilGEPS log-in is not set up (PHILGEPS_USERNAME / PHILGEPS_PASSWORD in .env)');

    console.log('Launching browser worker...');
    const browser = await puppeteer.launch({ headless: true });
    let documents;
    try {
        documents = await fetchDocumentsLoggedIn(browser, data, { start: 8, end: 92, pending });
    } finally {
        await browser.close();
    }
    if (documents.logged_out === false) {
        throw new Error('The PhilGEPS log-out could not be confirmed. The watchdog keeps trying; you can also log in and out once by hand.');
    }
    if (documents.status !== 'done') {
        throw new Error(documents.code === 'ACCOUNT_BUSY'
            ? 'The PhilGEPS account is logged in on another device or browser. Log out there, then Sync again.'
            : documents.code === 'LOCKED'
                ? 'Another fetch is logged in to PhilGEPS right now. Sync again when it finishes.'
                : `Documents not fetched: ${documents.reason}`);
    }

    progress(95, 'Saving documents');
    for (const o of pending) {
        const { error: saveError } = await supabase.from('philgeps_opportunities').update({ details: o.details }).eq('ref_no', o.ref_no);
        if (saveError) throw new Error(`Supabase Database Error: ${saveError.message}`);
    }
    if (documents.unchecked) {
        progress(96, 'Saved', `PhilGEPS session time limit reached; ${documents.unchecked} tenders wait for the next Sync`);
    }
    const withFiles = pending.filter((o) => o.details?.documents_status === 'downloaded').length;
    progress(100, documents.files
        ? `${documents.files} new document${documents.files > 1 ? 's' : ''} for ${withFiles} tender${withFiles > 1 ? 's' : ''}`
        : 'Everything is up to date — no new documents');
    return { documents };
}

// trigger: who started the run ('dashboard', 'schedule' or 'manual'), shown on the History page
async function scrapeAndStore({ trigger = 'manual' } = {}) {
    const startedAt = Date.now();
    try {
        if (DOCUMENTS_ONLY) {
            const { documents } = await runDocumentsOnly();
            await logActivity({
                status: 'success',
                trigger,
                summary: documents.checked
                    ? `Sync: documents checked for ${documents.checked} tenders (${documents.files} files, ${documents.ordered || 0} new orders)`
                    : 'Sync: all screened tenders already checked',
                details: { documents, duration_ms: Date.now() - startedAt }
            });
            return;
        }
        const stats = await runScrape();
        if (DRY_RUN) return;
        const parts = [`${stats.found} tenders screened`, `${stats.matched} mention our products`];
        if (stats.new_tenders) parts.push(`${stats.new_tenders} new`);
        if (stats.new_matched.length) parts.push(`${stats.new_matched.length} new matching`);
        if (stats.new_supplements.length) parts.push(`${stats.new_supplements.length} with new bid supplements`);
        const docs = stats.documents;
        if (docs.status === 'done' && docs.checked) parts.push(`documents checked for ${docs.checked} tenders (${docs.files} files)`);
        else if (docs.status !== 'done') parts.push(`documents ${docs.status}: ${docs.reason}`);
        await logActivity({
            status: 'success',
            trigger,
            summary: parts.join(', '),
            details: { ...stats, duration_ms: Date.now() - startedAt }
        });
    } catch (err) {
        if (!DRY_RUN) {
            await logActivity({ status: 'failed', trigger, summary: err.message, details: { duration_ms: Date.now() - startedAt } });
        }
        throw err;
    }
}

// Returns the numbers for the History page: tenders found, matching, new, and which tenders changed
async function runScrape() {
    console.log('Launching browser worker...');
    progress(2, 'Starting browser');
    // Keep Chrome's sandbox on: the scraper loads third-party pages
    const browser = await puppeteer.launch({ headless: true });

    try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // STEP 1: Open the public category list (also establishes the ASP.NET session)
    console.log('Opening PhilGEPS open opportunities (public)...');
    progress(4, 'Opening PhilGEPS');
    // A network error here means PhilGEPS itself is down (e.g. its error page redirecting to itself), not our code.
    // It flickers: without cookies the page opens ~2 times in 3, but the cookies a failed load leaves
    // behind make every retry fail too (measured 2026-10-21), so each retry starts with no cookies.
    for (let attempt = 1; ; attempt++) {
        try {
            if (attempt > 1) {
                const cookies = await page.cookies(OPEN_OPPORTUNITIES_URL);
                if (cookies.length) await page.deleteCookie(...cookies);
            }
            await page.goto(OPEN_OPPORTUNITIES_URL, { waitUntil: 'networkidle2', timeout: 45000 });
            break;
        } catch (err) {
            if (attempt >= OPEN_TRIES) throw new Error(`PhilGEPS is not responding right now, try again later (${err.message.split(' at ')[0]})`);
            console.warn(`PhilGEPS did not open (${err.message.split(' at ')[0]}); retrying in 3 s`);
            progress(4, `Connecting to PhilGEPS (try ${attempt + 1} of ${OPEN_TRIES})`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }

    // STEP 2: Category list is paged alphabetically: click "D", then the count link for Drugs and Medicines
    console.log(`Navigating to ${CATEGORY_NAME} category...`);
    progress(6, `Opening ${CATEGORY_NAME}`);
    await postBack(page, () => __doPostBack('pgCtrlOpp$dLB', ''));
    // The category's count link ("543") tells how many results pages to expect
    const tenderCount = await page.evaluate((name) => {
        const row = Array.from(document.querySelectorAll('tr'))
            .find(tr => tr.cells.length === 3 && tr.cells[1].innerText.trim() === name);
        return row?.querySelector('a') ? Number(row.querySelector('a').innerText.replace(/\D/g, '')) || null : null;
    }, CATEGORY_NAME);
    const expectedPages = tenderCount ? Math.ceil(tenderCount / ROWS_PER_PAGE) : null;
    await postBack(page, (name) => {
        const row = Array.from(document.querySelectorAll('tr'))
            .find(tr => tr.cells.length === 3 && tr.cells[1].innerText.trim() === name);
        if (!row) throw new Error(`Category "${name}" not found on PhilGEPS category list`);
        row.querySelector('a').click();
    }, CATEGORY_NAME);

    // STEP 3: Extract every results page
    const byRef = new Map();
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
        const { rows, hasNext, url } = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('a[href*="refID="]')).map(a => {
                const cells = Array.from(a.closest('tr').cells).map(td => td.innerText.trim().replace(/\s+/g, ' '));
                return { href: a.href, refId: new URL(a.href).searchParams.get('refID'), cells };
            });
            const hasNext = Array.from(document.querySelectorAll('a'))
                .some(a => (a.getAttribute('href') || '').includes('nextLB'));
            return { rows, hasNext, url: location.href };
        });

        // Guard: never store junk from a log-in or error page
        if (pageNo === 1 && rows.length === 0) {
            throw new Error(`No tender rows found — PhilGEPS returned ${url} (log-in/error page or layout change)`);
        }

        for (const { href, refId, cells } of rows) {
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
                items_text: null, // filled from the detail page
                abc_amount: null,
                details: null
            });
        }
        console.log(`Page ${pageNo}: ${rows.length} rows (total ${byRef.size})`);
        // Results pages: 10% to 40%
        progress(10 + 30 * Math.min(1, pageNo / (expectedPages || pageNo + 1)),
            `Reading tender list (page ${pageNo}${expectedPages ? ` of ${expectedPages}` : ''})`);

        // PhilGEPS flickered to its error page mid-list: keep what was read, and say the list is incomplete
        if (/ErrorPage/i.test(url)) {
            console.warn(`PhilGEPS showed its error page at results page ${pageNo}`);
            progress(40, 'Tender list incomplete', `PhilGEPS stopped responding at page ${pageNo}${expectedPages ? ` of ${expectedPages}` : ''}; the tender list may be incomplete`);
            break;
        }
        if (!hasNext || DRY_RUN) break;
        await postBack(page, () => __doPostBack('pgCtrlDetailedSearch$nextLB', ''));
    }

    // Deduped by ref_no, so one upsert never touches the same row twice.
    // status is omitted so re-scrapes don't reset a status changed by the team (new rows get the 'NEW' default).
    const opportunities = Array.from(byRef.values());
    console.log(`Found ${opportunities.length} opportunities on PhilGEPS.`);

    // STEP 4: Open the detail page of each tender not seen before to read its item list
    const existing = new Set();
    const stored = DRY_RUN ? new Map() : await loadStoredDetails(opportunities.map((o) => o.ref_no), existing);
    const pending = opportunities.filter((o) => !stored.has(o.ref_no));
    console.log(`Reading item lists of ${pending.length} new tenders...`);
    // Detail pages: 40% to 65%
    let detailsRead = 0;
    progress(40, `Reading item lists (0 of ${pending.length} new tenders)`);
    await withPages(browser, pending, async (detailPage, o) => {
        try {
            Object.assign(o, await fetchDetails(detailPage, o.detail_link));
        } catch (err) {
            console.warn(`Could not read ${o.ref_no}: ${err.message}`);
        }
        detailsRead++;
        progress(40 + 25 * detailsRead / pending.length, `Reading item lists (${detailsRead} of ${pending.length} new tenders)`);
    });

    // STEP 5: Flag tenders that mention our products (re-matched every run so molecules.json edits apply to old rows)
    // and keep only the item lines that request them, plus the pre-bid / bid opening schedule for the export
    for (const o of opportunities) {
        const known = stored.get(o.ref_no);
        if (known) Object.assign(o, { items_text: known.items_text, abc_amount: known.abc_amount, details: known.details });
        o.matched_molecules = matchMolecules(`${o.title}\n${o.items_text || ''}`);
        if (o.details) {
            o.details = {
                ...o.details,
                matched_items: matchItemLines(o.items_text).map(parseItemLine),
                ...extractSchedule(o.items_text)
            };
        }
    }
    const matched = opportunities.filter((o) => o.matched_molecules.length > 0);
    console.log(`${matched.length} of ${opportunities.length} tenders mention our products.`);

    // STEP 6: Bid supplements of the tenders we show, re-read since agencies add bulletins until closing,
    // except lists checked within SUPPLEMENTS_MAX_AGE_MS. A failed read keeps the list from the previous run.
    const checkedBefore = Date.now() - SUPPLEMENTS_MAX_AGE_MS;
    const staleSupplements = matched.filter((o) =>
        FULL_RUN || !(Date.parse(o.details?.supplements_checked_at) > checkedBefore));
    console.log(`Reading bid supplements of ${staleSupplements.length} matching tenders (${matched.length - staleSupplements.length} checked recently)...`);
    // Supplement lists: 67% to 82%
    let supplementsRead = 0;
    progress(67, `Checking bid supplements (0 of ${staleSupplements.length})`);
    const newSupplements = [];
    await withPages(browser, staleSupplements, async (supplementsPage, o) => {
        try {
            const before = o.details?.supplements?.length || 0;
            o.details = {
                ...(o.details || {}),
                supplements: await fetchSupplements(supplementsPage, o.ref_no),
                supplements_checked_at: new Date().toISOString()
            };
            // Only tenders seen before: a new tender's supplements are part of it being new
            const added = o.details.supplements.length - before;
            if (added > 0 && existing.has(o.ref_no)) newSupplements.push({ ...summarize(o), added });
        } catch (err) {
            console.warn(`Could not read supplements of ${o.ref_no}: ${err.message}`);
        }
        supplementsRead++;
        progress(67 + 15 * supplementsRead / staleSupplements.length, `Checking bid supplements (${supplementsRead} of ${staleSupplements.length})`);
    });

    // STEP 6b: Documents of the screened tenders, in one short logged-in session (log-out always confirmed).
    // A session that can't be opened (account in use, no credentials) skips documents; the public data is still saved.
    const documents = await fetchDocumentsLoggedIn(browser, matched);

    if (DRY_RUN) {
        for (const o of matched) {
            console.log(`  ${o.ref_no} ${o.procuring_entity}: ${o.matched_molecules.join(', ')}`);
            for (const item of o.details?.matched_items || []) console.log(`      ${item.item_no ? '' : '(unparsed) '}${item.line}`);
            for (const s of o.details?.supplements || []) console.log(`      supplement ${s.no}: ${s.title} (${s.type}, ${s.published})`);
        }
        if (matched[0]) console.log('Sample details:', JSON.stringify(matched[0].details, null, 2));
        return;
    }

    // STEP 7: Upload to Supabase PostgreSQL
    if (opportunities.length > 0) {
        console.log('Saving records to Supabase PostgreSQL...');
        progress(95, 'Saving to database');
        const { data, error } = await supabase
            .from('philgeps_opportunities')
            .upsert(opportunities, { onConflict: 'ref_no' });

        if (error) {
            // Throw so callers (cron.js, /api/scrape) see the run as failed
            throw new Error(`Supabase Database Error: ${error.message}`);
        }
        console.log('Successfully saved records directly to Supabase!');
    }

    // The data is saved; now make the run fail loudly if the PhilGEPS session may still be open
    if (documents.logged_out === false) {
        throw new Error('Saved, but the PhilGEPS log-out could not be confirmed. Run "node philgeps-session.js --logout" or log in and out once by hand.');
    }

    return {
        found: opportunities.length,
        matched: matched.length,
        new_tenders: opportunities.filter((o) => !existing.has(o.ref_no)).length,
        new_matched: matched.filter((o) => !existing.has(o.ref_no)).map(summarize),
        new_supplements: newSupplements,
        documents
    };
    } finally {
        // Always release Chrome, even if navigation or extraction throws
        await browser.close();
    }
}

// Same check the dashboard makes before Refresh: PhilGEPS down redirects to its error page. It flickers
// between working and down, so it only counts as down when 3 tries 2 s apart all fail.
// Returns null when the site answers normally, else the reason.
async function philgepsDownReason() {
    let reason = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(OPEN_OPPORTUNITIES_URL, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
            if (/ErrorPage|log-in\.aspx/i.test(res.headers.get('location') || '')) reason = 'PhilGEPS is showing its error page';
            else if (res.status >= 500) reason = `PhilGEPS answered with server error ${res.status}`;
            else return null;
        } catch (err) {
            reason = `PhilGEPS could not be reached (${err.message})`;
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return reason;
}

module.exports = { scrapeAndStore, philgepsDownReason };

// Run immediately only when executed directly (node scraper.js), not when required by cron.js
if (require.main === module) {
    // node scraper.js --trigger=dashboard (set by /api/scrape)
    const trigger = (process.argv.find((a) => a.startsWith('--trigger=')) || '').slice('--trigger='.length) || 'manual';
    scrapeAndStore({ trigger }).catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
