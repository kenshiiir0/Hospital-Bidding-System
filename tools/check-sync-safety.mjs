// Safety check run before every push (git pre-push hook, see tools/install-safety-hook.js) and by hand:
//   node tools/check-sync-safety.mjs
// It starts a stand-in PhilGEPS on this computer that behaves like the real one where it matters (one session per
// account, "currently in use", the log-out page handing out a fresh anonymous session, the Log-out button's
// ClearPassPhraseCached call) and runs the server Sync's own log-in / log-out code against it. The real PhilGEPS
// account is never used. Any failure blocks the push: the log-out must never be reported done while PhilGEPS
// still holds the session (2026-10-23).
import http from 'node:http';
import assert from 'node:assert/strict';

const USER_ID = '4321';
const IN_USE = 'The user id you have provided is currently in use';

// ---------- the stand-in PhilGEPS ----------

const state = {
  sessions: new Map(), // session id -> { loggedIn, alert, cleared }
  accountHolder: null, // session id holding the account (PhilGEPS allows one)
  logoutWorks: true, // false: LogoutRedirect.aspx ignores the log-out (the bug the check must catch)
  loginPosts: 0,
};
let nextId = 1;

function cookiesOf(req) {
  return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
}

function newSession(res) {
  const id = `s${nextId++}`;
  state.sessions.set(id, { loggedIn: false, alert: null, cleared: false });
  res.setHeader('Set-Cookie', [`ASP.NET_SessionId=${id}; path=/; HttpOnly`, `PHILGEPS_AFC=afc${nextId}; Path=/`]);
  return id;
}

function redirect(res, to, extraCookies = []) {
  if (extraCookies.length) res.setHeader('Set-Cookie', extraCookies);
  res.writeHead(302, { location: to });
  res.end('<html><body>Object moved</body></html>');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const sid = cookiesOf(req)['ASP.NET_SessionId'];
  const session = state.sessions.get(sid);
  const path = url.pathname;

  if (path === '/GEPS/log-in.aspx') {
    // Every visit hands out a fresh anonymous session, even to a logged-in visitor (the trap of 2026-10-23: a
    // check made with it always looks logged out)
    const id = newSession(res);
    const alert = session?.alert;
    if (session) session.alert = null;
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(
      `<html><body><form method="post" action="logInAction.aspx"><input type="hidden" name="__VIEWSTATE" value="vs${id}">` +
        `<input id="userName" name="userName"><input id="password" name="password" type="password"></form>` +
        (alert ? `<script>alert('${alert}')</script>` : '') +
        '</body></html>'
    );
  }
  if (path === '/GEPS/logInAction.aspx' && req.method === 'POST') {
    state.loginPosts++;
    if (!session) return redirect(res, '/GEPS/log-in.aspx');
    if (state.accountHolder && state.accountHolder !== sid) {
      session.alert = IN_USE;
      return redirect(res, '/GEPS/log-in.aspx');
    }
    session.loggedIn = true;
    state.accountHolder = sid;
    return redirect(res, '/GEPS/Tender/PendingTaskUI.aspx?EPSSubMenuID=45');
  }
  if (path === '/GEPS/responsewrite.aspx') {
    if (session?.loggedIn) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`${USER_ID}-5-99-x-x-x-x-false`);
    }
    return redirect(res, '/GEPS/log-in.aspx');
  }
  if (path === '/GEPS/Tender/PendingTaskUI.aspx') {
    if (session?.loggedIn) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>Pending Task <a onclick="logOut()">Log-out</a></body></html>');
    }
    return redirect(res, '/GEPS/log-in.aspx');
  }
  if (path === '/p4_webservices/GEPSR3_Common_Service.asmx/ClearPassPhraseCached') {
    if (session?.loggedIn && url.searchParams.get('userID') === USER_ID) session.cleared = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"d":true}');
  }
  if (path === '/GEPS/LogoutRedirect.aspx') {
    // Like the Log-out button: closes the session only after ClearPassPhraseCached
    if (state.logoutWorks && session?.loggedIn && session.cleared) {
      session.loggedIn = false;
      if (state.accountHolder === sid) state.accountHolder = null;
    }
    return redirect(res, '/GEPS/log-in.aspx', [`PHILGEPS_AFC=afc${nextId++}; Path=/`]);
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------- the checks ----------

await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.PHILGEPS_TEST_HOST = `http://127.0.0.1:${server.address().port}`;
process.env.PHILGEPS_USERNAME = 'test-user';
process.env.PHILGEPS_PASSWORD = 'test-password';
// No database: the log-in guard and the log-in record are skipped
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

const sync = await import('../frontend/src/lib/philgepsSync.mjs');
const reset = () => Object.assign(state, { sessions: new Map(), accountHolder: null, logoutWorks: true, loginPosts: 0 });

const checks = [
  [
    'After the Sync logs out, PhilGEPS frees the account (a new log-in works)',
    async () => {
      const session = new sync.Session();
      await sync.login(session, async () => {});
      assert.ok(state.accountHolder, 'log-in should hold the account');
      assert.equal(await sync.logout(session), true, 'log-out should be confirmed');
      assert.equal(state.accountHolder, null, 'PhilGEPS still holds the account after a confirmed log-out');
      await sync.login(new sync.Session(), async () => {});
    },
  ],
  [
    'A log-out PhilGEPS ignores is never reported as done',
    async () => {
      const session = new sync.Session();
      await sync.login(session, async () => {});
      state.logoutWorks = false;
      assert.equal(await sync.logout(session), false, 'log-out reported done while PhilGEPS still holds the session');
    },
  ],
  [
    '"Account in use" is reported as in use, and the password is sent only once',
    async () => {
      await sync.login(new sync.Session(), async () => {});
      state.loginPosts = 0;
      await assert.rejects(sync.login(new sync.Session(), async () => {}), (e) => e.code === 'ACCOUNT_BUSY');
      assert.equal(state.loginPosts, 1, 'the password was sent more than once');
    },
  ],
  [
    'The session cookies are saved the moment the log-in is sent (so it can always be logged out)',
    async () => {
      let saved = null;
      await sync.login(new sync.Session(), async (s) => {
        saved = s.cookies();
      });
      assert.ok(saved?.some((c) => c.name === 'ASP.NET_SessionId'), 'no session cookie was handed to onSubmitted');
    },
  ],
  [
    'A failing add-on (e.g. reading documents) is skipped and never stops the Sync',
    async () => {
      const job = {};
      const value = await sync.optional(job, 'test add-on', async () => {
        throw new Error('boom');
      }, 'fallback');
      assert.equal(value, 'fallback');
      assert.match(job.addonErrors?.[0] || '', /test add-on: boom/);
    },
  ],
];

let failed = 0;
for (const [name, run] of checks) {
  reset();
  try {
    await run();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
server.close();
if (failed) {
  console.error(`\nSync safety check FAILED (${failed} of ${checks.length}). Nothing may be pushed until it passes.`);
  process.exit(1);
}
console.log(`\nSync safety check passed (${checks.length} checks).`);
