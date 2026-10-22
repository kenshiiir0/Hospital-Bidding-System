require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');

// Log-in for the new PS-PhilGEPS site (philgeps.gov.ph), separate from the old notices.philgeps.gov.ph
// session in philgeps-session.js. The rules are the opposite of the old site:
// - the log-in form has a Google reCAPTCHA, so a person completes the log-in once (`--connect` opens a
//   visible Chrome with everything filled in; they tick "I'm not a robot" and the log-in submits itself),
// - the site allows several sessions per account, so the session is kept and reused by every run
//   until PhilGEPS ends it; then the next run reports NOT_CONNECTED and someone connects again,
// - the session cookies are kept in .ps-philgeps/session-cookies.json (gitignored: a live log-in).

const HOST = 'https://philgeps.gov.ph';
const LOGIN_URL = `${HOST}/Indexes/login`;
// Members-only page used to check the session: sends a closed session back to the log-in page
const CHECK_URL = `${HOST}/EventManagements/myBidMatch`;
const USER_TYPE = 'Marchant'; // value of "Merchant" in the log-in form's user type list (PhilGEPS spelling)
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

const STATE_DIR = path.join(__dirname, '.ps-philgeps');
const COOKIES_FILE = path.join(STATE_DIR, 'session-cookies.json');
// One line per connect / check / expiry, to learn how long PhilGEPS keeps a session (no account details)
const SESSION_LOG = path.join(STATE_DIR, 'session.log');

// code: NO_CREDENTIALS | NOT_CONNECTED | CONNECT_FAILED | SITE_DOWN | CANCELLED
class PsPhilgepsSessionError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function hasCredentials() {
    return Boolean(process.env.PS_PHILGEPS_USERNAME && process.env.PS_PHILGEPS_PASSWORD);
}

function sessionLog(message) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(SESSION_LOG, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
    } catch {}
}

function readCookies() {
    try {
        return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')).cookies;
    } catch {
        return null;
    }
}

async function saveCookies(page) {
    const cdp = await page.createCDPSession();
    const { cookies } = await cdp.send('Network.getAllCookies');
    await cdp.detach();
    const ours = cookies.filter((c) => c.domain.replace(/^\./, '').endsWith('philgeps.gov.ph'));
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: ours }, null, 1));
}

// Copies the saved session to Supabase (table ps_philgeps_session, private: secret key only) so the
// deployed dashboard's Sync can use it, and marks PS-PhilGEPS as connected for every dashboard
async function shareSession() {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const { cookies, savedAt } = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    const { error } = await supabase.from('ps_philgeps_session').upsert({ id: 'current', cookies, saved_at: savedAt });
    if (error) throw new PsPhilgepsSessionError('CONNECT_FAILED', `Logged in, but the session could not be saved to Supabase: ${error.message}`);
    await supabase.from('ps_sync_status').update({ connected_at: savedAt }).eq('id', 'latest');
    sessionLog('Session shared with Supabase');
}

function forgetSession() {
    fs.rmSync(COOKIES_FILE, { force: true });
}

async function onLoginPage(page) {
    if (/\/(Indexes|users)\/login/i.test(page.url())) return true;
    return page.$('form[action*="users/login"]').then(Boolean);
}

// Opens a members-only page with the saved session. Returns a page that is logged in, or throws
// NOT_CONNECTED (no saved session, or PhilGEPS ended it).
async function openSession(browser) {
    const cookies = readCookies();
    if (!cookies?.length) throw new PsPhilgepsSessionError('NOT_CONNECTED', 'PS-PhilGEPS is not connected yet.');

    const page = await browser.newPage();
    await page.setCookie(...cookies);
    await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (await onLoginPage(page)) {
        await page.close();
        const { savedAt } = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
        sessionLog(`Session ended by PhilGEPS (connected ${savedAt})`);
        forgetSession();
        throw new PsPhilgepsSessionError('NOT_CONNECTED', 'The PS-PhilGEPS session has ended. Connect again.');
    }
    // PhilGEPS may refresh its cookies on every visit; keep the newest ones
    await saveCookies(page);
    return page;
}

// The log-in window: the installed Google Chrome started like a normal program (not by puppeteer.launch),
// as a small app window ("--app") on the log-in page, with its own profile in .ps-philgeps so the person's
// own Chrome is untouched. Puppeteer then attaches over the debugging port only to fill the form and read
// the cookies. Launched by Puppeteer, the window stayed blank white on this PC (Puppeteer's default
// switches include --disable-features for parts of Chrome's toolbar UI), and reCAPTCHA kept asking again.
const CHROME_PATHS = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
];

async function launchLoginWindow() {
    const puppeteer = require('puppeteer');
    const chrome = CHROME_PATHS.find((p) => fs.existsSync(p)) || puppeteer.executablePath();
    const port = 9300 + Math.floor(Math.random() * 600);
    const { spawn } = require('node:child_process');
    spawn(chrome, [
        `--user-data-dir=${path.join(STATE_DIR, 'chrome-profile')}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1100,860',
        '--window-position=80,40',
        `--app=${LOGIN_URL}`
    ], { stdio: 'ignore' });

    // Wait for Chrome's debugging port, then attach
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) return puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        } catch {}
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new PsPhilgepsSessionError('CONNECT_FAILED', 'The PS-PhilGEPS log-in window did not open.');
}

// Live view (`--connect --live`, used by the dashboard): Chrome runs out of sight and the dashboard shows
// its picture. Every LIVE_FRAME_MS a screenshot goes to stdout as "FRAME <base64 jpeg>"; stdin lines
// "CLICK <x> <y>" (page pixels) are the person's clicks on that picture, passed to the page. Used because
// on some PCs a visible automated Chrome window stays blank white.
const LIVE_VIEWPORT = { width: 1000, height: 760 };
const LIVE_FRAME_MS = 500;

async function launchLive() {
    const puppeteer = require('puppeteer');
    const options = { headless: true, userDataDir: path.join(STATE_DIR, 'chrome-profile'), defaultViewport: LIVE_VIEWPORT };
    try {
        return await puppeteer.launch({ ...options, channel: 'chrome' });
    } catch {
        return puppeteer.launch(options);
    }
}

// Set by a "CANCEL" line on stdin (see connect)
let cancelled = false;

function startLiveView(page) {
    let busy = false;
    const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            const frame = await page.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64' });
            process.stdout.write(`FRAME ${frame}\n`);
        } catch {} // page is navigating
        busy = false;
    }, LIVE_FRAME_MS);
    const input = require('node:readline').createInterface({ input: process.stdin });
    input.on('line', async (line) => {
        const [command, x, y] = line.trim().split(/\s+/);
        if (command === 'CANCEL') cancelled = true;
        if (command !== 'CLICK' || !Number.isFinite(+x) || !Number.isFinite(+y)) return;
        // Clicks on the password field are ignored: its eye button would show the PhilGEPS password
        // in the dashboard's picture
        const onPassword = await page.evaluate((px, py) => {
            const field = document.querySelector('input[name=password]');
            const box = (field?.parentElement || field)?.getBoundingClientRect();
            return Boolean(box && px >= box.left && px <= box.right && py >= box.top && py <= box.bottom);
        }, +x, +y).catch(() => false);
        if (!onPassword) page.mouse.click(+x, +y).catch(() => {});
    });
    return () => {
        clearInterval(timer);
        input.close();
    };
}

// philgeps.gov.ph sometimes doesn't answer or returns 502 for a while: try the log-in page a few times,
// then report the site as down (SITE_DOWN) instead of a navigation error
const LOGIN_TRIES = 3;

async function openLoginForm(page) {
    for (let attempt = 1; ; attempt++) {
        try {
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('form[action*="users/login"] input[name=username]', { timeout: 20000 });
            return;
        } catch (e) {
            sessionLog(`Connect: log-in page try ${attempt} failed (${e.message.split('\n')[0]})`);
            if (attempt >= LOGIN_TRIES) {
                throw new PsPhilgepsSessionError('SITE_DOWN', 'PS-PhilGEPS (philgeps.gov.ph) is not responding right now. Try again in a few minutes.');
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

// Fills user type, username and password, waits for a person to tick the reCAPTCHA (in a visible Chrome
// window, or with live: on the dashboard's picture), then submits and saves the session. Never solves the
// captcha itself.
async function connect({ live = false } = {}) {
    if (!hasCredentials()) {
        throw new PsPhilgepsSessionError('NO_CREDENTIALS', 'Set PS_PHILGEPS_USERNAME and PS_PHILGEPS_PASSWORD in .env');
    }
    const browser = live ? await launchLive() : await launchLoginWindow();
    let stopLive = () => {};
    try {
        // The app window's page (it may take a moment to appear after Chrome starts)
        let page = null;
        for (let i = 0; i < 50 && !page; i++) {
            page = (await browser.pages()).find((p) => !p.url().startsWith('chrome')) || null;
            if (!page) await new Promise((r) => setTimeout(r, 200));
        }
        page ||= await browser.newPage();
        if (!live) await page.bringToFront();
        sessionLog(`Connect${live ? ' (live view)' : ''}: opening the log-in page`);
        await openLoginForm(page);
        await page.select('select[name=type]', USER_TYPE);
        // The log-in window keeps its Chrome profile between connects, so Chrome may already have filled
        // the fields (saved password / autofill); typing would add to that ("namename"). Empty them first.
        for (const field of ['input[name=username]', 'input[name=password]']) {
            await page.$eval(field, (el) => {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        await page.type('input[name=username]', process.env.PS_PHILGEPS_USERNAME);
        await page.type('input[name=password]', process.env.PS_PHILGEPS_PASSWORD);
        if (live) {
            // Captcha in the middle of the picture
            await page.evaluate(() => document.querySelector('.g-recaptcha')?.scrollIntoView({ block: 'center' }));
            stopLive = startLiveView(page);
        } else {
            await page.bringToFront();
            const input = require('node:readline').createInterface({ input: process.stdin });
            input.on('line', (line) => {
                if (line.trim() === 'CANCEL') cancelled = true;
            });
            stopLive = () => input.close();
        }
        sessionLog('Connect: form filled, waiting for the captcha');
        console.log('Tick "I\'m not a robot". The log-in submits itself once the captcha is done.');

        const deadline = Date.now() + CONNECT_TIMEOUT_MS;
        let submitted = false;
        while (Date.now() < deadline) {
            // stdin "CANCEL": the dashboard switched to another way of logging in; close the window quietly
            if (cancelled) throw new PsPhilgepsSessionError('CANCELLED', 'Log-in cancelled.');
            if (!browser.connected || page.isClosed()) {
                throw new PsPhilgepsSessionError('CONNECT_FAILED', 'The log-in window was closed.');
            }
            const state = await page.evaluate(() => ({
                form: Boolean(document.querySelector('form[action*="users/login"]')),
                solved: Boolean(document.querySelector('#g-recaptcha-response')?.value),
                alert: document.querySelector('.alert, .message.error, .error-message')?.innerText.trim() || ''
            })).catch(() => null); // page is navigating
            if (state && !state.form && !(await onLoginPage(page))) break;
            if (state?.solved && !submitted) {
                submitted = true;
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
                    page.click('form[action*="users/login"] input[type=submit]')
                ]);
                continue;
            }
            // Wrong password / expired captcha: back on the form with a message; let the person retry there
            if (submitted && state?.form && !state.solved) {
                if (state.alert) console.log(`PhilGEPS says: ${state.alert}`);
                submitted = false;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        if (Date.now() >= deadline) throw new PsPhilgepsSessionError('CONNECT_FAILED', 'Log-in not completed within 10 minutes.');
        stopLive();

        await saveCookies(page);
        await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (await onLoginPage(page)) {
            forgetSession();
            throw new PsPhilgepsSessionError('CONNECT_FAILED', 'Logged in, but the Bid Match page sent us back to the log-in form.');
        }
        await saveCookies(page);
        await shareSession();
        sessionLog(`Connected (landed on ${page.url()})`);
        return true;
    } finally {
        stopLive();
        await browser.close().catch(() => {});
    }
}

// Headless check that the saved session still works (also keeps it from going idle)
async function checkSession() {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await openSession(browser);
        sessionLog('Check: still connected');
        await page.close();
        return true;
    } finally {
        await browser.close();
    }
}

module.exports = { openSession, connect, checkSession, shareSession, hasCredentials, PsPhilgepsSessionError, HOST };

if (require.main === module) {
    const mode = process.argv[2];
    const live = process.argv.includes('--live');
    const run = mode === '--connect' ? () => connect({ live }) : mode === '--check' ? checkSession : mode === '--share' ? shareSession : null;
    if (!run) {
        console.log('Usage: node ps-philgeps-session.js --connect [--live] | --check | --share');
        process.exit(2);
    }
    run()
        .then(() => console.log(mode === '--connect' ? 'Connected to PS-PhilGEPS.' : mode === '--share' ? 'Session shared with Supabase.' : 'Still connected to PS-PhilGEPS.'))
        .catch((e) => {
            sessionLog(`${mode} failed: ${e.code || 'ERROR'}: ${e.message.split('\n')[0]}`);
            console.error(`${e.code || 'ERROR'}: ${e.message}`);
            process.exit(1);
        });
}
