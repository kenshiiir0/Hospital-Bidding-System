require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { openSession, HOST } = require('./ps-philgeps-session');
const { matchMolecules } = require('./molecules');
const { publish } = require('./tools/ps-publish');

// PS-PhilGEPS (philgeps.gov.ph) sync with the saved session (ps-philgeps-session.js):
// 1. Bid Match, My Opportunities and My Award Notices lists (every page),
// 2. each Bid Match notice: page text, our products mentioned (molecules.json), documents downloaded
//    from the notice's Documents list into documents/ps/<ref>/.
// Result: .ps-philgeps/latest.json, then published to Supabase (tools/ps-publish.js: table
// ps_philgeps_snapshot + Storage bucket ps-documents), which the dashboard's PS-PhilGEPS pages read. Every page opened is also
// saved under .ps-philgeps/captures/ so the parsing can be checked against the real layout.
// `--progress` prints "PROGRESS {percent, stage}" lines for the dashboard. Reads only: never clicks
// Accept / Refuse / Feedback or anything that changes data on PhilGEPS.

const STATE_DIR = path.join(__dirname, '.ps-philgeps');
const CAPTURES_DIR = path.join(STATE_DIR, 'captures');
const RESULT_FILE = path.join(STATE_DIR, 'latest.json');
const DOCS_DIR = path.join(__dirname, 'documents', 'ps');
const MAX_PAGES = 30;
const REPORT_PROGRESS = process.argv.includes('--progress');

const LISTS = [
    { key: 'bidMatch', label: 'Bid Match', url: `${HOST}/EventManagements/myBidMatch` },
    { key: 'opportunities', label: 'My Opportunities', url: `${HOST}/EventManagements/myOpportunities` },
    { key: 'awards', label: 'Award Notices', url: `${HOST}/EventManagements/myAwardNotices` }
];
const NOTICE_URL = (ref) => `${HOST}/tenders/viewBidNotice/${ref}`;

function progress(percent, stage) {
    if (REPORT_PROGRESS) console.log(`PROGRESS ${JSON.stringify({ percent: Math.round(percent), stage })}`);
    else console.log(`${Math.round(percent)}% ${stage}`);
}

function capture(name, html) {
    fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    fs.writeFileSync(path.join(CAPTURES_DIR, `${name}.html`), html);
}

async function goto(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/\/(Indexes|users)\/login/i.test(page.url())) {
        const e = new Error('The PS-PhilGEPS session has ended. Connect again.');
        e.code = 'NOT_CONNECTED';
        throw e;
    }
}

// The page's main data table: header texts and, per row, cell texts + the row's links
function readTable(page) {
    return page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const tables = [...document.querySelectorAll('table')];
        const table = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
        if (!table) return { headers: [], rows: [] };
        const headRow = table.querySelector('thead tr') || table.querySelector('tr');
        const headers = [...headRow.querySelectorAll('th, td')].map((c) => clean(c.innerText));
        const bodyRows = [...table.querySelectorAll('tbody tr')].filter((tr) => tr !== headRow);
        const rows = bodyRows
            .map((tr) => ({
                cells: [...tr.querySelectorAll('td')].map((td) => clean(td.innerText)),
                links: [...tr.querySelectorAll('a[href]')]
                    .map((a) => ({ text: clean(a.innerText), href: a.href }))
                    .filter((l) => l.href.startsWith('http'))
            }))
            .filter((r) => r.cells.length > 1);
        return { headers, rows };
    });
}

// Link to the next page of a list (CakePHP paginator: rel=next or the "next" item), or null
function nextPageUrl(page) {
    return page.evaluate(() => {
        const a =
            document.querySelector('a[rel="next"]') ||
            document.querySelector('.pagination .next a, li.next a') ||
            [...document.querySelectorAll('.pagination a, .paging a')].find((x) => /^(next|›|»|>)/i.test(x.innerText.trim()));
        return a && a.href && !a.href.startsWith('javascript') && a.href !== location.href ? a.href : null;
    });
}

async function readList(page, list, onPage) {
    const result = { label: list.label, headers: [], rows: [], pages: 0 };
    let url = list.url;
    const seen = new Set();
    while (url && !seen.has(url) && result.pages < MAX_PAGES) {
        seen.add(url);
        await goto(page, url);
        await page.waitForSelector('table', { timeout: 20000 }).catch(() => {});
        result.pages++;
        capture(`${list.key}-p${result.pages}`, await page.content());
        const { headers, rows } = await readTable(page);
        if (!result.headers.length) result.headers = headers;
        result.rows.push(...rows);
        onPage(result.pages);
        url = await nextPageUrl(page);
    }
    return result;
}

// The notice reference number of a list row: its first link to a notice page, else the first cell
function refOf(row) {
    const link = row.links.find((l) => /viewBidNotice\/(\d+)/.test(l.href));
    if (link) return link.href.match(/viewBidNotice\/(\d+)/)[1];
    return /^\d+$/.test(row.cells[0]) ? row.cells[0] : null;
}

async function downloadFile(page, url, dir) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/[<>:"/\\|?*]/g, '_');
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return { name, size: fs.statSync(file).size, url, existed: true };
    const cookies = (await page.cookies(url)).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(url, { headers: { cookie: cookies, 'user-agent': await page.browser().userAgent() } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    return { name, size: body.length, url };
}

async function readNotice(page, ref) {
    await goto(page, NOTICE_URL(ref));
    capture(`notice-${ref}`, await page.content());
    const text = await page.evaluate(() => document.body.innerText);
    // Documents "Preview" opens a pop-up (facebox) that loads the list from its href_path, e.g.
    // /Tenders/tender_doc_view/108640/108640; read that list in the page (same session) and collect
    // every portal document link, plus any already on the notice page
    const docLinks = await page.evaluate(async () => {
        const links = [...document.querySelectorAll('a[href*="/portal_documents/"]')].map((a) => a.href);
        for (const preview of document.querySelectorAll('a[href_path*="tender_doc_view"]')) {
            // Sent as the pop-up's jQuery .load() does; without this header PhilGEPS answers "session expired"
            const res = await fetch(preview.getAttribute('href_path'), { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            const html = new DOMParser().parseFromString(await res.text(), 'text/html');
            for (const a of html.querySelectorAll('a[href*="/portal_documents/"]')) {
                links.push(new URL(a.getAttribute('href'), location.origin).href);
            }
        }
        return [...new Set(links)];
    });
    const documents = [];
    const errors = [];
    for (const url of docLinks) {
        try {
            documents.push(await downloadFile(page, url, path.join(DOCS_DIR, ref)));
        } catch (e) {
            errors.push(e.message);
        }
    }
    return { matched: matchMolecules(text), documents, errors, text };
}

async function main() {
    const browser = await puppeteer.launch({ headless: true });
    try {
        progress(2, 'Opening the saved PS-PhilGEPS session');
        const page = await openSession(browser);

        const lists = {};
        for (const [i, list] of LISTS.entries()) {
            lists[list.key] = await readList(page, list, (n) => progress(5 + i * 10 + Math.min(n, 9), `Reading ${list.label} (page ${n})`));
        }

        // Notice details + documents for every Bid Match row
        const refs = [...new Set(lists.bidMatch.rows.map(refOf).filter(Boolean))];
        const notices = {};
        for (const [i, ref] of refs.entries()) {
            progress(35 + (60 * i) / Math.max(refs.length, 1), `Notice ${ref} (${i + 1} of ${refs.length})`);
            try {
                const { text, ...notice } = await readNotice(page, ref);
                notices[ref] = { ...notice, textLength: text.length };
            } catch (e) {
                if (e.code === 'NOT_CONNECTED') throw e;
                notices[ref] = { error: e.message };
            }
        }

        const result = { syncedAt: new Date().toISOString(), lists, notices };
        progress(96, 'Saving to the database');
        const published = await publish(result, () => {});
        fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 1));
        if (published.failed.length) console.log(`Upload failed: ${published.failed.join('; ')}`);
        const matching = Object.values(notices).filter((n) => n.matched?.length).length;
        const files = Object.values(notices).reduce((sum, n) => sum + (n.documents?.length || 0), 0);
        progress(100, `Done: ${lists.bidMatch.rows.length} bid matches (${matching} with our products), ${files} documents, ` +
            `${lists.opportunities.rows.length} opportunities, ${lists.awards.rows.length} award notices`);
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(`${e.code || 'ERROR'}: ${e.message}`);
    process.exit(1);
});
