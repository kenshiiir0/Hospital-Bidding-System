import { createClient } from '@supabase/supabase-js';
import { authFetch } from '@/lib/authFetch';
import { createRemoteClient, readAnswer } from '@/lib/db/remoteClient.mjs';
import { ownAuth } from '@/lib/ownAuthClient';

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

// NEXT_PUBLIC_DOCUMENTS_ON_SERVER=1 (with STORAGE_BACKEND=disk on that server): the bid documents are on our own
// server's disk, not in Supabase Storage. supabase.storage.from(bucket) then asks our server (/api/stored-files) for
// the short-lived links that Storage's createSignedUrl gave, and downloads through them; the pages stay the same.
const DOCUMENTS_ON_SERVER = process.env.NEXT_PUBLIC_DOCUMENTS_ON_SERVER === '1';
async function serverLink(bucket, path, seconds, options) {
  try {
    const res = await authFetch('/api/stored-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, path, seconds, download: options?.download }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data?.signedUrl) return { data: null, error: body?.error || { message: `the server answered ${res.status}` } };
    // A full address, as Storage gives (Office's ms-word: links need one)
    return { data: { signedUrl: new URL(body.data.signedUrl, window.location.origin).href }, error: null };
  } catch (e) {
    return { data: null, error: { message: e.message } };
  }
}
const serverStorage = {
  from: (bucket) => ({
    createSignedUrl: (path, seconds, options) => serverLink(bucket, path, seconds, options),
    async download(path) {
      const link = await serverLink(bucket, path, 600);
      if (link.error) return link;
      try {
        const res = await fetch(link.data.signedUrl);
        if (!res.ok) return { data: null, error: { message: `the server answered ${res.status}` } };
        return { data: await res.blob(), error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  }),
};

// NEXT_PUBLIC_AUTH_MODE=own (with AUTH_MODE=own on the server): signing in is our own (lib/ownAuthClient.js), not
// Supabase Auth; supabase.auth answers the same calls
const OWN_SIGN_IN = process.env.NEXT_PUBLIC_AUTH_MODE === 'own';

// One browser client for every page
export const supabase = VIA_SERVER || DOCUMENTS_ON_SERVER || OWN_SIGN_IN
  ? new Proxy(real, {
      get(target, prop) {
        if (VIA_SERVER && (prop === 'from' || prop === 'rpc')) return viaServer[prop];
        if (DOCUMENTS_ON_SERVER && prop === 'storage') return serverStorage;
        if (OWN_SIGN_IN && prop === 'auth') return ownAuth;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })
  : real;
