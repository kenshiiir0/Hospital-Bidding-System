// The browser half of our own sign-in (lib/ownAuth.mjs, NEXT_PUBLIC_AUTH_MODE=own with AUTH_MODE=own on the server):
// stands in for supabase.auth with the few calls the pages use (AuthGate, LoginScreen, Sidebar, authFetch,
// HospitalLinks), so they stay as they are. The session is an httpOnly cookie the browser sends by itself with every
// request to our server; pages never see it. A "session" here is { user } (no access token: requests are signed in by
// the cookie, and auth.js reads that cookie when AUTH_MODE=own).

const listeners = new Set();
let current; // undefined: not asked yet
let asking = null;

const tell = (event, session) => {
  current = session;
  for (const fn of listeners) {
    try {
      fn(event, session);
    } catch {
      // one page's listener must not stop the others
    }
  }
};

async function ask() {
  asking ||= fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { user: null }))
    .then(({ user }) => (user ? { user } : null))
    .catch(() => null)
    .finally(() => {
      asking = null;
    });
  return asking;
}

export const ownAuth = {
  async getSession() {
    if (current === undefined) current = await ask();
    return { data: { session: current }, error: null };
  },

  // Asked again (authFetch does this after a 401): the cookie may have ended
  async refreshSession() {
    const session = await ask();
    if ((session?.user?.id || null) !== (current?.user?.id || null)) tell(session ? 'SIGNED_IN' : 'SIGNED_OUT', session);
    else current = session;
    return { data: { session }, error: null };
  },

  async getUser() {
    const { data } = await this.getSession();
    return { data: { user: data.session?.user || null }, error: null };
  },

  onAuthStateChange(fn) {
    listeners.add(fn);
    return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
  },

  async signInWithPassword({ email, password }) {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.user) return { data: { session: null, user: null }, error: { message: body.error || `Sign-in failed (${res.status}).` } };
      const session = { user: body.user };
      tell('SIGNED_IN', session);
      return { data: { session, user: body.user }, error: null };
    } catch (e) {
      return { data: { session: null, user: null }, error: { message: e.message } };
    }
  },

  // Ends this browser's session (scope 'local' or not: our sessions are per browser anyway)
  async signOut() {
    if (current !== null) {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      tell('SIGNED_OUT', null);
    }
    return { error: null };
  },
};
