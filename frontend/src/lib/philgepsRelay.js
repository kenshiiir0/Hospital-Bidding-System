import { createClient } from '@supabase/supabase-js';

// The PhilGEPS Sync can only run on a team computer (Chrome and the PhilGEPS log-in live there), but it can be
// asked for from any dashboard, including the deployed one. Supabase table philgeps_sync_relay (schema.sql,
// secret key only) carries the request one way and the progress back:
// - a dashboard without the scraper sets requested_at (requestRelaySync), then reads job (readRelay),
// - the team computer's dashboard checks every few seconds (claimRelayRequest), runs the Sync there and
//   mirrors its progress into job (publishJob); worker_seen_at says that computer is online.
const ROW = 'latest';
const WORKER_ONLINE_MS = 2 * 60 * 1000;
const PUBLISH_EVERY_MS = 1000;

let client;
function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_KEY is not set on this server');
  client = createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const table = () => db().from('philgeps_sync_relay');

export async function readRelay() {
  const { data, error } = await table().select('*').eq('id', ROW).maybeSingle();
  if (error) throw new Error(error.message);
  return data || {};
}

// A team computer's dashboard checked in recently
export const workerOnline = (row) => Boolean(row.worker_seen_at) && Date.now() - Date.parse(row.worker_seen_at) < WORKER_ONLINE_MS;

// A request no team computer has taken yet
export const requestPending = (row) =>
  Boolean(row.requested_at) && (!row.handled_at || Date.parse(row.requested_at) > Date.parse(row.handled_at));

export async function requestRelaySync(email) {
  const { error } = await table().upsert({ id: ROW, requested_at: new Date().toISOString(), requested_by: email || null, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// Team computer: say it is online, and take a waiting request (only one computer gets it). Returns the row
// when this computer should start a Sync, else null.
export async function claimRelayRequest() {
  const now = new Date().toISOString();
  const row = await readRelay();
  await table().upsert({ id: ROW, worker_seen_at: now });
  if (!requestPending(row)) return null;
  // Claimed only if nobody handled it since we read it
  let claim = table().update({ handled_at: now }).eq('id', ROW);
  claim = row.handled_at ? claim.eq('handled_at', row.handled_at) : claim.is('handled_at', null);
  const { data, error } = await claim.select();
  if (error) throw new Error(error.message);
  return data?.length ? row : null;
}

// Team computer: mirror the current fetch for dashboards elsewhere (at most once a second, last state always sent)
let lastSent = 0;
let trailing = null;
let latest = null;
export function publishJob(job) {
  latest = job;
  const send = () => {
    lastSent = Date.now();
    trailing = null;
    table()
      .upsert({ id: ROW, job: latest, updated_at: new Date().toISOString() })
      .then(({ error }) => error && console.warn('Could not share the Sync progress:', error.message));
  };
  try {
    if (Date.now() - lastSent >= PUBLISH_EVERY_MS) send();
    else trailing ??= setTimeout(send, PUBLISH_EVERY_MS);
  } catch (err) {
    // No secret key on this computer: progress just isn't shared
    console.warn('Could not share the Sync progress:', err.message);
  }
}
