require('dotenv').config({ quiet: true });
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// PS-PhilGEPS Connect in the cloud (.github/workflows/ps-connect.yml), so anyone signed in to the dashboard can
// reconnect from any device: runs `node ps-philgeps-session.js --connect --live` here and relays it.
// - Live: a private Realtime channel "ps-connect:<id>" (team accounts only, schema.sql) carries every changed
//   picture of the log-in page ("frame") to the dashboard and every click ("click" { x, y }, "cancel") back, so
//   the captcha and Google's picture puzzle answer in a fraction of a second (PsLiveLogin).
// - Fallback, if the channel can't be used: philgeps_sync_relay row 'ps-connect' (status, and the picture every
//   few seconds) and row 'ps-connect-input' (the latest click), through the dashboard's server (lib/psCloudConnect.mjs).
// A person ticks the captcha; the session script saves the session to Supabase itself.
// Usage: node tools/ps-connect-cloud.js <connect id>   (SUPABASE_URL, SUPABASE_KEY, PS_PHILGEPS_* in the env)
const ID = process.argv[2];
// Pictures: at most every STREAM_EVERY_MS on the channel, every SAVE_EVERY_MS in the database
const STREAM_EVERY_MS = 200;
const SAVE_EVERY_MS = 2500;
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
    env: { ...process.env, PS_LIVE_HEADFUL: '1', PS_LIVE_FRAME_MS: '150', PS_LIVE_QUALITY: '60' },
  });
  const send = (line) => child.stdin.writable && child.stdin.write(`${line}\n`);

  // The latest picture of the log-in page
  let frame = null;

  // The live channel
  const channel = supabase.channel(`ps-connect:${ID}`, { config: { private: true, broadcast: { self: false } } });
  let streaming = false;
  channel
    .on('broadcast', { event: 'click' }, ({ payload }) => {
      if (Number.isFinite(payload?.x) && Number.isFinite(payload?.y)) send(`CLICK ${Math.round(payload.x)} ${Math.round(payload.y)}`);
    })
    .on('broadcast', { event: 'cancel' }, () => send('CANCEL'))
    // A dashboard that just opened asks for the current picture
    .on('broadcast', { event: 'hello' }, () => frame && channel.send({ type: 'broadcast', event: 'frame', payload: { f: frame } }))
    .subscribe((status) => {
      streaming = status === 'SUBSCRIBED';
      console.log(`Live channel: ${status}`);
    });

  // Streamed when it changes, saved now and then
  let streamed = null;
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
  const stream = setInterval(() => {
    if (!streaming || !frame || frame === streamed) return;
    streamed = frame;
    channel.send({ type: 'broadcast', event: 'frame', payload: { f: frame } }).catch(() => {});
  }, STREAM_EVERY_MS);
  const saves = setInterval(() => {
    if (!frame || frame === job.frame) return;
    job.frame = frame;
    save();
  }, SAVE_EVERY_MS);

  // Fallback clicks (and Cancel) through the dashboard's server
  let lastClick = null;
  const input = setInterval(async () => {
    const { data: row } = await table().select('job').eq('id', 'ps-connect-input').maybeSingle();
    const asked = row?.job;
    if (!asked || asked.id !== ID) return;
    if (asked.cancel) send('CANCEL');
    else if (asked.click && asked.click.at !== lastClick) {
      lastClick = asked.click.at;
      send(`CLICK ${Math.round(asked.click.x)} ${Math.round(asked.click.y)}`);
    }
  }, INPUT_EVERY_MS);

  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(stream);
  clearInterval(saves);
  clearInterval(input);
  // The script prints its error as "CODE: message"
  const last = errors.split('\n').map((l) => l.trim()).filter(Boolean).findLast((l) => /^[A-Z_]+: /.test(l)) || '';
  job = { ...job, frame: null, finishedAt: Date.now(), ...(code === 0 ? { status: 'success' } : { status: 'failed', error: last.replace(/^[A-Z_]+:\s*/, '') || `Stopped (exit ${code})` }) };
  await save();
  await channel.send({ type: 'broadcast', event: 'done', payload: { status: job.status, error: job.error || null } }).catch(() => {});
  await supabase.removeChannel(channel).catch(() => {});
  console.log(code === 0 ? 'Connected to PS-PhilGEPS.' : `Not connected: ${job.error}`);
  if (code !== 0) process.exitCode = 1;
  process.exit();
}

main().catch(async (e) => {
  console.error(e.message);
  job = { ...job, frame: null, status: 'failed', error: e.message, finishedAt: Date.now() };
  await save();
  process.exit(1);
});
