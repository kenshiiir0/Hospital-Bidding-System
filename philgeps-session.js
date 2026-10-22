require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

// PhilGEPS allows one session per account ("The user id you have provided is currently in use"),
// so a session left open locks the team out until PhilGEPS expires it. Everything here exists so
// that never happens:
// - only one process logs in at a time (lock file shared by the 6 AM run and the dashboard),
// - the session cookies are written to disk the moment the log-in form is submitted, so a run
//   that crashes or is killed can still be logged out by the next run or by `--logout`,
// - log-out opens the log-out address directly (pages without a Log-out link broke this before)
//   and is confirmed by checking that a members-only page sends us back to the log-in form,
// - a rejected log-in is never retried in the same run (repeated attempts could lock the account),
// - a separate watchdog process is started before every log-in. It logs the session out as soon as
//   the run's process dies, or after IDLE_LOGOUT_MS without any PhilGEPS request (a hung run), and
//   keeps retrying until the log-out is confirmed. It does not depend on the run staying alive.

const LOGIN_URL = 'https://notices.philgeps.gov.ph/GEPS/log-in.aspx';
const LOGOUT_URL = 'https://notices.philgeps.gov.ph/GEPS/LogoutRedirect.aspx';
// Members-only page: redirects to log-in.aspx when the session is closed
const MEMBERS_URL = 'https://notices.philgeps.gov.ph/GEPS/Tender/OpportunitiesSearchUI.aspx';

// Gitignored: the cookies file is a live log-in while it exists
const STATE_DIR = path.resolve(__dirname, '.philgeps');
const LOCK_FILE = path.join(STATE_DIR, 'session.lock');
const COOKIES_FILE = path.join(STATE_DIR, 'session-cookies.json');
// Written right after a log-in: { landingUrl, membersCheckWorks } (see recordSessionInfo)
const SESSION_INFO_FILE = path.join(STATE_DIR, 'session-info.json');
// A lock older than this belongs to a run that died without releasing it
const LOCK_STALE_MS = 30 * 60 * 1000;
// No time limit while the run is working (user, 2026-10-21: a Sync must not log out half-way). A run that
// stops making progress is logged out by the watchdog after IDLE_LOGOUT_MS; one that crashes, within seconds.
const MAX_SESSION_MS = Infinity;
const LOGOUT_ATTEMPTS = 5;
// PhilGEPS flickers between working and its error page; wait this long between tries
const RETRY_GAP_MS = 5000;
// Watchdog: the run touches HEARTBEAT_FILE on every PhilGEPS request; this long without one = not in use
const HEARTBEAT_FILE = path.join(STATE_DIR, 'heartbeat');
const WATCHDOG_LOG = path.join(STATE_DIR, 'watchdog.log');
// One line per log-in / self-test / log-out, kept as proof of every session (no account details)
const SESSION_LOG = path.join(STATE_DIR, 'session.log');

function sessionLog(message) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(SESSION_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
    } catch {
        // Logging is best effort
    }
}
const IDLE_LOGOUT_MS = 5 * 60 * 1000;
const WATCHDOG_POLL_MS = 5 * 1000;
// Give up retrying a log-out after this long (PhilGEPS down); the next run or cron sweep tries again
const WATCHDOG_GIVE_UP_MS = 2 * 60 * 60 * 1000;

// code: NO_CREDENTIALS | LOCKED | ACCOUNT_BUSY | LOGIN_REJECTED | LOGIN_FAILED
class PhilgepsSessionError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const hasCredentials = () => Boolean(process.env.PHILGEPS_USERNAME && process.env.PHILGEPS_PASSWORD);

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

// Returns a release function. Throws LOCKED while another live process holds the lock.
function acquireLock() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return () => fs.rmSync(LOCK_FILE, { force: true });
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            let holder = {};
            try {
                holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
            } catch {
                // Half-written lock: treat as stale
            }
            // Held as long as its process lives (a long Sync may run past any fixed age)
            if (processAlive(holder.pid)) {
                throw new PhilgepsSessionError('LOCKED', 'Another run is already logged in to PhilGEPS');
            }
            fs.rmSync(LOCK_FILE, { force: true });
        }
    }
    throw new PhilgepsSessionError('LOCKED', 'Could not take the PhilGEPS log-in lock');
}

async function saveCookies(page) {
    const cookies = await page.cookies(LOGIN_URL);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies), { mode: 0o600 });
}

function readSessionInfo() {
    try {
        return JSON.parse(fs.readFileSync(SESSION_INFO_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function forgetSession() {
    fs.rmSync(COOKIES_FILE, { force: true });
    fs.rmSync(SESSION_INFO_FILE, { force: true });
}

async function openPage(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (/ErrorPage/i.test(page.url())) throw new Error('PhilGEPS showed its error page');
}

// Does the members-only page send us to the log-in form? Throws on PhilGEPS's error page.
async function membersPageRedirects(page) {
    await openPage(page, MEMBERS_URL);
    return /log-in\.aspx/i.test(page.url()) || Boolean(await page.$('#userName'));
}

// Right after logging in, while the session is certainly open: remember the page PhilGEPS landed on
// (it shows "Log-out") and whether the members-only page really tells a live session apart.
// Both are what isLoggedOut relies on, so it never trusts a check that wasn't seen working.
async function recordSessionInfo(page) {
    const info = { landingUrl: page.url() };
    try {
        info.membersCheckWorks = !(await membersPageRedirects(page));
    } catch {
        info.membersCheckWorks = null; // Unknown (error page): don't rely on it
    }
    // The landing page must still show "Log-out" when opened again (some pages only work once, after the form)
    try {
        await openPage(page, info.landingUrl);
        if (!(await page.evaluate(() => /Log-?\s?out/i.test(document.body?.innerText || '')))) info.landingUrl = null;
    } catch {
        info.landingUrl = null;
    }
    if (!info.membersCheckWorks) console.warn('  The members-page log-out check could not be confirmed on this session');
    if (!info.landingUrl) console.warn('  The landing page cannot be reopened; the log-out check uses the members page only');
    // Neither check proved itself: keep the stricter members-page check rather than none
    if (!info.landingUrl) info.membersCheckWorks = true;
    fs.writeFileSync(SESSION_INFO_FILE, JSON.stringify(info), { mode: 0o600 });
    sessionLog(`Self-test: landing page ${info.landingUrl ? 'reopens showing Log-out' : 'not reusable'}, members-page check ${info.membersCheckWorks ? 'works' : 'not reliable'}`);
}

// Logged out only when the landing page no longer shows "Log-out" and, if it proved reliable after
// log-in, the members-only page sends us to the log-in form. Throws on PhilGEPS's error page.
async function isLoggedOut(page) {
    const info = readSessionInfo();
    if (info.landingUrl) {
        await openPage(page, info.landingUrl);
        const stillIn = !/log-in\.aspx/i.test(page.url()) &&
            (await page.evaluate(() => /Log-?\s?out/i.test(document.body?.innerText || '')));
        if (stillIn) return false;
        if (info.membersCheckWorks === false || info.membersCheckWorks === null) return true;
    }
    return membersPageRedirects(page);
}

// Second way out: click the real Log-out link on the landing page
async function clickLogoutLink(page) {
    const { landingUrl } = readSessionInfo();
    if (!landingUrl) return;
    await openPage(page, landingUrl);
    const clicked = await page.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a, input[type=submit], input[type=button]'))
            .find((el) => /^Log-?\s?out$/i.test((el.innerText || el.value || '').trim()));
        if (!link) return false;
        link.click();
        return true;
    });
    if (clicked) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
}

// Logs out (log-out address first, then the Log-out link) until isLoggedOut confirms it.
// Returns true when confirmed. Never throws.
async function logoutAndVerify(page) {
    for (let attempt = 1; attempt <= LOGOUT_ATTEMPTS; attempt++) {
        for (const [how, logout] of [
            ['log-out address', () => page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })],
            ['Log-out link', () => clickLogoutLink(page)]
        ]) {
            try {
                await logout().catch(() => {});
                if (await isLoggedOut(page)) {
                    forgetSession();
                    console.log(`  Logged out of PhilGEPS (confirmed, via the ${how})`);
                    sessionLog(`Logged out (confirmed, via the ${how}, attempt ${attempt})`);
                    return true;
                }
                console.warn(`  Still logged in after the ${how}`);
                sessionLog(`Log-out attempt ${attempt}: still logged in after the ${how} (${page.url()})`);
            } catch (err) {
                console.warn(`  Log-out attempt ${attempt} (${how}) failed: ${err.message}`);
                sessionLog(`Log-out attempt ${attempt} (${how}) failed: ${err.message}`);
            }
        }
        if (attempt < LOGOUT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_GAP_MS));
    }
    console.warn(`  Could not confirm the PhilGEPS log-out; cookies kept in ${COOKIES_FILE} for the watchdog`);
    sessionLog('Log-out NOT confirmed; session kept for the watchdog');
    return false;
}

// A previous run that crashed or was killed left its cookies behind: close that session first,
// otherwise our own log-in would be refused as "currently in use".
async function closeLeftoverSession(page) {
    if (!fs.existsSync(COOKIES_FILE)) return true;
    console.log('  Closing a PhilGEPS session left open by an earlier run...');
    try {
        await page.setCookie(...JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
    } catch {
        forgetSession();
        return true;
    }
    return logoutAndVerify(page);
}

// The post-log-in page stalls while it waits on slow assets, so only let PhilGEPS documents,
// scripts and styles through
async function skipHeavyRequests(page) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        touchHeartbeat();
        if (request.isInterceptResolutionHandled()) return;
        const { hostname } = new URL(request.url());
        const isPhilgeps = hostname === 'philgeps.gov.ph' || hostname.endsWith('.philgeps.gov.ph');
        if (!isPhilgeps || ['image', 'font', 'media'].includes(request.resourceType())) request.abort();
        else request.continue();
    });
}

// Log the page in with the company account from .env. The password is only typed into the form; never log it.
async function login(page) {
    await skipHeavyRequests(page);

    // PhilGEPS reports log-in problems in a JavaScript alert ("currently in use", wrong password, ...).
    // An unanswered alert freezes a headless page, so read and close it.
    const popups = [];
    page.on('dialog', async (dialog) => {
        // Type kept for the error: a "confirm" would mean PhilGEPS offers a choice, which we always decline
        popups.push(`${dialog.type()}: ${dialog.message().trim()}`);
        await dialog.dismiss().catch(() => {});
    });
    const rejected = () => {
        const text = popups.join(' / ');
        return /in use/i.test(text)
            ? new PhilgepsSessionError('ACCOUNT_BUSY', `The PhilGEPS account is in use on another device or browser (PhilGEPS: "${text}")`)
            : new PhilgepsSessionError('LOGIN_REJECTED', `PhilGEPS rejected the log-in: "${text}"`);
    };

    // Nothing is submitted yet, so opening the form can safely be retried while PhilGEPS flickers.
    // Measured 2026-10-21: without cookies the form opens ~2 times in 3; with the cookies a failed load
    // (or the public pages) leave behind it never does. So every retry starts with no cookies.
    for (let attempt = 1; ; attempt++) {
        if (attempt > 1) await clearPhilgepsCookies(page);
        try {
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (!/ErrorPage/i.test(page.url())) break;
            if (attempt >= 8) throw new Error('PhilGEPS showed its error page');
        } catch (err) {
            if (attempt >= 8) throw new PhilgepsSessionError('LOGIN_FAILED', `PhilGEPS log-in page did not open (${err.message.split(' at ')[0]})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await page.waitForSelector('#userName', { timeout: 15000 });
    await page.type('#userName', process.env.PHILGEPS_USERNAME);
    await page.type('#password', process.env.PHILGEPS_PASSWORD);

    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('#btnLogin')
        ]);
    } finally {
        // Saved even if the wait failed: PhilGEPS may have accepted the log-in anyway
        await saveCookies(page).catch(() => {});
    }

    // The log-in may hop through one more redirect. Stop at the logged-in header ("Log-out")
    // or the log-in form again (wrong password, account in use, ...).
    await page.waitForFunction(
        () => /Log-?out/i.test(document.body?.innerText || '') || document.querySelector('#userName'),
        { timeout: 15000, polling: 250 }
    ).catch(() => {});
    await saveCookies(page).catch(() => {});

    const pageText = await page.evaluate(() => document.body?.innerText || '');
    if (/Log-?out/i.test(pageText)) return;
    if (popups.length) throw rejected();
    if (/in use/i.test(pageText)) popups.push(pageText.match(/[^\n]*in use[^\n]*/i)[0]);
    if (popups.length) throw rejected();
    throw new PhilgepsSessionError('LOGIN_FAILED', `PhilGEPS log-in did not complete (ended on ${page.url()})`);
}

// Before any log-in is submitted only: drops the cookies a failed PhilGEPS load left behind
async function clearPhilgepsCookies(page) {
    const cookies = await page.cookies(LOGIN_URL);
    if (cookies.length) await page.deleteCookie(...cookies);
}

// At most one write per second: requests come in bursts
let lastBeat = 0;
function touchHeartbeat() {
    if (Date.now() - lastBeat < 1000) return;
    lastBeat = Date.now();
    try {
        fs.writeFileSync(HEARTBEAT_FILE, String(lastBeat));
    } catch {
        // A missed beat only brings the idle log-out closer
    }
}

// Starts the watchdog for this process as a detached process, so it outlives a crash or kill of the run.
// Throws if it can't start: without it, the run must not log in.
function startWatchdog() {
    const { spawn } = require('node:child_process');
    touchHeartbeat();
    const child = spawn(process.execPath, [__filename, '--watchdog', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    if (!child.pid) throw new PhilgepsSessionError('LOGIN_FAILED', 'Could not start the PhilGEPS log-out watchdog; not logging in');
    child.unref();
}

function watchdogLog(message) {
    try {
        fs.appendFileSync(WATCHDOG_LOG, `${new Date().toISOString()} ${message}
`);
    } catch {
        // Logging is best effort
    }
}

// The watchdog loop (node philgeps-session.js --watchdog <run pid>). Ends when the session file is gone
// (normal log-out), or after logging the session out itself.
async function runWatchdog(ownerPid) {
    const started = Date.now();
    let sessionSeen = false;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, WATCHDOG_POLL_MS));
        if (!fs.existsSync(COOKIES_FILE)) {
            // Gone after being there: the run logged out normally. Never there: the cookies are written
            // when the log-in form is submitted, so wait unless the run died first.
            if (sessionSeen || !processAlive(ownerPid) || Date.now() - started > LOCK_STALE_MS) return;
            continue;
        }
        sessionSeen = true;
        let lastBeat = 0;
        try {
            lastBeat = Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8')) || 0;
        } catch {
            // No heartbeat file: treat as idle
        }
        const ownerDead = !processAlive(ownerPid);
        const idle = Date.now() - lastBeat >= IDLE_LOGOUT_MS;
        if (!ownerDead && !idle) continue;

        watchdogLog(`Run ${ownerPid} ${ownerDead ? 'ended without logging out' : `idle for ${IDLE_LOGOUT_MS / 60000}+ minutes`}; logging out`);
        const puppeteer = require('puppeteer');
        for (;;) {
            let confirmed = false;
            const browser = await puppeteer.launch({ headless: true }).catch(() => null);
            if (browser) {
                try {
                    confirmed = await closeLeftoverSession(await browser.newPage());
                } catch (err) {
                    watchdogLog(`Log-out attempt failed: ${err.message}`);
                } finally {
                    await browser.close().catch(() => {});
                }
            }
            if (confirmed) {
                watchdogLog('Logged out of PhilGEPS (confirmed)');
                return;
            }
            if (Date.now() - started > WATCHDOG_GIVE_UP_MS) {
                watchdogLog('Giving up; the next run or the scheduler sweep will retry');
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
        }
    }
}

// For long-running hosts (cron.js): close a session nobody is using any more, e.g. after the PC lost
// power mid-run and the watchdog died with it. Skips while a live run holds the lock. Never throws.
async function sweepLeftoverSession() {
    if (!fs.existsSync(COOKIES_FILE)) return;
    try {
        const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (processAlive(holder.pid)) return;
    } catch {
        // No lock: nobody is using the session
    }
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: true }).catch(() => null);
    if (!browser) return;
    try {
        await closeLeftoverSession(await browser.newPage());
    } catch (err) {
        console.warn(`PhilGEPS session sweep failed: ${err.message}`);
    } finally {
        await browser.close().catch(() => {});
    }
}

// Runs fn(page, { deadline }) inside one logged-in PhilGEPS session and always logs out afterwards.
// fn should stop starting new work once Date.now() > deadline.
// `status` is filled in for the caller's report: { loggedIn, loggedOut }.
// Throws PhilgepsSessionError when no session could be opened; errors thrown by fn are passed on.
async function withPhilgepsSession(browser, fn, status = {}) {
    if (!hasCredentials()) {
        throw new PhilgepsSessionError('NO_CREDENTIALS', 'PHILGEPS_USERNAME / PHILGEPS_PASSWORD are not set in .env');
    }
    const release = acquireLock();
    // Separate cookie jar from the public scrape's pages
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    let loginAttempted = false;

    // Ctrl+C or a normal kill of the process: log out before exiting
    const onSignal = async () => {
        if (loginAttempted) await logoutAndVerify(page);
        release();
        process.exit(130);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
        if (!(await closeLeftoverSession(page))) {
            throw new PhilgepsSessionError('ACCOUNT_BUSY', 'A PhilGEPS session from an earlier run could not be closed yet');
        }
        startWatchdog();
        loginAttempted = true;
        console.log('  Logging in to PhilGEPS...');
        await login(page);
        status.loggedIn = true;
        await recordSessionInfo(page);
        console.log('  Logged in');
        sessionLog('Logged in');
        return await fn(page, { deadline: Date.now() + MAX_SESSION_MS });
    } finally {
        // The cookies file is written when the log-in form is submitted: without it there is no session to close
        // Log out the way the watchdog does, which has always worked: a brand-new browser context holding only
        // the session cookies saved at log-in. Logging out from the context that just spent minutes ordering
        // and downloading kept failing its check (2026-10-21). If this fails too, the watchdog takes over.
        if (loginAttempted && fs.existsSync(COOKIES_FILE)) {
            await context.close().catch(() => {});
            const clean = await browser.createBrowserContext().catch(() => null);
            const cleanPage = clean && (await clean.newPage().catch(() => null));
            status.loggedOut = cleanPage ? await closeLeftoverSession(cleanPage) : false;
            await clean?.close().catch(() => {});
            if (!status.loggedOut) sessionLog('Clean-context log-out not confirmed; the watchdog takes over');
        } else if (loginAttempted) {
            status.loggedOut = true;
        }
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await context.close().catch(() => {});
        release();
    }
}

module.exports = { withPhilgepsSession, hasCredentials, PhilgepsSessionError, logoutAndVerify, closeLeftoverSession, sweepLeftoverSession, touchHeartbeat };

if (require.main === module && process.argv.includes('--watchdog')) {
    runWatchdog(Number(process.argv[process.argv.indexOf('--watchdog') + 1])).catch((err) => watchdogLog(`Watchdog error: ${err.message}`));
}

// node philgeps-session.js --sweep: what the dashboard runs every 5 minutes (see sweepLeftoverSession)
if (require.main === module && process.argv.includes('--sweep')) {
    sweepLeftoverSession().finally(() => process.exit());
}

// node philgeps-session.js --logout: close a session a crashed or killed run left open
if (require.main === module && process.argv.includes('--logout')) {
    (async () => {
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: true });
        try {
            const page = await browser.newPage();
            if (!fs.existsSync(COOKIES_FILE)) console.log('No saved PhilGEPS session; nothing to log out.');
            else if (!(await closeLeftoverSession(page))) process.exitCode = 1;
        } finally {
            await browser.close();
        }
    })().catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
}
