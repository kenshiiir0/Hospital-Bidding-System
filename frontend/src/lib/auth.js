import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { OWN_AUTH, readSessionToken, sameOrigin, sessionUser } from './ownAuth.mjs';

// Server side: is this request from a schedule ("Authorization: Bearer <CRON_SECRET>")? False when
// CRON_SECRET is not set. Compared in constant time (as hashes, so the lengths match) so the answer
// time gives nothing away about the secret.
export function hasCronSecret(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const hash = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(request.headers.get('authorization') || ''), hash(`Bearer ${secret}`));
}

// Server side: the signed-in team member behind an API request. The browser sends its Supabase access
// token (see authFetch.js); Supabase confirms it is valid and still signed in, and the account must be
// marked as a team member (app_metadata.team, set by tools/add-user.js).
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const acceptedTokens = new Map();

// Returns { user } or { response } (a 401 to send back). With AUTH_MODE=own the session cookie of our own
// sign-in (ownAuth.mjs) is used instead, and a change must come from the dashboard's own pages.
export async function requireUser(request) {
  if (OWN_AUTH) {
    const refused = Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 });
    if (!sameOrigin(request)) return { response: refused };
    const user = await sessionUser(readSessionToken(request)).catch((e) => {
      console.error(`[auth] session check failed: ${e.message}`);
      return null;
    });
    return user?.app_metadata.team ? { user } : { response: refused };
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token) {
    // A page sends many requests in a row (all of them, with /api/data): an accepted token is trusted for a minute
    // instead of asking Supabase each time. A sign-out elsewhere is then noticed within that minute.
    const key = createHash('sha256').update(token).digest('base64');
    const known = acceptedTokens.get(key);
    if (known && known.until > Date.now()) return { user: known.user };
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user?.app_metadata?.team) {
      if (acceptedTokens.size >= 500) acceptedTokens.clear();
      acceptedTokens.set(key, { user: data.user, until: Date.now() + 60_000 });
      return { user: data.user };
    }
  }
  return { response: Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 }) };
}
