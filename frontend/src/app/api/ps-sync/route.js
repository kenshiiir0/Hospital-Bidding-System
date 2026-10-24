import { after } from 'next/server';
import { hasCronSecret, requireUser } from '@/lib/auth';
import { claimSync, runSync } from '@/lib/psSync.mjs';

// The Sync reads every list page, notice and new document; give it the longest time the host allows
export const maxDuration = 300;

// PS-PhilGEPS Sync for a signed-in team member, on the deployed dashboard or a team computer, or every hour
// 6 AM-5 PM for the Supabase schedule ("Authorization: Bearer <CRON_SECRET>", tools/setup-schedules.js). It
// reuses the saved PS-PhilGEPS session (no new log-in). Answers at once; the Sync runs after the response and
// reports through ps_sync_status (every dashboard reads it).
export async function POST(request) {
  let by;
  if (hasCronSecret(request)) by = 'schedule';
  else {
    const { user, response } = await requireUser(request);
    if (response) return response;
    by = user.email;
  }
  try {
    const claim = await claimSync(by);
    if (claim.notConnected) {
      return Response.json({ ok: false, error: 'PS-PhilGEPS is not connected. Connect first (captcha on a team laptop).' }, { status: 409 });
    }
    if (!claim.started) return Response.json({ ok: true, alreadyRunning: true }, { status: 202 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
  after(() => runSync().catch((e) => console.error(`[ps-sync] ${e.code || 'ERROR'}: ${e.message}`)));
  return Response.json({ ok: true }, { status: 202 });
}
