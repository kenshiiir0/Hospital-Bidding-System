import { randomUUID } from 'node:crypto';
import { admin } from './ocrQueue.mjs';

// PS-PhilGEPS Connect from any device (the deployed dashboard): a GitHub job (.github/workflows/ps-connect.yml,
// tools/ps-connect-cloud.js) opens the log-in page in Chrome with everything filled in, and its picture shows in
// the dashboard (PsLiveLogin), where whoever pressed Sync PS-PhilGEPS ticks "I'm not a robot". No laptop setup,
// no passwords on any device. Relayed through philgeps_sync_relay rows 'ps-connect' (status and picture, written
// by the job) and 'ps-connect-input' (clicks, written here). Needs GITHUB_OCR_TOKEN ("Actions: Read and write" on
// this repository) on the server and the job's repository secrets.

const REPO = process.env.GITHUB_REPOSITORY_NAME || 'kenshiiir0/Hospital-Bidding-System';
const WORKFLOW = 'ps-connect.yml';
// GitHub takes a minute or two to start the job; one not heard from for this long has stopped
const STALE_MS = 4 * 60 * 1000;

const table = () => admin().from('philgeps_sync_relay');

async function readRow(id) {
  const { data } = await table().select('job, updated_at').eq('id', id).maybeSingle();
  return data || {};
}

// The office laptop takes a log-in within seconds; one it hasn't taken in a minute went to sleep or lost its internet
const HOST_TAKE_MS = 60 * 1000;
const hostMissed = (row) => Boolean(row.job?.host) && row.job.status === 'starting' && Date.now() - Date.parse(row.updated_at || 0) > HOST_TAKE_MS;
const live = (row) => ['starting', 'connecting'].includes(row.job?.status) && Date.now() - Date.parse(row.updated_at || 0) < STALE_MS && !hostMissed(row);

/** The cloud connect's status as the dashboard shows it ({ job: { status, view, error, by, hostOnline } }), without
 * the picture. hostOnline: the office log-in laptop is on, so every device's Sync uses it (even a browser that chose
 * the pop-up, which on a laptop not set up opened nothing, user 2026-11-12) */
export async function cloudConnectStatus() {
  const [row, hostOn] = await Promise.all([readRow('ps-connect'), hostOnline().catch(() => false)]);
  if (!row.job) return { job: { status: 'idle', hostOnline: hostOn } };
  const { frame, ...job } = row.job;
  if (hostMissed(row)) {
    return { job: { ...job, hostOnline: hostOn, status: 'failed', error: 'The office log-in laptop did not answer. Press Sync PS-PhilGEPS again.' } };
  }
  // A job GitHub stopped without a word (time limit, cancelled) is not "connecting" for ever
  if (['starting', 'connecting'].includes(job.status) && !live(row)) return { job: { ...job, hostOnline: hostOn, status: 'failed', error: 'The log-in browser stopped. Press Sync PS-PhilGEPS to try again.' } };
  return { job: { ...job, hostOnline: hostOn, hasFrame: Boolean(frame) } };
}

// The office log-in laptop (tools/ps-connect-host.js) checked in this recently: the log-in opens there, in its own
// Chrome on the office internet, where the captcha passes with one tick; GitHub's computer (a data-centre address)
// got everyone stuck in slow picture puzzles (user 2026-11-12). GitHub stays the fallback when the laptop is off.
const HOST_ONLINE_MS = 90 * 1000;

async function hostOnline() {
  const { data } = await table().select('worker_seen_at').eq('id', 'ps-connect-host').maybeSingle();
  return Boolean(data?.worker_seen_at) && Date.now() - Date.parse(data.worker_seen_at) < HOST_ONLINE_MS;
}

/** Starts a connect for `by` (or returns the one already running): on the office log-in laptop when it is online, else on GitHub */
export async function startCloudConnect(by) {
  const row = await readRow('ps-connect');
  if (live(row)) return cloudConnectStatus();
  // A laptop that missed the last log-in (online but not answering) is skipped once: that one goes to GitHub
  if (!hostMissed(row) && (await hostOnline().catch(() => false))) {
    // The laptop picks it up within a few seconds (it looks for status 'starting' with host: true)
    await table().upsert({ id: 'ps-connect', job: { id: randomUUID(), status: 'starting', view: 'live', host: true, by: by || null, startedAt: Date.now(), error: null }, updated_at: new Date().toISOString() });
    return cloudConnectStatus();
  }
  const token = process.env.GITHUB_OCR_TOKEN;
  if (!token) throw new Error('GITHUB_OCR_TOKEN is not set on the server, so the log-in browser cannot be started.');
  const id = randomUUID();
  await table().upsert({ id: 'ps-connect', job: { id, status: 'starting', view: 'live', by: by || null, startedAt: Date.now(), error: null }, updated_at: new Date().toISOString() });
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs: { id } }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    const error = `GitHub did not start the log-in browser (HTTP ${res.status} ${body.slice(0, 120)})`;
    await table().upsert({ id: 'ps-connect', job: { id, status: 'failed', view: 'live', by: by || null, error }, updated_at: new Date().toISOString() });
    throw new Error(error);
  }
  return cloudConnectStatus();
}

/** The latest picture of the log-in page (JPEG), or null */
export async function cloudFrame() {
  const row = await readRow('ps-connect');
  return live(row) && row.job.frame ? Buffer.from(row.job.frame, 'base64') : null;
}

/** A click on the picture (page pixels), or { cancel: true }, passed to the running connect */
export async function cloudInput(input) {
  const row = await readRow('ps-connect');
  if (!live(row)) return false;
  const job = input.cancel ? { id: row.job.id, cancel: true } : { id: row.job.id, click: { x: input.x, y: input.y, at: Date.now() } };
  const { error } = await table().upsert({ id: 'ps-connect-input', job, updated_at: new Date().toISOString() });
  return !error;
}
