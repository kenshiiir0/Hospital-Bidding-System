import { supabase } from '@/lib/supabase';

// fetch() for API routes that need the signed-in user: adds the user's access token. The token is
// short-lived and renewed in the background, but a tab left open (browsers slow background timers) can
// still send an expired one; the server then answers 401, so renew the session once and try again.
export async function authFetch(url, options = {}) {
  const send = (session) => {
    const headers = new Headers(options.headers);
    if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
    return fetch(url, { ...options, headers });
  };
  const { data } = await supabase.auth.getSession();
  const res = await send(data.session);
  if (res.status !== 401) return res;
  const { data: renewed } = await supabase.auth.refreshSession();
  return renewed.session ? send(renewed.session) : res;
}
