require('dotenv').config({ quiet: true });

// Supplier log-in (the /GEPS/ side; public pages live under /GEPSNONPILOT/)
const LOGIN_URL = 'https://notices.philgeps.gov.ph/GEPS/log-in.aspx';

// Log the page in with the company PhilGEPS account from .env.
// The password is only typed into the form; never log it.
async function login(page) {
    const { PHILGEPS_USERNAME, PHILGEPS_PASSWORD } = process.env;
    if (!PHILGEPS_USERNAME || !PHILGEPS_PASSWORD) {
        throw new Error('Set PHILGEPS_USERNAME and PHILGEPS_PASSWORD in .env to fetch bid documents');
    }
    const started = Date.now();

    // The log-in page sets its own session cookie, so no home page visit is needed (~0.3 s)
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#userName', { timeout: 30000 });
    await page.type('#userName', PHILGEPS_USERNAME);
    await page.type('#password', PHILGEPS_PASSWORD);

    // The button posts the form to logInAction.aspx. Wait only for the resulting document,
    // not for the landing page's images and scripts to finish loading.
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
        page.click('#btnLogin')
    ]);

    // logInAction.aspx may hop through one more redirect. Stop as soon as the page shows either
    // the logged-in header ("Log-out") or the log-in form again (wrong password, locked account, ...).
    await page
        .waitForFunction(
            () => /Log-?out/i.test(document.body?.innerText || '') || document.querySelector('#userName'),
            { timeout: 15000, polling: 250 }
        )
        .catch(() => {});

    const loggedIn = await page.evaluate(() => /Log-?out/i.test(document.body?.innerText || ''));
    if (!loggedIn) {
        const message = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
        throw new Error(`PhilGEPS log-in failed (${page.url()}): ${message}`);
    }
    console.log(`Logged in to PhilGEPS in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

module.exports = { login };
