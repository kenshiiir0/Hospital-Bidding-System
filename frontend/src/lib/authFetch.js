import { supabase } from '@/lib/supabase';

// fetch() for API routes that act on PhilGEPS: adds the signed-in user's access token
export async function authFetch(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(options.headers);
  if (data.session) headers.set('Authorization', `Bearer ${data.session.access_token}`);
  return fetch(url, { ...options, headers });
}
