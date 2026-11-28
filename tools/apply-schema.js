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
    // The database the app uses: the private one with DATA_BACKEND=pg (it has the stand-ins for Supabase's own parts,
    // tools/copy-to-private-db.mjs), else Supabase
    const url = process.env.DATA_BACKEND === 'pg' ? process.env.DATABASE_URL : process.env.SUPABASE_DB_URL;
    if (!url) {
        console.log(`${process.env.DATA_BACKEND === 'pg' ? 'DATABASE_URL' : 'SUPABASE_DB_URL'} is not set; schema.sql not applied.`);
        process.exit(ifChanged ? 0 : 1);
    }

    // sslmode in the address decides (Coolify's internal one: sslmode=require with SSL on); without it a dotless host or
    // localhost is plain, anything else encrypted (same rule as frontend/src/lib/db/pgClient.mjs connectionOptions)
    const parsed = new URL(url);
    const mode = parsed.searchParams.get('sslmode');
    const local = !parsed.hostname.includes('.') || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    parsed.searchParams.delete('sslmode');
    const client = new Client({ connectionString: parsed.toString(), ssl: (mode ? mode === 'disable' : local) ? false : { rejectUnauthorized: false } });
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
