import { after } from 'next/server';
import { hasCronSecret } from '@/lib/auth';
import { keepAlive } from '@/lib/psSync.mjs';
import { analyzePending } from '@/lib/psDocs.mjs';
import { checkHospitals } from '@/lib/hospitals.mjs';
import { sweepSession } from '@/lib/philgepsSync.mjs';
import { visionBackfill } from '@/lib/ocrVision.mjs';
import { admin } from '@/lib/ocrQueue.mjs';
import { triggerOcr } from '@/lib/ocrTrigger.mjs';

// Reading documents and hospital pages takes a while; the work below stops well before this limit
export const maxDuration = 300;

// Called every 5 minutes by a Supabase cron job with "Authorization: Bearer <CRON_SECRET>" (a server
// environment variable):
// 1. opens one PS-PhilGEPS page with the saved session so PhilGEPS doesn't end it for being idle (it ends
//    after well under an hour without use),
// 2. after answering, reads the bid documents of tenders that are new or changed since the last reading
//    (psDocs.mjs), for up to 3 minutes; the rest wait for the next call,
// 3. then checks hospitals' own procurement pages that are due (hospitals.mjs, every 3 hours each),
// 4. then the Google Vision backup for scanned documents (ocrVision.mjs).
const SYNC_FRESH_MS = 15 * 60 * 1000;

async function documentWorkDue() {
  const now = new Date();
  const manila = new Date(now.getTime() + 8 * 3600 * 1000);
  const hour = manila.getUTCHours();
  if (hour >= 6 && hour < 20 && manila.getUTCMinutes() % 15 < 5) return true;
  // Only the snapshot's time (a few bytes), not its lists
  const { data } = await admin().from('ps_philgeps_snapshot').select('synced_at').eq('id', 'latest').maybeSingle();
  return Boolean(data?.synced_at) && now - new Date(data.synced_at) < SYNC_FRESH_MS;
}

export async function GET(request) {
  if (!hasCronSecret(request)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  after(async () => {
    // 0. PhilGEPS (notices) Sync: log out a session a cut-off round left behind (never while a Sync runs)
    await sweepSession().then((r) => r.loggedOut && console.log('[philgeps] logged out a leftover session'));
    // Steps 2–4 each read every PS-PhilGEPS notice and reading (~2 MB) from Supabase; every 5 minutes around the
    // clock that used up the free plan's egress (2026-11-03, 2026-11-13). They run only when there can be work:
    // within 15 minutes of a Sync saving new lists, else once every 15 minutes from 6 AM to 8 PM Manila time.
    if (!(await documentWorkDue())) return;
    await analyzePending({ maxMs: 180000 })
      .then(async (r) => {
        if (r.read || r.failed) console.log(`[ps-docs] read ${r.read}, failed ${r.failed}, waiting ${r.left}`);
        // New PS-PhilGEPS documents were just read (a Sync brought them): scanned ones are read now on GitHub
        if (r.read) await triggerOcr('ps-documents');
      })
      .catch((e) => console.error(`[ps-docs] ${e.message}`));
    await checkHospitals({ maxMs: 60000 })
      .then((r) => r.checked && console.log(`[hospitals] checked ${r.checked}, new postings ${r.found}`))
      .catch((e) => console.error(`[hospitals] ${e.message}`));
    // 4. Scanned documents: Google Vision backup for the ones the hourly GitHub OCR job (layer 1) hasn't
    //    read within 6 hours or found no text in (ocrVision.mjs; off without GOOGLE_VISION_API_KEY), and the
    //    waiting count the dashboard warns about
    await visionBackfill(admin(), { maxMs: 30000 })
      .then((r) => (r.read || r.error) && console.log(`[ocr-vision] read ${r.read} (${r.pages} pages)${r.error ? `, error: ${r.error}` : ''}`))
      .catch((e) => console.error(`[ocr-vision] ${e.message}`));
  });
  try {
    return Response.json({ ok: true, ...(await keepAlive()) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, code: e.code }, { status: 200 });
  }
}
