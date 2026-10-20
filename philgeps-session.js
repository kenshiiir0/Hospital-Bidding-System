require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

// Supplier log-in (the /GEPS/ side; public pages live under /GEPSNONPILOT/)
const LOGIN_URL = 'https://notices.philgeps.gov.ph/GEPS/log-in.aspx';
// Screenshot + HTML of the page when log-in fails (gitignored, may show account details)
const DEBUG_DIR = path.resolve(__dirname, 'captures');

// Log the page in with the company PhilGEPS account from .env.
// The password is only typed into the form; never log it.
async function login(page) {
    const { PHILGEPS_USERNAME, PHILGEPS_PASSWORD } = process.env;
    if (!PHILGEPS_USERNAME || !PHILGEPS_PASSWORD) {
        throw new Error('Set PHILGEPS_USERNAME and PHILGEPS_PASSWORD in .env to fetch bid documents');
    }
    const started = Date.now();
    const step = (message) => console.log(`  [${((Date.now() - started) / 1000).toFixed(1)} s] ${message}`);

    try {
        // The log-in page sets its own session cookie, so no home page visit is needed (~0.3 s)
        step('Opening log-in page...');
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('#userName', { timeout: 15000 });
        await page.type('#userName', PHILGEPS_USERNAME);
        await page.type('#password', PHILGEPS_PASSWORD);

        // The button posts the form to logInAction.aspx. Wait only for the resulting document,
        // not for the landing page's images and scripts to finish loading.
        step('Submitting log-in...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('#btnLogin')
        ]);
        step(`PhilGEPS answered: ${page.url()}`);

        // logInAction.aspx may hop through one more redirect. Stop as soon as the page shows either
        // the logged-in header ("Log-out") or the log-in form again (wrong password, locked account, ...).
        await page.waitForFunction(
            () => /Log-?out/i.test(document.body?.innerText || '') || document.querySelector('#userName'),
            { timeout: 15000, polling: 250 }
        );
    } catch (err) {
        await saveDebug(page);
        throw new Error(`PhilGEPS log-in stalled after ${((Date.now() - started) / 1000).toFixed(1)} s at ${page.url()}: ${err.message}`);
    }

    const loggedIn = await page.evaluate(() => /Log-?out/i.test(document.body?.innerText || ''));
    if (!loggedIn) {
        await saveDebug(page);
        const message = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
        throw new Error(`PhilGEPS log-in failed (${page.url()}): ${message}`);
    }
    step('Logged in');
}

async function saveDebug(page) {
    try {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        await page.screenshot({ path: path.join(DEBUG_DIR, 'login-debug.png'), fullPage: true });
        fs.writeFileSync(path.join(DEBUG_DIR, 'login-debug.html'), await page.content());
        console.log(`  Saved the page PhilGEPS showed to ${path.join(DEBUG_DIR, 'login-debug.png')}`);
    } catch {
        // Page already gone: the error message is all we have
    }
}

module.exports = { login };
