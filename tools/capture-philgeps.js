// One-time helper: logs in to PhilGEPS and saves the logged-in pages (HTML, screenshot, links)
// so the document ordering/downloading code can be written against the real layout.
//
//   node tools/capture-philgeps.js <ref already ordered> <open ref not yet ordered>
//
// Output goes to captures/ (gitignored: it contains account details). Nothing is submitted:
// for the second ref it stops at the page after clicking "Order".
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { login } = require('../philgeps-session');

const OUT_DIR = path.resolve(__dirname, '..', 'captures');
const NOTICE_URL = (ref) => `https://notices.philgeps.gov.ph/GEPS/Tender/SplashBidNoticeAbstractUI.aspx?menuIndex=3&refID=${ref}`;

let step = 0;
async function capture(page, name) {
    const base = path.join(OUT_DIR, `${String(++step).padStart(2, '0')}-${name}`);
    fs.writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a, input[type=submit], input[type=button], input[type=image]'))
            .map((el) => `${(el.innerText || el.value || el.alt || '').trim().slice(0, 80)} => ${el.getAttribute('href') || el.getAttribute('onclick') || el.name || el.id || ''}`)
    );
    fs.writeFileSync(`${base}.links.txt`, `URL: ${page.url()}\n\n${links.join('\n')}\n`);
    console.log(`Saved ${path.basename(base)} (${page.url()})`);
}

// Click the first link/button whose text matches, waiting for the page it loads
async function clickText(page, pattern) {
    const clicked = await page.evaluate((source) => {
        const re = new RegExp(source, 'i');
        const el = Array.from(document.querySelectorAll('a, input[type=submit], input[type=button]'))
            .find((e) => re.test((e.innerText || e.value || '').trim()));
        if (!el) return false;
        el.click();
        return true;
    }, pattern.source);
    if (!clicked) return false;
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    return true;
}

(async () => {
    const [orderedRef, openRef] = process.argv.slice(2);
    if (!orderedRef || !openRef) {
        console.error('Usage: node tools/capture-philgeps.js <ref already ordered> <open ref not yet ordered>');
        process.exit(1);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log('Logging in to PhilGEPS...');
        await login(page);
        await capture(page, 'after-login');

        if (await clickText(page, /^My Opportunities$/)) await capture(page, 'my-opportunities');
        else console.warn('No "My Opportunities" link found');

        await page.goto(NOTICE_URL(orderedRef), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await capture(page, `notice-${orderedRef}-ordered`);

        await page.goto(NOTICE_URL(openRef), { waitUntil: 'domcontentloaded', timeout: 90000 });
        await capture(page, `notice-${openRef}-open`);
        if (await clickText(page, /^Order$/)) await capture(page, `after-order-click-${openRef}`);
        else console.warn('No "Order" link found on the open notice');
    } finally {
        await browser.close();
    }
    console.log(`Done. Files are in ${OUT_DIR}`);
})().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
