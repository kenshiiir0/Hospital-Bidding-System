require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');

// Schedules the hourly jobs in Supabase (pg_cron + pg_net), every hour 6 AM–5 PM Philippine time, with the
// CRON_SECRET from .env:
// - on the hour: <site>/api/philgeps-update (PhilGEPS tenders, then the documents Sync when switched on),
// - a quarter past: <site>/api/ps-sync (the PS-PhilGEPS Sync, with the saved session).
// Replaces cron.js on the office PC. Re-run after changing the site address or CRON_SECRET; --remove
// unschedules. The PS-PhilGEPS keep-alive has its own tool (setup-keepalive.js).
//   node tools/setup-schedules.js https://government-bidding-automation.vercel.app
// (Kept out of schema.sql because the job contains the secret.)
// 6 AM–5 PM in Manila (UTC+8) = 22:00–09:00 UTC
const JOBS = [
    { name: 'philgeps-hourly-update', schedule: '0 22,23,0-9 * * *', path: '/api/philgeps-update', method: 'get' },
    { name: 'ps-philgeps-hourly-sync', schedule: '15 22,23,0-9 * * *', path: '/api/ps-sync', method: 'post' },
];

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
        for (const job of JOBS) {
            await db.query('SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1', [job.name]);
            if (remove) {
                console.log(`${job.name} removed.`);
                continue;
            }
            const auth = `headers := jsonb_build_object('Authorization', ${literal(`Bearer ${process.env.CRON_SECRET}`)}, 'Content-Type', 'application/json')`;
            const url = `url := ${literal(`${site.replace(/\/$/, '')}${job.path}`)}`;
            const command = job.method === 'post'
                ? `SELECT net.http_post(${url}, body := '{}'::jsonb, ${auth}, timeout_milliseconds := 30000)`
                : `SELECT net.http_get(${url}, ${auth}, timeout_milliseconds := 30000)`;
            await db.query('SELECT cron.schedule($1, $2, $3)', [job.name, job.schedule, command]);
            console.log(`${job.name} scheduled (${job.schedule} UTC = hourly 6 AM-5 PM Manila) -> ${site}${job.path}`);
        }
    } finally {
        await db.end();
    }
}

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
