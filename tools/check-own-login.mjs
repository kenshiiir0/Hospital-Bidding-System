// Checks that an account can sign in with our own sign-in (frontend/src/lib/ownAuth.mjs, app_users in DATABASE_URL)
// BEFORE it is switched on (AUTH_MODE=own), so nobody is locked out. Asks for the username or e-mail and the password
// (not shown while typing), signs in exactly as the log-in screen will, then ends that test session at once.
// Nothing else changes. From Coolify's Terminal (it opens in /app/frontend):
//   node ../tools/check-own-login.mjs
import readline from 'node:readline';
import { signIn, signOut } from '../frontend/src/lib/ownAuth.mjs';

// One reader for both questions, read line by line in order (typed, pasted or piped alike)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
let muted = false;
const write = rl._writeToOutput.bind(rl);
// While the password is typed nothing of it is shown
rl._writeToOutput = (text) => {
  if (!muted) write(text);
};
async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  return value || '';
}

const login = (await ask('Username or e-mail: ')).trim();
const password = await ask('Password (not shown): ', true);
rl.close();
try {
  const result = await signIn(login, password, { ip: 'terminal-check', userAgent: 'tools/check-own-login.mjs' });
  if (result.error) {
    console.log(`NOT OK: ${result.error}`);
    process.exit(1);
  }
  await signOut(result.token);
  console.log(`OK: ${result.user.email} can sign in${result.user.app_metadata.team ? ' (team member)' : ' (NOT marked as a team member: the dashboard would not open)'}.`);
  process.exit(0);
} catch (e) {
  console.log(`Could not check: ${e.message}`);
  process.exit(1);
}
