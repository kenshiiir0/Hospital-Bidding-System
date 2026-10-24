import { after } from 'next/server';
import { hasCronSecret } from '@/lib/auth';
import { runPublicUpdate } from '@/lib/philgepsUpdate.mjs';
import { createClient } from '@supabase/supabase-js';

// The update reads the whole list and the new notices; it stops starting work at 230 s
export const maxDuration = 300;

// An update whose progress hasn't moved for this long was cut off and may start again
const STALE_MS = 6 * 60 * 1000;
// Every hour after the update, the documents Sync (philgepsSync.mjs): it logs in only when tenders wait for
// documents, and when the account is in use it is refused at the door and the next hour tries again (the log-in
// guard lets a schedule try 30 minutes after "in use"). OFF until a real Sync is followed by a successful log-in
// by hand, proving the new log-out frees the account (2026-10-23: the old log-out left the account "in use" for
// hours). The hourly update itself never logs in.
const HOURLY_DOCUMENTS = false;

// The hourly public PhilGEPS update (lib/philgepsUpdate.mjs), called by a Supabase cron job every hour
// 6 AM–5 PM (tools/setup-schedules.js) with "Authorization: Bearer <CRON_SECRET>". Answers at once and runs
// after the response. Then the documents Sync starts (HOURLY_DOCUMENTS).
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!hasCronSecret(request)) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabase = createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await supabase.from('philgeps_sync_relay').select('job, updated_at').eq('id', 'update').maybeSingle();
  if (data?.job?.status === 'running' && Date.now() - Date.parse(data.updated_at) < STALE_MS) {
    return Response.json({ ok: true, alreadyRunning: true });
  }
  const origin = new URL(request.url).origin;
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }));
  after(async () => {
    try {
      await runPublicUpdate({ by: 'schedule' });
    } catch (e) {
      console.error(`[philgeps-update] ${e.message}`);
    }
    // The documents Sync, through its own route so it gets a fresh time limit (it skips itself when one runs)
    if (HOURLY_DOCUMENTS) {
      await fetch(`${origin}/api/philgeps-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ start: true }),
      }).catch((e) => console.error(`[philgeps-update] Sync: ${e.message}`));
    }
  });
  return Response.json({ ok: true, started: true, withDocuments: HOURLY_DOCUMENTS, hour }, { status: 202 });
}
