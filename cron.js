// Office-PC clean-up for the old Chrome Sync (npm run cron): logs out a PhilGEPS session the PC left open.
const cron = require('node-cron');
const { sweepLeftoverSession } = require('./philgeps-session');

console.log('PhilGEPS Automated Scheduler Started...');

// Last resort for a PhilGEPS session left open (e.g. the PC lost power mid-run and its watchdog died too):
// on start and every 5 minutes, log out any saved session no running fetch is using
sweepLeftoverSession();
cron.schedule('*/5 * * * *', sweepLeftoverSession);

// The hourly PhilGEPS update (6 AM-5 PM) moved to the deployed server: Supabase calls /api/philgeps-update
// (frontend/src/lib/philgepsUpdate.mjs, scheduled by tools/setup-schedules.js), so it runs with this PC off.
// Running it here too would fetch twice. Only the leftover-session clean-up above stays on this PC.
