require('dotenv').config({ quiet: true });
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Public (no-login) PhilGEPS pages live under /GEPSNONPILOT/. The /GEPS/ equivalents redirect to log-in.aspx.
const OPEN_OPPORTUNITIES_URL = 'https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3';
const CATEGORY_NAME = 'Drugs and Medicines';
const MAX_PAGES = 60; // ~20 rows per page; safety cap in case the pager never ends

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
                detail_link: href
            });
        }
        console.log(`Page ${pageNo}: ${rows.length} rows (total ${byRef.size})`);

        if (!hasNext) break;
        await postBack(page, () => __doPostBack('pgCtrlDetailedSearch$nextLB', ''));
    }

    // Deduped by ref_no, so one upsert never touches the same row twice.
    // status is omitted so re-scrapes don't reset a status changed by the team (new rows get the 'NEW' default).
    const opportunities = Array.from(byRef.values());
    console.log(`Found ${opportunities.length} opportunities on PhilGEPS.`);

    // STEP 4: Upload to Supabase PostgreSQL
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
