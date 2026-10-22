import { after } from 'next/server';
import { claimSync, finishSync, runSyncRound } from '@/lib/philgepsSync.mjs';

// Starts the server-side PhilGEPS Sync (philgepsSync.mjs) for `by` and runs it in rounds: each round runs after
// the response, within one request's time limit; when tenders are left it asks POST /api/philgeps-sync (with
// CRON_SECRET) for the next round, which gets a fresh time limit. Returns { started } (false = already running).
export async function startServerSync(origin, by) {
  const claim = await claimSync(by);
  if (claim.started) runRoundsAfterResponse(origin);
  return claim;
}

export function runRoundsAfterResponse(origin) {
  after(async () => {
    try {
      const { more, failed } = await runSyncRound();
      if (more) {
        await fetch(`${origin}/api/philgeps-sync`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, 'content-type': 'application/json' },
          body: JSON.stringify({ continue: true }),
        });
      } else if (!failed) {
        await finishSync();
      }
    } catch (e) {
      console.error(`[philgeps-sync] ${e.code || 'ERROR'}: ${e.message}`);
    }
  });
}
