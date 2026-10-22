import { spawn } from 'node:child_process';
import path from 'node:path';

// PS-PhilGEPS (philgeps.gov.ph) Connect, only where the dashboard runs on a team computer: runs
// `node ps-philgeps-session.js --connect`, a Google Chrome log-in window with everything filled in; a
// person ticks the reCAPTCHA and the session is saved to Supabase for the Sync (lib/psSync.mjs, which
// runs here and on the deployed dashboard). switchToLiveView() swaps the window for a picture of the
// log-in page inside the dashboard (the fallback if the window misbehaves).
const REPO_ROOT = path.resolve(process.cwd(), '..');

// status: idle | connecting | success | failed. On globalThis so dev reloads keep it.
const state = (globalThis.psPhilgepsConnect ??= { job: { status: 'idle' } });

export function psConnectStatus() {
  return { job: state.job };
}

// Runs a script in the repo root; resolves with { code, last } (its error line). Feeds "FRAME <base64>"
// lines (live view) to onFrame; onChild gets the process.
function runScript(args, { onFrame = () => {}, onChild = () => {} } = {}) {
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

export function startPsConnect(email) {
  if (state.job.status === 'connecting') return psConnectStatus();
  const job = (state.job = { status: 'connecting', view: 'window', error: null, by: email, startedAt: Date.now(), finishedAt: null });

  (async () => {
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
    Object.assign(job, { finishedAt: Date.now() }, connect.code === 0 ? { status: 'success' } : { status: 'failed', error: messageOf(connect.last, connect.code) });
  })();

  return psConnectStatus();
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
