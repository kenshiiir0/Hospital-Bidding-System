import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// PS-PhilGEPS (philgeps.gov.ph) Sync, separate from the old PhilGEPS Sync in fetchJobs.js.
// When no session is saved it first runs `node ps-philgeps-session.js --connect` (visible Chrome on this
// computer, log-in filled in; a person ticks the reCAPTCHA), then `node ps-philgeps-sync.js --progress`.
const REPO_ROOT = path.resolve(process.cwd(), '..');
const COOKIES_FILE = path.join(REPO_ROOT, '.ps-philgeps', 'session-cookies.json');
const RESULT_FILE = path.join(REPO_ROOT, '.ps-philgeps', 'latest.json');

// status: idle | connecting | syncing | success | failed. On globalThis so dev reloads keep it.
const state = (globalThis.psPhilgepsSync ??= { job: { status: 'idle' } });

function connectedAt() {
  try {
    return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')).savedAt;
  } catch {
    return null;
  }
}

// connected = a saved session exists; PhilGEPS may still have ended it (the next Sync finds out,
// deletes it and asks for the captcha again)
export function psPhilgepsStatus() {
  const at = connectedAt();
  return { connected: Boolean(at), connectedAt: at, job: state.job };
}

export function psPhilgepsData() {
  try {
    return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Runs a script in the repo root; resolves with { code, last } (its error line). Feeds "PROGRESS {...}"
// lines to onProgress and "FRAME <base64>" lines (live view) to onFrame; onChild gets the process.
function runScript(args, { onProgress = () => {}, onFrame = () => {}, onChild = () => {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
    onChild(child);
    let errors = '';
    let pending = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('FRAME ')) onFrame(line.slice('FRAME '.length).trim());
        if (!line.startsWith('PROGRESS ')) continue;
        try {
          onProgress(JSON.parse(line.slice('PROGRESS '.length)));
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', (err) => resolve({ code: -1, last: err.message }));
    // The scripts print their error as "CODE: message"; a crash prints a stack trace (use its
    // "...Error: message" line, not the closing "Node.js vX" line); a killed script prints nothing
    child.on('close', (code) => {
      const lines = errors.split('\n').map((l) => l.trim()).filter(Boolean);
      const last = lines.findLast((l) => /^[A-Z_]+: /.test(l)) || lines.find((l) => /Error\b.*:/.test(l)) || '';
      resolve({ code, last });
    });
  });
}

// Errors print as "CODE: message"; show only the message
const messageOf = (line, code) => line.replace(/^[A-Z_]+:\s*/, '') || `Stopped (exit ${code})`;

export function startPsSync(email) {
  if (['connecting', 'syncing'].includes(state.job.status)) return psPhilgepsStatus();
  const job = (state.job = { status: 'syncing', percent: 0, stage: 'Starting', error: null, by: email, startedAt: Date.now(), finishedAt: null });
  const finish = (fields) => Object.assign(job, { finishedAt: Date.now() }, fields);

  (async () => {
    if (!connectedAt()) {
      // A Google Chrome log-in window opens on this computer; switchToLiveView() swaps it for a picture of
      // the log-in page inside the dashboard (the fallback if the window misbehaves)
      Object.assign(job, { status: 'connecting', stage: 'Waiting for the captcha', view: 'window' });
      let connect = await runScript(['ps-philgeps-session.js', '--connect'], { onChild: (child) => (state.connectChild = child) });
      if (state.switchToLive) {
        state.switchToLive = false;
        job.view = 'live';
        connect = await runScript(['ps-philgeps-session.js', '--connect', '--live'], {
          onFrame: (frame) => (state.live = { frame, at: Date.now() }),
          onChild: (child) => (state.connectChild = child),
        });
      }
      state.live = null;
      state.connectChild = null;
      if (connect.code !== 0) return finish({ status: 'failed', error: messageOf(connect.last, connect.code) });
      Object.assign(job, { status: 'syncing', stage: 'Connected' });
    }
    const sync = await runScript(['ps-philgeps-sync.js', '--progress'], { onProgress: (p) => Object.assign(job, p) });
    if (sync.code !== 0) return finish({ status: 'failed', error: messageOf(sync.last, sync.code) });
    finish({ status: 'success', percent: 100 });
  })();

  return psPhilgepsStatus();
}

// Closes the log-in window and shows the log-in page inside the dashboard instead
export function switchToLiveView() {
  const child = state.connectChild;
  if (state.job.status !== 'connecting' || state.job.view !== 'window' || !child?.stdin?.writable) return false;
  state.switchToLive = true;
  child.stdin.write('CANCEL\n');
  return true;
}

// Latest picture of the log-in page while connecting (JPEG), or null
export function liveFrame() {
  return state.live?.frame ? Buffer.from(state.live.frame, 'base64') : null;
}

// A click on the live picture, in page pixels; the session script passes it to the log-in page
export function liveClick(x, y) {
  const child = state.connectChild;
  if (!child?.stdin?.writable) return false;
  child.stdin.write(`CLICK ${Math.round(x)} ${Math.round(y)}\n`);
  return true;
}
