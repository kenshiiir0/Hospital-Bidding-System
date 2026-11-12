import { createClient } from '@supabase/supabase-js';

// Keeps the system's log-ins to PhilGEPS (site 'philgeps') and PS-PhilGEPS ('ps-philgeps') few and calm, so
// the accounts are never locked for suspicious activity. Every log-in attempt is recorded in login_attempts
// (schema.sql); checkLogin() applies the rules below before a new log-in, from any computer or the server.
// Plain .mjs so the scraper side (CommonJS) can import() it too.
const RULES = {
  // Three refused log-ins (a wrong password, not "account in use") within the hour pause it for an hour,
  // before PhilGEPS would lock the account. A single refusal never blocks the Sync button.
  rejectedLimit: { count: 3, withinMs: 60 * 60 * 1000 },
  perHour: 6,
  perDay: 20,
  // Between two separate log-ins (the retries inside one log-in don't count)
  minGapMs: 60 * 1000,
  // "Account in use": the 6 AM schedule waits before trying again; a person pressing Sync never waits
  afterBusyMs: { schedule: 30 * 60 * 1000, person: 0 },
};

export class LoginGuardError extends Error {
  constructor(message) {
    super(message);
    this.code = 'LOGIN_PAUSED';
  }
}

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) return null;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const SITE_NAMES = { philgeps: 'PhilGEPS', 'ps-philgeps': 'PS-PhilGEPS' };
const at = (ms) => new Date(ms).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

// Throws LoginGuardError (with when it will be allowed again) if a new log-in to `site` would break a rule.
// trigger: 'person' (someone pressed a button) or 'schedule'. Without Supabase settings nothing is checked.
export async function checkLogin(site, { trigger = 'person' } = {}) {
  const db = admin();
  if (!db) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from('login_attempts').select('at, outcome, detail').eq('site', site).gte('at', since).order('at', { ascending: false });
  if (error) return; // The guard never blocks because its own table is unreachable
  const now = Date.now();
  const times = data.map((r) => ({ ...r, ms: Date.parse(r.at) }));
  const name = SITE_NAMES[site] || site;

  const lastOk = times.find((r) => r.outcome === 'ok')?.ms || 0;
  const rejected = times.filter((r) => r.outcome === 'rejected' && r.ms > lastOk);
  const recentRejected = rejected.filter((r) => now - r.ms < RULES.rejectedLimit.withinMs);
  if (recentRejected.length >= RULES.rejectedLimit.count) {
    const until = recentRejected[RULES.rejectedLimit.count - 1].ms + RULES.rejectedLimit.withinMs;
    throw new LoginGuardError(`${name} refused ${recentRejected.length} log-ins within the hour. To protect the account, log-ins are paused until ${at(until)}.`);
  }

  // Separate log-ins: one row per log-in session ('started' marks its first attempt). PS-PhilGEPS counts only
  // log-ins that sent the password ('submitted'): one that never got that far (the site's 500 page, a window
  // closed, cancelled before the captcha) never touched the account, and six of them blocked everyone for an
  // hour (user 2026-11-12). The one-minute gap still counts every start.
  const allStarts = times.filter((r) => r.outcome === 'started');
  const starts = site === 'ps-philgeps' ? times.filter((r) => r.outcome === 'submitted') : allStarts;
  const lastHour = starts.filter((r) => now - r.ms < 60 * 60 * 1000);
  if (lastHour.length >= RULES.perHour) {
    throw new LoginGuardError(`${name} has been logged in to ${lastHour.length} times in the last hour. To protect the account, the next log-in is allowed at ${at(lastHour[RULES.perHour - 1].ms + 60 * 60 * 1000)}.`);
  }
  if (starts.length >= RULES.perDay) {
    throw new LoginGuardError(`${name} has been logged in to ${starts.length} times today. To protect the account, the next log-in is allowed at ${at(starts[RULES.perDay - 1].ms + 24 * 60 * 60 * 1000)}.`);
  }
  if (allStarts[0] && now - allStarts[0].ms < RULES.minGapMs) {
    throw new LoginGuardError(`${name} was logged in to less than a minute ago. Try again at ${at(allStarts[0].ms + RULES.minGapMs)}.`);
  }
  const busy = times.find((r) => r.outcome === 'busy');
  const wait = RULES.afterBusyMs[trigger] || RULES.afterBusyMs.person;
  if (busy && busy.ms > lastOk && now - busy.ms < wait) {
    throw new LoginGuardError(`The ${name} account was in use on another device at ${at(busy.ms)}. The next try is at ${at(busy.ms + wait)}.`);
  }
}

// outcome: 'started' (a new log-in begins) | 'submitted' (PS-PhilGEPS: the password was sent) | 'ok' | 'rejected' (password refused, account locked) |
// 'busy' (in use elsewhere) | 'error' (site down / no answer). Never throws.
export async function recordLogin(site, outcome, { detail, source } = {}) {
  const db = admin();
  if (!db) return;
  await db.from('login_attempts').insert({ site, outcome, detail: detail ? String(detail).slice(0, 300) : null, source: source || null }).then(
    () => {},
    () => {}
  );
}
