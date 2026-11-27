import { createClient } from '@supabase/supabase-js';
import { authFetch } from '@/lib/authFetch';
import { createRemoteClient, readAnswer } from '@/lib/db/remoteClient.mjs';

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
    const { data } = await real.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    }
  }
  return response;
}

// Supabase's browser client (publishable key: read-only, see schema.sql)
const real = createClient(URL_, KEY, { global: { fetch: fetchSignedIn } });

// NEXT_PUBLIC_DATA_VIA_SERVER=1 (the private-server copy, built with it): supabase.from(...) is not sent to Supabase
// but to our own server (/api/data), which checks the sign-in and the same rules and runs it on its database. The
// page code stays the same: the query is written down step by step and sent when the page awaits it. Off on Vercel
// (every read would cost Vercel computing time, and Vercel answers at most 4.5 MB).
const VIA_SERVER = process.env.NEXT_PUBLIC_DATA_VIA_SERVER === '1';
const viaServer = createRemoteClient((body, signal) =>
  authFetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }).then(readAnswer),
);

// One browser client for every page. Sign-in, Storage and live updates still go to Supabase for now.
export const supabase = VIA_SERVER
  ? new Proxy(real, {
      get(target, prop) {
        if (prop === 'from' || prop === 'rpc') return viaServer[prop];
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })
  : real;
