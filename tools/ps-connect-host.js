require('dotenv').config({ quiet: true });
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// The office log-in laptop for PS-PhilGEPS Connect (user 2026-11-12): from GitHub's computer Google's captcha
// kept everyone in a loop of slow picture puzzles (a data-centre address), while on the office laptop's own Chrome
// and internet it passes with one tick. This keeps running on that laptop ("Start PS-PhilGEPS log-in host.vbs"):
// - every HEARTBEAT_MS it writes philgeps_sync_relay row 'ps-connect-host' (worker_seen_at = online), which makes
//   the deployed dashboard send the log-in here instead of GitHub (frontend/src/lib/psCloudConnect.mjs),
// - every POLL_MS it looks at row 'ps-connect' (status fields only, not the picture) and, for a log-in asked of
//   the host, runs tools/ps-connect-cloud.js <id> here: the same live picture and clicks as the cloud log-in, but
//   in this laptop's Chrome. Whoever pressed Sync, on any device, ticks the captcha on that picture.
// Usage: node tools/ps-connect-host.js   (SUPABASE_URL, SUPABASE_KEY, PS_PHILGEPS_* in .env)
const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 3000;
const ROOT = path.join(__dirname, '..');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const table = () => supabase.from('philgeps_sync_relay');
const log = (msg) => console.log(`${new Date().toLocaleString()}  ${msg}`);

let busy = false;
const handled = new Set();

async function heartbeat() {
  const { error } = await table().upsert({ id: 'ps-connect-host', worker_seen_at: new Date().toISOString(), job: { busy, pid: process.pid } });
  if (error) log(`Could not say online: ${error.message}`);
}

async function poll() {
  if (busy) return;
  const { data, error } = await table().select('jid:job->>id, status:job->>status, host:job->>host').eq('id', 'ps-connect').maybeSingle();
  if (error) return log(`Could not check for a log-in: ${error.message}`);
  if (!data?.jid || data.host !== 'true' || data.status !== 'starting' || handled.has(data.jid)) return;
  handled.add(data.jid);
  busy = true;
  heartbeat();
  log(`Log-in asked for (${data.jid}); opening it in Chrome here`);
  const child = spawn(process.execPath, [path.join(__dirname, 'ps-connect-cloud.js'), data.jid], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PS_SAVE_EVERY_MS: '800', PS_INPUT_EVERY_MS: '250' },
  });
  child.on('close', (code) => {
    busy = false;
    heartbeat();
    log(code === 0 ? 'Connected to PS-PhilGEPS.' : `Log-in ended without connecting (exit ${code}).`);
  });
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY must be in .env');
  log('PS-PhilGEPS log-in host is running: log-ins asked for on any device open here.');
  await heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(() => poll().catch((e) => log(`Check failed: ${e.message}`)), POLL_MS);
}

// Say offline at once when stopped, so the next log-in goes to GitHub without waiting for the heartbeat to age
async function stop() {
  await table().upsert({ id: 'ps-connect-host', worker_seen_at: null, job: { busy: false, stopped: Date.now() } }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
