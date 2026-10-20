require('dotenv').config({ quiet: true });

// Supplier log-in (the /GEPS/ side; public pages live under /GEPSNONPILOT/)
const HOME_URL = 'https://notices.philgeps.gov.ph/';
const LOGIN_URL = 'https://notices.philgeps.gov.ph/GEPS/log-in.aspx';

// Log the page in with the company PhilGEPS account from .env.
// The password is only typed into the form; never log it.
async function login(page) {
    const { PHILGEPS_USERNAME, PHILGEPS_PASSWORD } = process.env;
    if (!PHILGEPS_USERNAME || !PHILGEPS_PASSWORD) {
        throw new Error('Set PHILGEPS_USERNAME and PHILGEPS_PASSWORD in .env to fetch bid documents');
    }

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }); // establishes the session cookie
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#userName', { timeout: 90000 });
    await page.type('#userName', PHILGEPS_USERNAME);
    await page.type('#password', PHILGEPS_PASSWORD);

    // The button posts the form to logInAction.aspx, which redirects to a landing page that keeps
    // loading for a long time, so wait for the logged-in header (or a log-in error) instead of network idle.
    await page.click('#btnLogin');
    await page
        .waitForFunction(
            () => document.body && /Log-?out|invalid|incorrect|locked|error|try again/i.test(document.body.innerText) && !location.pathname.endsWith('/log-in.aspx'),
            { timeout: 90000, polling: 1000 }
        )
        .catch(() => {});

    // Logged-in pages carry a "Log-out" link in the header
    const loggedIn = await page.evaluate(() => /Log-?out/i.test(document.body.innerText));
    if (!loggedIn) {
        const message = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200));
        throw new Error(`PhilGEPS log-in failed (${page.url()}): ${message}`);
    }
}

module.exports = { login };
