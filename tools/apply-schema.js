require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// Applies schema.sql to the Supabase database, so nobody has to paste it into the SQL editor.
// Needs SUPABASE_DB_URL in the root .env (Supabase → Connect → Session pooler connection string).
// The dashboard runs `node tools/apply-schema.js --if-changed` when it starts (instrumentation.js):
// it only connects when schema.sql changed since the last successful apply.
//   node tools/apply-schema.js               (apply now)
//   node tools/apply-schema.js --if-changed  (apply only if schema.sql changed)

const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');
// Fingerprint of the last schema.sql applied (gitignored, per machine)
const APPLIED_FILE = path.join(__dirname, '..', '.schema-applied');

async function main() {
    const ifChanged = process.argv.includes('--if-changed');
    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex');
    if (ifChanged && fs.existsSync(APPLIED_FILE) && fs.readFileSync(APPLIED_FILE, 'utf8').trim() === hash) {
        console.log('schema.sql unchanged; nothing to apply.');
        return;
    }
    if (!process.env.SUPABASE_DB_URL) {
        console.log('SUPABASE_DB_URL is not set in .env; schema.sql not applied.');
        process.exit(ifChanged ? 0 : 1);
    }

    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        // One multi-statement query runs as a single transaction: all of schema.sql or none of it
        // (no moment where a policy is dropped but not yet re-created)
        await client.query(sql);
    } finally {
        await client.end();
    }
    fs.writeFileSync(APPLIED_FILE, `${hash}\n`);
    console.log('schema.sql applied.');
}

main().catch((e) => {
    console.error(`schema.sql NOT applied: ${e.message}`);
    process.exit(1);
});
