import { createClient } from '@supabase/supabase-js';

// Server side: the signed-in team member behind an API request. The browser sends its Supabase access
// token (see authFetch.js); Supabase confirms it is valid and still signed in, and the account must be
// marked as a team member (app_metadata.team, set by tools/add-user.js).
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Returns { user } or { response } (a 401 to send back)
export async function requireUser(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data.user?.app_metadata?.team) return { user: data.user };
  }
  return { response: Response.json({ ok: false, error: 'Sign in first.' }, { status: 401 }) };
}
