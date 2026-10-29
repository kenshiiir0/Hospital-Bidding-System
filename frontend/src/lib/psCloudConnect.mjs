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

const live = (row) => ['starting', 'connecting'].includes(row.job?.status) && Date.now() - Date.parse(row.updated_at || 0) < STALE_MS;

/** The cloud connect's status as the dashboard shows it ({ job: { status, view, error, by } }), without the picture */
export async function cloudConnectStatus() {
  const row = await readRow('ps-connect');
  if (!row.job) return { job: { status: 'idle' } };
  const { frame, ...job } = row.job;
  // A job GitHub stopped without a word (time limit, cancelled) is not "connecting" for ever
  if (['starting', 'connecting'].includes(job.status) && !live(row)) return { job: { ...job, status: 'failed', error: 'The log-in browser stopped. Press Sync PS-PhilGEPS to try again.' } };
  return { job: { ...job, hasFrame: Boolean(frame) } };
}

/** Starts a cloud connect for `by` (or returns the one already running) */
export async function startCloudConnect(by) {
  const row = await readRow('ps-connect');
  if (live(row)) return cloudConnectStatus();
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
