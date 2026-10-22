import { requireUser } from '@/lib/auth';
import { runRoundsAfterResponse, startServerSync } from '@/lib/philgepsRounds';

// One round may use the whole limit (philgepsSync.mjs stops starting tenders after ROUND_MS)
export const maxDuration = 300;

// Server-side PhilGEPS Sync (no browser): a signed-in team member starts it (the dashboard's Sync button goes
// through /api/scrape, which comes here on the deployed dashboard), and with "Authorization: Bearer
// <CRON_SECRET>" the Sync's own next round ({ continue: true }) or a schedule ({ start: true }) calls it.
export async function POST(request) {
  const origin = new URL(request.url).origin;
  const secret = process.env.CRON_SECRET;
  try {
    if (secret && request.headers.get('authorization') === `Bearer ${secret}`) {
      const body = await request.json().catch(() => ({}));
      if (body.continue) {
        runRoundsAfterResponse(origin);
        return Response.json({ ok: true, continued: true }, { status: 202 });
      }
      const claim = await startServerSync(origin, 'schedule');
      return Response.json({ ok: true, ...claim }, { status: 202 });
    }
    const { user, response } = await requireUser(request);
    if (response) return response;
    const claim = await startServerSync(origin, user.email);
    return Response.json({ ok: true, ...claim, alreadyRunning: !claim.started }, { status: 202 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, code: e.code }, { status: 500 });
  }
}
