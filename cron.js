// Standalone scheduler for when the dashboard is not running (npm run cron). The dashboard server has the
// same schedule built in (frontend/src/lib/fetchJobs.js), so run one or the other, not both.
// Every hour 6 AM to 5 PM: public data only. 6 AM: also tries the log-in for documents and falls back to
// public data only when the account is in use.
const { execFile } = require('node:child_process');
const cron = require('node-cron');
const { philgepsDownReason } = require('./scraper');
const { sweepLeftoverSession } = require('./philgeps-session');

console.log('PhilGEPS Automated Scheduler Started...');

// Last resort for a PhilGEPS session left open (e.g. the PC lost power mid-run and its watchdog died too):
// on start and every 5 minutes, log out any saved session no running fetch is using
sweepLeftoverSession();
cron.schedule('*/5 * * * *', sweepLeftoverSession);

// PhilGEPS down: check again this often within the hour instead of starting a fetch that can't work
const DOWN_RETRY_MS = 15 * 60 * 1000;
const DOWN_TRIES = 3;
let running = false;

cron.schedule('0 6-17 * * *', async () => {
  const hour = new Date().getHours();
  if (running) return console.warn('Previous automatic fetch still running; skipping this hour');
  for (let attempt = 1; ; attempt++) {
    const reason = await philgepsDownReason();
    if (!reason) break;
    if (attempt >= DOWN_TRIES) return console.error(`❌ Automatic fetch skipped: ${reason}`);
    console.warn(`PhilGEPS is down (${reason}); checking again in ${DOWN_RETRY_MS / 60000} minutes`);
    await new Promise((resolve) => setTimeout(resolve, DOWN_RETRY_MS));
  }

  const args = ['scraper.js', '--trigger=schedule', ...(hour === 6 ? [] : ['--no-login'])];
  console.log(`⏰ Automatic fetch (${hour === 6 ? 'public data + documents' : 'public data'})...`);
  running = true;
  // Generous cap only against a stuck process; the scraper's watchdog logs PhilGEPS out if it is killed
  execFile(process.execPath, args, { cwd: __dirname, timeout: 2 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    running = false;
    // Log and keep the scheduler alive for the next run
    if (error) console.error('❌ Automatic fetch failed:', stderr.trim().split('\n').pop() || error.message);
    else console.log('✅ Automatic fetch done');
  });
});
