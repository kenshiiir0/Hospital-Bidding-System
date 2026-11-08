import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// supabase-js sends a data request with the publishable key alone when the sign-in can't be refreshed at
// that moment (laptop just woke up, network not back yet). The database refuses such requests (schema.sql:
// no reads without sign-in) with "permission denied for table ...". So a refused data request that went
// out without the person's sign-in waits for the sign-in to come back and is sent once more with it.
// Sign-in requests themselves (/auth/v1/) are never retried here.
async function fetchSignedIn(input, init) {
  const response = await fetch(input, init);
  if (response.status !== 401 && response.status !== 403) return response;
  const url = typeof input === 'string' ? input : input.url;
  if (!/\/(rest|storage)\/v1\//.test(url)) return response;
  const headers = new Headers(init?.headers);
  if (headers.get('Authorization') !== `Bearer ${KEY}`) return response;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await pause(2000);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    }
  }
  return response;
}

// One browser client for every page (publishable key: read-only, see schema.sql)
export const supabase = createClient(URL_, KEY, { global: { fetch: fetchSignedIn } });
