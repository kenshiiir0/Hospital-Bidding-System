const { execFileSync } = require('node:child_process');
const path = require('node:path');

// One-time setup per team laptop: teaches Windows the link "ps-philgeps-connect:", which the
// dashboard's Sync button opens when PS-PhilGEPS isn't connected. The link runs
// "Connect PS-PhilGEPS.vbs" from this project folder with wscript, so no console window shows: only
// the Chrome log-in window (a person ticks the captcha, the session goes to Supabase); the dashboard
// then starts the Sync by itself.
// Current Windows user only (HKCU), no admin rights. Undo: node tools/register-connect-link.js --remove
const KEY = 'HKCU\\Software\\Classes\\ps-philgeps-connect';
const SCRIPT = path.join(__dirname, '..', 'Connect PS-PhilGEPS.vbs');

function reg(...args) {
    execFileSync('reg', args, { stdio: 'pipe' });
}

if (process.platform !== 'win32') {
    console.error('This setup is for Windows.');
    process.exit(1);
}
if (process.argv.includes('--remove')) {
    try {
        reg('delete', KEY, '/f');
    } catch {}
    console.log('Removed the ps-philgeps-connect: link.');
} else {
    reg('add', KEY, '/ve', '/d', 'URL:Connect PS-PhilGEPS', '/f');
    reg('add', KEY, '/v', 'URL Protocol', '/d', '', '/f');
    // The link's own text is ignored: it can only start the normal log-in
    reg('add', `${KEY}\\shell\\open\\command`, '/ve', '/d', `wscript.exe "${SCRIPT}"`, '/f');
    console.log(`Done. The dashboard's Sync button can now open the PS-PhilGEPS log-in on this laptop (${SCRIPT}).`);
}
