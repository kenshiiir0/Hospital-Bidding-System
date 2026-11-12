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
// A connect stops after this many refused log-ins (wrong password), so the account is never locked
const MAX_REFUSED = 2;

const STATE_DIR = path.join(__dirname, '.ps-philgeps');
const COOKIES_FILE = path.join(STATE_DIR, 'session-cookies.json');
// One line per connect / check / expiry, to learn how long PhilGEPS keeps a session (no account details)
const SESSION_LOG = path.join(STATE_DIR, 'session.log');

// Shared log-in rules for both PhilGEPS sites (frontend/src/lib/loginGuard.mjs; records in login_attempts)
const loginGuard = () => import('./frontend/src/lib/loginGuard.mjs');

// code: NO_CREDENTIALS | NOT_CONNECTED | CONNECT_FAILED | SITE_DOWN | CANCELLED | LOGIN_PAUSED
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

// The installed Google Chrome on a Linux computer (the cloud log-in on GitHub's)
const LINUX_CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];

async function launchLoginWindow() {
    const puppeteer = require('puppeteer');
    const chrome = CHROME_PATHS.find((p) => fs.existsSync(p)) || puppeteer.executablePath();
    return startChromeAndAttach(chrome, ['--window-size=1100,860', '--window-position=80,40', `--app=${LOGIN_URL}`], null);
}

// Chrome started like a normal program with its own profile in .ps-philgeps, then attached to over its
// debugging port (only to fill the form and read the cookies)
async function startChromeAndAttach(chrome, extraArgs, viewport) {
    const puppeteer = require('puppeteer');
    const port = 9300 + Math.floor(Math.random() * 600);
    const { spawn } = require('node:child_process');
    const child = spawn(chrome, [
        `--user-data-dir=${path.join(STATE_DIR, 'chrome-profile')}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        // A log-in window closed by the script is not a crash: no "Restore pages?" bubble on the next one
        '--hide-crash-restore-bubble',
        ...extraArgs
    ], { stdio: 'ignore' });
    let exited = null;
    child.on('exit', (code) => (exited = code));
    child.on('error', (e) => (exited = e.message));

    // Wait for Chrome's debugging port, then attach
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && exited === null) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) return puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: viewport });
        } catch {}
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new PsPhilgepsSessionError('CONNECT_FAILED', exited !== null ? `Chrome stopped at start (${exited}).` : 'The PS-PhilGEPS log-in window did not open.');
}

// Live view (`--connect --live`, used by the dashboard): Chrome runs out of sight and the dashboard shows
// its picture. Every LIVE_FRAME_MS a screenshot goes to stdout as "FRAME <base64 jpeg>"; stdin lines
// "CLICK <x> <y>" (page pixels) are the person's clicks on that picture, passed to the page. Used because
// on some PCs a visible automated Chrome window stays blank white.
const LIVE_VIEWPORT = { width: 1000, height: 760 };
// (the cloud log-in streams faster: PS_LIVE_FRAME_MS, tools/ps-connect-cloud.js)
const LIVE_FRAME_MS = Number(process.env.PS_LIVE_FRAME_MS) || 500;

async function launchLive() {
    const puppeteer = require('puppeteer');
    // PS_LIVE_HEADFUL=1: a normal Chrome on a virtual screen (the cloud log-in, tools/ps-connect-cloud.mjs under
    // xvfb) or on the office log-in laptop's own screen, which Google's captcha trusts more than a hidden browser
    const headful = process.env.PS_LIVE_HEADFUL === '1';
    // Started like a normal program and attached to, as the log-in window here is (launchLoginWindow): Chrome
    // launched by Puppeteer is marked as automated, and the captcha then asked for picture after picture (about 20
    // on the cloud log-in, user 2026-11-03)
    if (headful) {
        try {
            // Linux on GitHub's computer, Windows on the office log-in laptop (tools/ps-connect-host.js)
            // On the office laptop the window opens off the screen (out of the way of whoever uses the laptop) and keeps
            // drawing there: Windows otherwise counts it as hidden and Chrome stops painting it (no picture to show)
            const offScreen = process.platform === 'win32'
                ? ['--window-position=-2400,0', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
                : [];
            return await startChromeAndAttach([...LINUX_CHROME, ...CHROME_PATHS].find((p) => fs.existsSync(p)) || puppeteer.executablePath(), [
                ...offScreen,
                `--window-size=${LIVE_VIEWPORT.width},${LIVE_VIEWPORT.height + 140}`,
                'about:blank'
            ], LIVE_VIEWPORT);
        } catch (e) {
            sessionLog(`Connect: Chrome could not be started on its own (${e.message}); starting it through Puppeteer`);
        }
    }
    const options = {
        headless: !headful,
        userDataDir: path.join(STATE_DIR, 'chrome-profile'),
        defaultViewport: LIVE_VIEWPORT,
        ...(headful && { args: ['--no-sandbox', `--window-size=${LIVE_VIEWPORT.width},${LIVE_VIEWPORT.height + 140}`] })
    };
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
            const frame = await page.screenshot({ type: 'jpeg', quality: Number(process.env.PS_LIVE_QUALITY) || 70, encoding: 'base64' });
            process.stdout.write(`FRAME ${frame}\n`);
        } catch {} // page is navigating
        busy = false;
    }, LIVE_FRAME_MS);
    const input = require('node:readline').createInterface({ input: process.stdin });
    input.on('line', async (line) => {
        const [command, x, y] = line.trim().split(/\s+/);
        if (command === 'CANCEL') cancelled = true;
        if (command !== 'CLICK' || !Number.isFinite(+x) || !Number.isFinite(+y)) return;
        // Only clicks on the log-in form or Google's captcha (its checkbox and picture puzzle are iframes) reach the
        // page: a tap on the site's menu or a link left the log-in page for PS-PhilGEPS's 500 page (user
        // 2026-11-12, the picture had just switched to the whole page). Clicks on the password field are ignored
        // too: its eye button would show the PhilGEPS password in the dashboard's picture.
        const verdict = await page.evaluate((px, py) => {
            const field = document.querySelector('input[name=password]');
            const box = (field?.parentElement || field)?.getBoundingClientRect();
            if (box && px >= box.left && px <= box.right && py >= box.top && py <= box.bottom) return 'password field';
            const el = document.elementFromPoint(px, py);
            if (!el) return 'nothing there';
            if (el.tagName === 'IFRAME' && /recaptcha/i.test(el.src || el.title || '')) return 'ok';
            if (el.closest('form[action*="users/login"]') && !el.closest('a')) return 'ok';
            return `outside the log-in form (${el.closest('a') ? 'a link' : el.tagName.toLowerCase()})`;
        }, +x, +y).catch(() => 'ok');
        if (verdict === 'ok') page.mouse.click(+x, +y).catch(() => {});
        else sessionLog(`Connect: click at ${x}, ${y} ignored: ${verdict}`);
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
            // A fresh start with PS-PhilGEPS: a session cookie left by a log-in that hit its 500 page kept every page
            // at 500 for this browser while the site answered others normally (user 2026-11-12). Only its cookies go;
            // Google's stay (the captcha trusts a returning browser more).
            const client = await page.createCDPSession();
            for (const domain of ['philgeps.gov.ph', '.philgeps.gov.ph', 'www.philgeps.gov.ph']) {
                const { cookies } = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
                for (const c of cookies.filter((k) => k.domain === domain)) {
                    await client.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
                }
            }
            await client.detach().catch(() => {});
            await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('form[action*="users/login"] input[name=username]', { timeout: 20000 });
            return;
        } catch (e) {
            sessionLog(`Connect: log-in page try ${attempt} failed (${e.message.split('\n')[0]})`);
            if (attempt >= LOGIN_TRIES) {
                throw new PsPhilgepsSessionError('SITE_DOWN', "The PS-PhilGEPS website is down right now (its log-in page did not open, 3 tries). This is on PS-PhilGEPS's side, not ours. Press Sync again in 5–10 minutes.");
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

// User type, username and password into the log-in form, checked afterwards. The log-in window keeps its Chrome
// profile between connects, so Chrome may already have filled the fields (saved password / autofill); typing
// would add to that ("namename"), so they are emptied first. If typing didn't stick (a window without focus, a
// page script resetting the form), the values are set directly, with the events the page's checks listen to.
async function fillCredentials(page) {
    const values = { username: process.env.PS_PHILGEPS_USERNAME, password: process.env.PS_PHILGEPS_PASSWORD };
    await page.select('select[name=type]', USER_TYPE);
    for (const name of Object.keys(values)) {
        await page.$eval(`input[name=${name}]`, (el) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.type(`input[name=${name}]`, values[name]);
    }
    const ok = () => page.evaluate((v) => Object.keys(v).every((n) => document.querySelector(`input[name=${n}]`)?.value === v[n]), values);
    if (await ok()) return;
    await page.evaluate((v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const [name, value] of Object.entries(v)) {
            const el = document.querySelector(`input[name=${name}]`);
            setter.call(el, value);
            for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
        }
    }, values);
    sessionLog(`Connect: typing did not stick; username and password set directly (${(await ok()) ? 'ok' : 'still empty'})`);
}

// After PS-PhilGEPS's 500 page following Log In: did the log-in get through? (the Bid Match page in a second tab,
// so the log-in page stays where it is if not)
const MAX_SITE_ERRORS = 3;
async function loggedInNow(page) {
    const probe = await page.browser().newPage();
    try {
        await probe.goto(CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return !(await onLoginPage(probe)) && !/Something went wrong/i.test(await probe.evaluate(() => document.body?.innerText.slice(0, 3000) || ''));
    } catch {
        return false;
    } finally {
        await probe.close().catch(() => {});
    }
}

// Fills user type, username and password, waits for a person to tick the reCAPTCHA (in a visible Chrome
// window, or with live: on the dashboard's picture), then submits and saves the session. Never solves the
// captcha itself.
async function connect({ live = false, code = null } = {}) {
    if (code) return connectLaptop(code);
    if (!hasCredentials()) {
        throw new PsPhilgepsSessionError('NO_CREDENTIALS', 'Set PS_PHILGEPS_USERNAME and PS_PHILGEPS_PASSWORD in .env');
    }
    const { checkLogin, recordLogin } = await loginGuard();
    try {
        await checkLogin('ps-philgeps');
    } catch (e) {
        throw new PsPhilgepsSessionError('LOGIN_PAUSED', e.message);
    }
    await recordLogin('ps-philgeps', 'started', { source: live ? 'dashboard' : 'team computer' });
    let refused = 0;
    try {
        await connectWindow({ live, onSubmit: () => recordLogin('ps-philgeps', 'submitted'), onRefused: async (said) => {
            refused++;
            await recordLogin('ps-philgeps', 'rejected', { detail: said });
            if (refused >= MAX_REFUSED) {
                throw new PsPhilgepsSessionError('CONNECT_FAILED', `PS-PhilGEPS refused the log-in ${refused} times${said ? ` ("${said}")` : ''}. Stopped so the account isn't locked; check the password in the settings before connecting again.`);
            }
        } });
        await recordLogin('ps-philgeps', 'ok');
        return true;
    } catch (e) {
        if (e.code !== 'CONNECT_FAILED' || !refused) await recordLogin('ps-philgeps', e.code === 'CANCELLED' ? 'cancelled' : 'error', { detail: e.message });
        throw e;
    }
}

async function connectWindow({ live, onRefused, onSubmit = async () => {}, share = shareSession }) {
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
        // The page may still be loading (after PS-PhilGEPS's 500 page and a retry it cleared the fields typed
        // into, and the person saw an empty form, user 2026-11-12): wait for it, then fill and check
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
        await fillCredentials(page);
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
        let siteErrors = 0;
        while (Date.now() < deadline) {
            // stdin "CANCEL": the dashboard switched to another way of logging in; close the window quietly
            if (cancelled) throw new PsPhilgepsSessionError('CANCELLED', 'Log-in cancelled.');
            // Told apart for the diagnosis: Chrome itself gone (closed from the taskbar, crashed) or only its page
            if (!browser.connected) throw new PsPhilgepsSessionError('CONNECT_FAILED', 'Chrome on the log-in computer stopped (closed from the taskbar or crashed).');
            if (page.isClosed()) throw new PsPhilgepsSessionError('CONNECT_FAILED', 'The log-in window was closed.');
            const state = await page.evaluate(() => ({
                form: Boolean(document.querySelector('form[action*="users/login"]')),
                solved: Boolean(document.querySelector('#g-recaptcha-response')?.value),
                filled: Boolean(document.querySelector('input[name=username]')?.value && document.querySelector('input[name=password]')?.value),
                alert: document.querySelector('.alert, .message.error, .error-message')?.innerText.trim() || '',
                // PS-PhilGEPS's own error page ("500 Server Error ... Something went wrong")
                errorPage: /\b50\d\b[\s\S]{0,40}Server Error|Something went wrong/i.test(document.body?.innerText.slice(0, 3000) || '')
            })).catch(() => null); // page is navigating
            // PS-PhilGEPS showed its 500 page (on its own, after Log In, or after a stray click): if the log-in got
            // through anyway, carry on; else open the log-in page again, filled in, for another tick (a few times)
            if (state?.errorPage && !state.form) {
                if (submitted && (await loggedInNow(page))) break;
                if (++siteErrors > MAX_SITE_ERRORS) {
                    throw new PsPhilgepsSessionError('SITE_DOWN', `The PS-PhilGEPS website is down right now (it kept showing its 500 error page${submitted ? ' after Log In' : ''}). This is on PS-PhilGEPS's side, not ours. Press Sync again in 5–10 minutes.`);
                }
                sessionLog(`Connect: PS-PhilGEPS showed its 500 page${submitted ? ' after Log In' : ''}; opening the log-in page again (${siteErrors} of ${MAX_SITE_ERRORS})`);
                await openLoginForm(page);
                await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
                await fillCredentials(page);
                if (live) await page.evaluate(() => document.querySelector('.g-recaptcha')?.scrollIntoView({ block: 'center' })).catch(() => {});
                submitted = false;
                continue;
            }
            if (state && !state.form && !(await onLoginPage(page))) break;
            // The form came back empty (the page reloaded, or a failed log-in cleared it): fill it again
            if (state?.form && !state.filled && !submitted) await fillCredentials(page).catch(() => {});
            if (state?.solved && !submitted) {
                submitted = true;
                // Counted by the log-in limit (frontend/src/lib/loginGuard.mjs): the password goes to PS-PhilGEPS now
                await onSubmit().catch(() => {});
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
                    // Pressed in the page, not with the mouse: in the office laptop's off-screen window a mouse click
                    // waited for ever for the button to come into view, and every click after it (the person's own)
                    // queued behind it until the captcha expired (user 2026-11-12)
                    page.evaluate(() => document.querySelector('form[action*="users/login"] input[type=submit]')?.click())
                ]);
                continue;
            }
            // Wrong password / expired captcha: back on the form with a message; let the person retry there
            // (a refused password counts toward MAX_REFUSED; an expired captcha has no message)
            if (submitted && state?.form && !state.solved) {
                if (state.alert) {
                    console.log(`PhilGEPS says: ${state.alert}`);
                    await onRefused(state.alert);
                }
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
        await share();
        sessionLog(`Connected (landed on ${page.url()})`);
    } finally {
        stopLive();
        await browser.close().catch(() => {});
    }
}

// A team laptop set up from the dashboard (PsConnectModal "Set up this laptop", api/ps-philgeps/laptop): it
// keeps no keys and no password. The dashboard's Sync button opens "ps-philgeps-connect:start?code=..." with a
// one-time code (15 minutes) for the signed-in person; with it this laptop asks the dashboard for the log-in
// (the dashboard applies the same log-in rules, lib/loginGuard.mjs), the person ticks the captcha here, and the
// session goes back to the dashboard, which saves it for the whole team.
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://government-bidding-automation.vercel.app').replace(/\/+$/, '');

async function askDashboard(code, body) {
    let res;
    try {
        res = await fetch(`${DASHBOARD_URL}/api/ps-philgeps/laptop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, code })
        });
    } catch (e) {
        throw new PsPhilgepsSessionError('CONNECT_FAILED', `The dashboard could not be reached (${e.message}). Check the internet and press Sync again.`);
    }
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.ok) throw new PsPhilgepsSessionError(result.code || 'CONNECT_FAILED', result.error || `The dashboard answered ${res.status}.`);
    return result;
}

async function connectLaptop(code) {
    // The account comes from the dashboard (its Vercel settings); a laptop with its own .env may use that instead
    const { username, password } = await askDashboard(code, { action: 'begin', ownAccount: hasCredentials() });
    // Only for this log-in, in memory: never written to a file
    if (username && password) {
        process.env.PS_PHILGEPS_USERNAME = username;
        process.env.PS_PHILGEPS_PASSWORD = password;
    }
    let refused = 0;
    try {
        await connectWindow({
            live: false,
            onSubmit: () => askDashboard(code, { action: 'submitted' }),
            onRefused: async (said) => {
                refused++;
                await askDashboard(code, { action: 'refused', detail: said }).catch(() => {});
                if (refused >= MAX_REFUSED) {
                    throw new PsPhilgepsSessionError('CONNECT_FAILED', `PS-PhilGEPS refused the log-in ${refused} times${said ? ` ("${said}")` : ''}. Stopped so the account isn't locked.`);
                }
            },
            share: async () => {
                const { cookies, savedAt } = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
                await askDashboard(code, { action: 'done', cookies, savedAt });
                sessionLog('Session handed to the dashboard');
            }
        });
        return true;
    } catch (e) {
        if (e.code !== 'CONNECT_FAILED' || !refused) {
            await askDashboard(code, { action: 'failed', outcome: e.code === 'CANCELLED' ? 'cancelled' : 'error', detail: e.message }).catch(() => {});
        }
        throw e;
    } finally {
        // The laptop keeps no PhilGEPS session of its own: the dashboard has it
        forgetSession();
    }
}

// The one-time code from the link "ps-philgeps-connect:start?code=..." (anything else in the link is ignored)
function linkCode(argv) {
    const link = argv.find((a) => /^ps-philgeps-connect:/i.test(a));
    const m = link && /[?&]code=([A-Za-z0-9_.-]{20,400})(?:[&/]|$)/.exec(link);
    return m ? m[1] : null;
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

module.exports = { openSession, connect, linkCode, checkSession, shareSession, hasCredentials, PsPhilgepsSessionError, HOST };

if (require.main === module) {
    const mode = process.argv[2];
    const live = process.argv.includes('--live');
    const code = linkCode(process.argv);
    const run = mode === '--connect' ? () => connect({ live, code }) : mode === '--check' ? checkSession : mode === '--share' ? shareSession : null;
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
