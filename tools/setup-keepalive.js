require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const { Client } = require('pg');

// Schedules the PS-PhilGEPS keep-alive in Supabase (pg_cron + pg_net): every 5 minutes the database
// calls <site>/api/ps-keepalive with the CRON_SECRET from .env, so PhilGEPS doesn't end the log-in
// session for being idle. Re-run after changing the site address or CRON_SECRET; --remove unschedules.
//   node tools/setup-keepalive.js https://hospital-bidding-automation.vercel.app
// (Kept out of schema.sql because the job contains the secret.)
const JOB = 'ps-philgeps-keepalive';

async function main() {
    const site = process.argv[2];
    const remove = process.argv.includes('--remove');
    if (!remove && !/^https:\/\//.test(site || '')) throw new Error('Usage: node tools/setup-keepalive.js https://<deployed site> | --remove');
    if (!remove && !process.env.CRON_SECRET) throw new Error('CRON_SECRET is not set in .env');

    const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    try {
        await db.query('CREATE EXTENSION IF NOT EXISTS pg_cron');
        await db.query('CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions');
        await db.query('SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = $1', [JOB]);
        if (remove) return console.log('Keep-alive removed.');
        const command = `SELECT net.http_get(url := ${literal(`${site.replace(/\/$/, '')}/api/ps-keepalive`)}, ` +
            `headers := jsonb_build_object('Authorization', ${literal(`Bearer ${process.env.CRON_SECRET}`)}), timeout_milliseconds := 30000)`;
        await db.query('SELECT cron.schedule($1, $2, $3)', [JOB, '*/5 * * * *', command]);
        console.log(`Keep-alive scheduled every 5 minutes → ${site}/api/ps-keepalive`);
    } finally {
        await db.end();
    }
}

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
