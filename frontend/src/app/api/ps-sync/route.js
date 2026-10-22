import { after } from 'next/server';
import { requireUser } from '@/lib/auth';
import { claimSync, runSync } from '@/lib/psSync.mjs';

// The Sync reads every list page, notice and new document; give it the longest time the host allows
export const maxDuration = 300;

// PS-PhilGEPS Sync for a signed-in team member, on the deployed dashboard or a team computer. Answers at
// once; the Sync runs after the response and reports through ps_sync_status (every dashboard reads it).
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  try {
    const claim = await claimSync(user.email);
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
