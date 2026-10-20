require('dotenv').config({ quiet: true });
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { matchMolecules } = require('./molecules');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Public (no-login) PhilGEPS pages live under /GEPSNONPILOT/. The /GEPS/ equivalents redirect to log-in.aspx.
const OPEN_OPPORTUNITIES_URL = 'https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3';
const CATEGORY_NAME = 'Drugs and Medicines';
const MAX_PAGES = 60; // ~20 rows per page; safety cap in case the pager never ends
const DETAIL_CONCURRENCY = 4; // detail pages opened in parallel

// node scraper.js --dry-run: first results page only, no database reads or writes, prints matches
const DRY_RUN = process.argv.includes('--dry-run');

// Read the item list (Description + Line Items) and ABC from a tender's Bid Notice Abstract page.
// Returns null for closed/error pages so the tender is retried on the next run.
async function fetchDetails(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return page.evaluate(() => {
        const text = document.body.innerText;
        if (!text.includes('Bid Notice Abstract')) return null;
        const start = text.search(/\n\s*Description\s*\n/);
        const end = text.search(/\n\s*Created by/);
        const items = start >= 0 ? text.slice(start, end > start ? end : undefined) : '';
        const abc = /Approved Budget for the Contract:\s*PHP\s*([\d,]+(?:\.\d+)?)/.exec(text);
        return {
            items_text: items.replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim(),
            abc_amount: abc ? Number(abc[1].replace(/,/g, '')) : null
        };
    });
}

// Details already stored for these refs, so each tender's page is only opened once
async function loadStoredDetails(refs) {
    const stored = new Map();
    for (let i = 0; i < refs.length; i += 200) {
        const { data, error } = await supabase
            .from('philgeps_opportunities')
            .select('ref_no, items_text, abc_amount')
            .in('ref_no', refs.slice(i, i + 200));
        if (error) throw new Error(`Supabase Database Error: ${error.message}`);
        for (const row of data) if (row.items_text != null) stored.set(row.ref_no, row);
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

async function scrapeAndStore() {
    console.log('Launching browser worker...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox']
    });

    try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // STEP 1: Open the public category list (also establishes the ASP.NET session)
    console.log('Opening PhilGEPS open opportunities (public)...');
    await page.goto(OPEN_OPPORTUNITIES_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // STEP 2: Category list is paged alphabetically: click "D", then the count link for Drugs and Medicines
    console.log(`Navigating to ${CATEGORY_NAME} category...`);
    await postBack(page, () => __doPostBack('pgCtrlOpp$dLB', ''));
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
                abc_amount: null
            });
        }
        console.log(`Page ${pageNo}: ${rows.length} rows (total ${byRef.size})`);

        if (!hasNext || DRY_RUN) break;
        await postBack(page, () => __doPostBack('pgCtrlDetailedSearch$nextLB', ''));
    }

    // Deduped by ref_no, so one upsert never touches the same row twice.
    // status is omitted so re-scrapes don't reset a status changed by the team (new rows get the 'NEW' default).
    const opportunities = Array.from(byRef.values());
    console.log(`Found ${opportunities.length} opportunities on PhilGEPS.`);

    // STEP 4: Open the detail page of each tender not seen before to read its item list
    const stored = DRY_RUN ? new Map() : await loadStoredDetails(opportunities.map((o) => o.ref_no));
    const pending = opportunities.filter((o) => !stored.has(o.ref_no));
    console.log(`Reading item lists of ${pending.length} new tenders...`);
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, async () => {
        const detailPage = await browser.newPage();
        for (let o = pending.shift(); o; o = pending.shift()) {
            try {
                Object.assign(o, await fetchDetails(detailPage, o.detail_link));
            } catch (err) {
                console.warn(`Could not read ${o.ref_no}: ${err.message}`);
            }
        }
        await detailPage.close();
    }));

    // STEP 5: Flag tenders that mention our products (re-matched every run so molecules.json edits apply to old rows)
    for (const o of opportunities) {
        const known = stored.get(o.ref_no);
        if (known) Object.assign(o, { items_text: known.items_text, abc_amount: known.abc_amount });
        o.matched_molecules = matchMolecules(`${o.title}\n${o.items_text || ''}`);
    }
    const matched = opportunities.filter((o) => o.matched_molecules.length > 0);
    console.log(`${matched.length} of ${opportunities.length} tenders mention our products.`);

    if (DRY_RUN) {
        for (const o of matched) console.log(`  ${o.ref_no} ${o.procuring_entity}: ${o.matched_molecules.join(', ')}`);
        return;
    }

    // STEP 6: Upload to Supabase PostgreSQL
    if (opportunities.length > 0) {
        console.log('Saving records to Supabase PostgreSQL...');
        const { data, error } = await supabase
            .from('philgeps_opportunities')
            .upsert(opportunities, { onConflict: 'ref_no' });

        if (error) {
            // Throw so callers (cron.js, /api/scrape) see the run as failed
            throw new Error(`Supabase Database Error: ${error.message}`);
        }
        console.log('Successfully saved records directly to Supabase!');
    }
    } finally {
        // Always release Chrome, even if navigation or extraction throws
        await browser.close();
    }
}

module.exports = { scrapeAndStore };

// Run immediately only when executed directly (node scraper.js), not when required by cron.js
if (require.main === module) {
    scrapeAndStore().catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
