import { after } from 'next/server';
import { hasCronSecret } from '@/lib/auth';
import { keepAlive } from '@/lib/psSync.mjs';
import { analyzePending } from '@/lib/psDocs.mjs';
import { checkHospitals } from '@/lib/hospitals.mjs';
import { sweepSession } from '@/lib/philgepsSync.mjs';

// Reading documents and hospital pages takes a while; the work below stops well before this limit
export const maxDuration = 300;

// Called every 5 minutes by a Supabase cron job with "Authorization: Bearer <CRON_SECRET>" (a server
// environment variable):
// 1. opens one PS-PhilGEPS page with the saved session so PhilGEPS doesn't end it for being idle (it ends
//    after well under an hour without use),
// 2. after answering, reads the bid documents of tenders that are new or changed since the last reading
//    (psDocs.mjs), for up to 3 minutes; the rest wait for the next call,
// 3. then checks hospitals' own procurement pages that are due (hospitals.mjs, every 3 hours each).
export async function GET(request) {
  if (!hasCronSecret(request)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  after(async () => {
    // 0. PhilGEPS (notices) Sync: log out a session a cut-off round left behind (never while a Sync runs)
    await sweepSession().then((r) => r.loggedOut && console.log('[philgeps] logged out a leftover session'));
    await analyzePending({ maxMs: 180000 })
      .then((r) => (r.read || r.failed) && console.log(`[ps-docs] read ${r.read}, failed ${r.failed}, waiting ${r.left}`))
      .catch((e) => console.error(`[ps-docs] ${e.message}`));
    await checkHospitals({ maxMs: 60000 })
      .then((r) => r.checked && console.log(`[hospitals] checked ${r.checked}, new postings ${r.found}`))
      .catch((e) => console.error(`[hospitals] ${e.message}`));
  });
  try {
    return Response.json({ ok: true, ...(await keepAlive()) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, code: e.code }, { status: 200 });
  }
}
