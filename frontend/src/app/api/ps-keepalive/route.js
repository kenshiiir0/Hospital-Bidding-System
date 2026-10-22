import { after } from 'next/server';
import { keepAlive } from '@/lib/psSync.mjs';
import { analyzePending } from '@/lib/psDocs.mjs';

// Reading documents with Claude takes a while; stop starting new tenders well before the host's limit
export const maxDuration = 300;

// Called every 5 minutes by a Supabase cron job with "Authorization: Bearer <CRON_SECRET>" (a server
// environment variable):
// 1. opens one PS-PhilGEPS page with the saved session so PhilGEPS doesn't end it for being idle (it ends
//    after well under an hour without use),
// 2. after answering, reads the bid documents of tenders that are new or changed since the last reading
//    (psDocs.mjs), for up to ~3.5 minutes; the rest wait for the next call.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false }, { status: 401 });
  }
  after(() =>
    analyzePending({ maxMs: 210000 })
      .then((r) => (r.read || r.failed) && console.log(`[ps-docs] read ${r.read}, failed ${r.failed}, waiting ${r.left}`))
      .catch((e) => console.error(`[ps-docs] ${e.message}`))
  );
  try {
    return Response.json({ ok: true, ...(await keepAlive()) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, code: e.code }, { status: 200 });
  }
}
