require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');

// Schedules the hourly public PhilGEPS update in Supabase (pg_cron + pg_net): every hour 6 AM–5 PM Philippine
// time the database calls <site>/api/philgeps-update with the CRON_SECRET from .env (at 6 AM that also starts
// the documents Sync). Replaces cron.js on the office PC. Re-run after changing the site address or
// CRON_SECRET; --remove unschedules. The PS-PhilGEPS keep-alive has its own tool (setup-keepalive.js).
//   node tools/setup-schedules.js https://hospital-bidding-automation.vercel.app
// (Kept out of schema.sql because the job contains the secret.)
const JOB = 'philgeps-hourly-update';
// 6 AM–5 PM in Manila (UTC+8) = 22:00–09:00 UTC
const SCHEDULE = '0 22,23,0-9 * * *';

async function main() {
    const site = process.argv[2];
    const remove = process.argv.includes('--remove');
    if (!remove && !/^https:\/\//.test(site || '')) throw new Error('Usage: node tools/setup-schedules.js https://<deployed site> | --remove');
    if (!remove && !process.env.CRON_SECRET) throw new Error('CRON_SECRET is not set in .env');

    const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    try {
        await db.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
        await db.query('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions');
        await db.query('SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1', [JOB]);
        if (remove) return console.log('Hourly update removed.');
        const command = `SELECT net.http_get(url := ${literal(`${site.replace(/\/$/, '')}/api/philgeps-update`)}, ` +
            `headers := jsonb_build_object('Authorization', ${literal(`Bearer ${process.env.CRON_SECRET}`)}), timeout_milliseconds := 30000)`;
        await db.query('SELECT cron.schedule($1, $2, $3)', [JOB, SCHEDULE, command]);
        console.log(`Hourly update scheduled (6 AM–5 PM Manila) → ${site}/api/philgeps-update`);
    } finally {
        await db.end();
    }
}

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
