require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// Creates a dashboard account (the dashboard has no sign-up), or resets the password of an existing one.
// Marks it as a team member (app_metadata.team = true): only those may read the data (schema.sql), and
// only the secret key from the root .env can set it. The password is printed once here: give it to the person.
// A plain username (no @) becomes <username>@users.opportunity-radar.invalid, the same rule as the
// dashboard's sign-in screen (frontend/src/lib/username.js).
//   node tools/add-user.js person@company.com            (random password)
//   node tools/add-user.js someuser "MyPass1!"           (username, chosen password)

const TEAM = { team: true };
const USERNAME_DOMAIN = 'users.opportunity-radar.invalid';

async function main() {
    const [login, chosen] = process.argv.slice(2);
    if (!login) {
        console.log('Usage: node tools/add-user.js <email or username> [password]');
        process.exit(2);
    }
    const email = (login.includes('@') ? login : `${login}@${USERNAME_DOMAIN}`).toLowerCase();
    const password = chosen || crypto.randomBytes(9).toString('base64url');
    if (password.length < 8) throw new Error('Use a password of at least 8 characters.');

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: TEAM });
    if (!error) {
        console.log(`Created ${login} (${email})`);
        if (!chosen) console.log(`Password: ${password}`);
        return;
    }
    if (!/already (been )?registered|already exists/i.test(error.message)) throw error;

    // Existing account: reset its password
    const { data, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listError) throw listError;
    const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) throw error;
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, { password, app_metadata: TEAM });
    if (updateError) throw updateError;
    console.log(`${login} already existed; password reset.`);
    if (!chosen) console.log(`Password: ${password}`);
}

main().catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
});
