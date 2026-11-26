require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');

// Copies the dashboard accounts from Supabase Auth (auth.users in SUPABASE_DB_URL) into our own sign-in
// (app_users in DATABASE_URL, frontend/src/lib/ownAuth.mjs), with the same id, email, team mark and password
// hash, so everyone keeps their password. Accounts already in app_users are left as they are (--overwrite
// replaces them). Prints names only, never hashes. The app_users table must exist there (schema.sql).
//   node tools/import-auth-users.js              (show what would be copied)
//   node tools/import-auth-users.js --apply      (copy)

async function main() {
    const apply = process.argv.includes('--apply');
    const overwrite = process.argv.includes('--overwrite');
    if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not set in .env.');

    const source = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await source.connect();
    let users;
    try {
        ({ rows: users } = await source.query(
            `SELECT id, lower(email) AS login, encrypted_password AS hash,
                    coalesce((raw_app_meta_data ->> 'team')::boolean, false) AS team,
                    banned_until IS NOT NULL AND banned_until > now() AS disabled, created_at
             FROM auth.users WHERE email IS NOT NULL AND coalesce(encrypted_password, '') <> '' AND deleted_at IS NULL
             ORDER BY created_at`
        ));
    } finally {
        await source.end();
    }

    const ownAuth = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'ownAuth.mjs')).href);
    const target = ownAuth.db();
    try {
        const { rows: existing } = await target.query('SELECT login FROM app_users');
        const have = new Set(existing.map((r) => r.login));
        for (const u of users) {
            const action = have.has(u.login) ? (overwrite ? 'replace' : 'keep') : 'copy';
            console.log(`${action.padEnd(7)} ${u.login}${u.team ? '' : '  (not a team member)'}${u.disabled ? '  (disabled)' : ''}`);
            if (!apply || action === 'keep') continue;
            await target.query(
                `INSERT INTO app_users (id, login, password_hash, team, disabled, created_at) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (login) DO UPDATE SET password_hash = EXCLUDED.password_hash, team = EXCLUDED.team,
                   disabled = EXCLUDED.disabled, password_changed_at = now()`,
                [u.id, u.login, u.hash, u.team, u.disabled, u.created_at]
            );
        }
        console.log(`${users.length} account(s) in Supabase.${apply ? ' Copied.' : ' Nothing written: add --apply to copy.'}`);
    } finally {
        await target.end();
    }
}

main().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
});
