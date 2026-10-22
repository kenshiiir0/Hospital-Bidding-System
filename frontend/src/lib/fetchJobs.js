import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Runs every PhilGEPS fetch of the dashboard server, one at a time:
// - 'auto': the hourly public fetch, 6 AM to 5 PM. The 6 AM one also tries the log-in for documents and
//   falls back to public data only when the account is in use (a warning, not a failure).
// - 'sync': the Sync button. Log-in and documents only; fails when the account is in use.
// A fetch asked for while another runs waits in a queue. The dashboard reads currentJob() via GET /api/scrape.

// scraper.js lives in the repo root (one level above frontend/) with its own node_modules and .env,
// so it runs as a child process instead of being bundled
const REPO_ROOT = path.resolve(process.cwd(), '..');
// A fetch is only stopped when it shows no progress for this long (a long Sync that keeps working runs to
// the end); the scraper's watchdog then logs PhilGEPS out
const STALL_MS = 10 * 60 * 1000;
const FIRST_HOUR = 6;
const LAST_HOUR = 17;
// An automatic fetch that finds PhilGEPS down tries again this often within its hour
const AUTO_RETRY_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const SESSION_COOKIES = path.join(REPO_ROOT, '.philgeps', 'session-cookies.json');
// When the last automatic fetch finished and the day of the last one that logged in for documents, so a
// fetch missed while the PC slept or the dashboard was closed is made up as soon as it is back
const AUTO_STATE_FILE = path.join(REPO_ROOT, '.philgeps', 'auto-fetch.json');
const CATCH_UP_AFTER_MS = 55 * 60 * 1000;
// A clock jump this big between minute ticks means the PC was asleep
const SLEEP_GAP_MS = 3 * 60 * 1000;

const PUBLIC_URL = 'https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3';
const LOGIN_URL = 'https://notices.philgeps.gov.ph/GEPS/log-in.aspx';

const ARGS = {
  sync: ['--trigger=dashboard', '--documents-only'],
  auto: ['--trigger=schedule', '--no-login'],
  'auto-login': ['--trigger=schedule'],
};

// Kept on globalThis so a dev-server reload of this module doesn't forget a running fetch.
// job.kind: 'auto' | 'sync'; job.status: 'idle' | 'running' | 'success' | 'failed' | 'unavailable'
const state = (globalThis.philgepsFetch ??= { job: { status: 'idle' }, queue: [] });

// schedulerRunning is false until the dashboard server is restarted after instrumentation.js was added
export function currentJob() {
  return { ...state.job, queued: state.queue.map(kindOf), schedulerRunning: Boolean(globalThis.philgepsSchedulerStarted) };
}

const kindOf = (mode) => (mode === 'sync' ? 'sync' : 'auto');
const isRunning = () => state.job.status === 'running';

// PhilGEPS flickers between working and its error page (which redirects to itself), so a URL only
// counts as down when 3 tries 2 s apart all fail. Returns null when up, else the reason.
export async function philgepsDownReason(url = PUBLIC_URL) {
  let reason = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    reason = await checkOnce(url);
    if (!reason) return null;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return reason;
}

async function checkOnce(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const location = res.headers.get('location') || '';
    if (/ErrorPage/i.test(location) || (url === PUBLIC_URL && /log-in\.aspx/i.test(location))) {
      return 'PhilGEPS is showing its error page (the site is down or under maintenance).';
    }
    if (res.status >= 500) return `PhilGEPS answered with server error ${res.status}.`;
    return null;
  } catch (err) {
    return err.name === 'TimeoutError' ? 'PhilGEPS did not answer within 15 seconds.' : `PhilGEPS could not be reached (${err.message}).`;
  }
}

// Sync: checks PhilGEPS first and starts nothing when it is down.
// Returns { started | queued | unavailable, error?, job }.
export async function requestSync() {
  if (state.job.kind === 'sync' && isRunning()) return { started: false, job: currentJob() };
  if (state.queue.includes('sync')) return { queued: true, job: currentJob() };
  const downReason = await philgepsDownReason(LOGIN_URL);
  if (downReason) return { unavailable: true, error: downReason };
  return run('sync');
}

function run(mode) {
  if (isRunning()) {
    if (!state.queue.includes(mode)) state.queue.push(mode);
    return { queued: true, job: currentJob() };
  }
  const kind = kindOf(mode);
  state.job = { kind, status: 'running', percent: 0, stage: 'Starting', error: null, warning: null, startedAt: Date.now(), finishedAt: null };
  const job = state.job;
  const child = spawn(process.execPath, ['scraper.js', ...ARGS[mode], '--progress'], { cwd: REPO_ROOT });
  // A killed scraper can't log out of PhilGEPS itself; its watchdog (philgeps-session.js) does that
  let stalled = false;
  let timer;
  const stallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      child.kill();
    }, STALL_MS);
  };
  stallTimer();

  // stdout carries "PROGRESS {percent, stage, warning?}" and "TENDERS {queue | current | finished, status}"
  // lines among the normal log. job.tenders: { ref: 'waiting' | 'working' | <final documents status> },
  // job.tenderPercent: { ref: 0-100 } for the tender's filling number circle
  let pending = '';
  child.stdout.on('data', (chunk) => {
    stallTimer();
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      try {
        if (line.startsWith('PROGRESS ')) Object.assign(job, JSON.parse(line.slice('PROGRESS '.length)));
        if (line.startsWith('TENDERS ')) {
          const event = JSON.parse(line.slice('TENDERS '.length));
          if (event.queue) {
            job.tenders = Object.fromEntries(event.queue.map((ref) => [ref, 'waiting']));
            job.tenderPercent = {};
          }
          if (event.current && job.tenders) {
            job.tenders[event.current] = 'working';
            job.tenderPercent[event.current] = 0;
          }
          if (event.step && job.tenderPercent) job.tenderPercent[event.step] = event.percent;
          if (event.finished && job.tenders) {
            job.tenders[event.finished] = event.status;
            job.tenderPercent[event.finished] = 100;
            if (event.error) (job.tenderErrors ??= {})[event.finished] = event.error;
          }
        }
      } catch {
        // A garbled line only skips one update
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const finish = (error) => {
    clearTimeout(timer);
    if (job.status !== 'running') return;
    if (kind === 'auto' && !error) {
      const autoState = readAutoState();
      writeAutoState({
        lastAuto: Date.now(),
        lastLoginDay: mode === 'auto-login' ? new Date().toDateString() : autoState.lastLoginDay
      });
    }
    if (error) console.error(`PhilGEPS ${kind} fetch failed:`, error);
    // Tenders the run never reached stop rolling too
    if (job.tenders) for (const ref of Object.keys(job.tenders)) if (job.tenders[ref] === 'waiting' || job.tenders[ref] === 'working') job.tenders[ref] = 'not-reached';
    Object.assign(job, error ? { status: 'failed', error } : { status: 'success', percent: 100, stage: 'Done' });
    job.finishedAt = Date.now();
    const next = state.queue.shift();
    if (next) run(next);
  };
  child.on('error', (err) => finish(err.message));
  child.on('close', (code, signal) => {
    if (code === 0) finish(null);
    else if (stalled) finish(`Stopped: no progress for ${STALL_MS / 60000} minutes. The PhilGEPS session is logged out by the watchdog.`);
    else if (signal) finish(`Stopped (${signal}).`);
    // The scraper prints its error as the last stderr line; warnings come before it
    else finish(stderr.trim().split('\n').pop() || `Scraper exited with code ${code}.`);
  });
  return { started: true, job: currentJob() };
}

function readAutoState() {
  try {
    return JSON.parse(readFileSync(AUTO_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAutoState(value) {
  try {
    mkdirSync(path.dirname(AUTO_STATE_FILE), { recursive: true });
    writeFileSync(AUTO_STATE_FILE, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save the automatic fetch time:', err.message);
  }
}

// One automatic fetch: the day's first one (normally 6 AM) also tries the log-in for documents.
// PhilGEPS down: try again later in the hour, never start blind.
async function autoFetch(hour, triesLeft = 3) {
  const downReason = await philgepsDownReason();
  if (downReason) {
    if (!isRunning()) {
      state.job = { kind: 'auto', status: 'unavailable', error: downReason, startedAt: Date.now(), finishedAt: Date.now() };
    }
    if (triesLeft > 1) setTimeout(() => autoFetch(hour, triesLeft - 1), AUTO_RETRY_MS);
    return;
  }
  run(readAutoState().lastLoginDay === new Date().toDateString() ? 'auto' : 'auto-login');
}

// Make up a missed automatic fetch (PC asleep or dashboard closed over a scheduled hour): within the hours,
// when nothing is running and the last one finished more than CATCH_UP_AFTER_MS ago
function catchUp(reason) {
  const hour = new Date().getHours();
  if (hour < FIRST_HOUR || hour > LAST_HOUR || isRunning() || state.queue.length) return;
  if (Date.now() - (readAutoState().lastAuto || 0) < CATCH_UP_AFTER_MS) return;
  console.log(`PhilGEPS automatic fetch missed; catching up (${reason})`);
  autoFetch(hour);
}

// Every hour on the hour from 6 AM to 5 PM (this machine's clock), a catch-up for hours missed while the PC
// slept or the dashboard was closed, plus the log-out sweep every 5 minutes.
// Called once per server from instrumentation.js.
export function startScheduler() {
  if (globalThis.philgepsSchedulerStarted) return;
  globalThis.philgepsSchedulerStarted = true;

  const scheduleNextHour = () => {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    setTimeout(() => {
      const hour = new Date().getHours();
      if (hour >= FIRST_HOUR && hour <= LAST_HOUR) autoFetch(hour);
      scheduleNextHour();
    }, next - Date.now());
  };
  scheduleNextHour();

  // Missed hours: right after the dashboard starts, and when the PC wakes from sleep
  setTimeout(() => catchUp('dashboard started'), 20 * 1000);
  let lastTick = Date.now();
  setInterval(() => {
    if (Date.now() - lastTick > SLEEP_GAP_MS) catchUp('PC woke up');
    lastTick = Date.now();
  }, 60 * 1000);

  // Last resort for a PhilGEPS session left open (e.g. the PC lost power mid-run and its watchdog died too).
  // Only when no fetch of ours runs; the sweep itself also skips a session a live run holds.
  setInterval(() => {
    if (isRunning() || !existsSync(SESSION_COOKIES)) return;
    spawn(process.execPath, ['philgeps-session.js', '--sweep'], { cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true });
  }, SWEEP_MS);
  console.log(`PhilGEPS automatic fetch scheduled hourly ${FIRST_HOUR}:00–${LAST_HOUR}:00`);
}
