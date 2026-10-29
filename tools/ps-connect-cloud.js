require('dotenv').config({ quiet: true });
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// PS-PhilGEPS Connect in the cloud (.github/workflows/ps-connect.yml), so anyone signed in to the dashboard can
// reconnect from any device: runs `node ps-philgeps-session.js --connect --live` here and relays it through
// Supabase (philgeps_sync_relay):
// - row 'ps-connect': job { id, status starting|connecting|success|failed, view 'live', frame (base64 JPEG of the
//   log-in page), error }, read by the deployed dashboard (lib/psCloudConnect.mjs),
// - row 'ps-connect-input': job { id, click: { x, y, at } | cancel }, written by the dashboard; each new click is
//   passed to the log-in page.
// A person ticks the captcha on the picture; the session script saves the session to Supabase itself.
// Usage: node tools/ps-connect-cloud.js <connect id>   (SUPABASE_URL, SUPABASE_KEY, PS_PHILGEPS_* in the env)
const ID = process.argv[2];
const FRAME_EVERY_MS = 700;
const INPUT_EVERY_MS = 400;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const table = () => supabase.from('philgeps_sync_relay');

let job = { id: ID, status: 'connecting', view: 'live', frame: null, error: null };
const save = () => table().upsert({ id: 'ps-connect', job, updated_at: new Date().toISOString() }).then(({ error }) => error && console.warn(`Saving: ${error.message}`));

async function main() {
  if (!ID) throw new Error('Usage: node tools/ps-connect-cloud.js <connect id>');
  const { data } = await table().select('job').eq('id', 'ps-connect').maybeSingle();
  // Another connect was started since this one was asked for: leave it alone
  if (data?.job?.id && data.job.id !== ID) return console.log('A newer connect is running; stopping.');
  job = { ...data?.job, ...job };
  await save();

  const child = spawn(process.execPath, ['ps-philgeps-session.js', '--connect', '--live'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PS_LIVE_HEADFUL: '1' },
  });

  // The latest picture, sent at most every FRAME_EVERY_MS
  let frame = null;
  let pending = '';
  child.stdout.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith('FRAME ')) frame = line.slice('FRAME '.length).trim();
      else if (line.trim()) console.log(line.trim());
    }
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const frames = setInterval(() => {
    if (!frame || frame === job.frame) return;
    job.frame = frame;
    save();
  }, FRAME_EVERY_MS);

  // The person's clicks (and Cancel) from the dashboard
  let lastClick = null;
  const input = setInterval(async () => {
    const { data: row } = await table().select('job').eq('id', 'ps-connect-input').maybeSingle();
    const asked = row?.job;
    if (!asked || asked.id !== ID || !child.stdin.writable) return;
    if (asked.cancel) child.stdin.write('CANCEL\n');
    else if (asked.click && asked.click.at !== lastClick) {
      lastClick = asked.click.at;
      child.stdin.write(`CLICK ${Math.round(asked.click.x)} ${Math.round(asked.click.y)}\n`);
    }
  }, INPUT_EVERY_MS);

  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(frames);
  clearInterval(input);
  // The script prints its error as "CODE: message"
  const last = errors.split('\n').map((l) => l.trim()).filter(Boolean).findLast((l) => /^[A-Z_]+: /.test(l)) || '';
  job = { ...job, frame: null, finishedAt: Date.now(), ...(code === 0 ? { status: 'success' } : { status: 'failed', error: last.replace(/^[A-Z_]+:\s*/, '') || `Stopped (exit ${code})` }) };
  await save();
  console.log(code === 0 ? 'Connected to PS-PhilGEPS.' : `Not connected: ${job.error}`);
  if (code !== 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e.message);
  job = { ...job, frame: null, status: 'failed', error: e.message, finishedAt: Date.now() };
  await save();
  process.exitCode = 1;
});
