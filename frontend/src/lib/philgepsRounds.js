import { after } from 'next/server';
import { claimSync, closeSession, failSync, finishSync, runSyncRound } from '@/lib/philgepsSync.mjs';

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
      // cancelled: the round stopped for the Cancel button and has already logged out and ended the Sync
      const { more, failed, cancelled } = await runSyncRound();
      if (more) {
        // The next round keeps this round's log-in; if it can't be started, log out now instead of waiting
        const next = await fetch(`${origin}/api/philgeps-sync`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, 'content-type': 'application/json' },
          body: JSON.stringify({ continue: true }),
        }).catch(() => null);
        if (!next?.ok) {
          await closeSession();
          await failSync(
            `The Sync stopped between rounds (the next round could not start${next ? `: HTTP ${next.status}` : ''}). Tenders not reached yet are listed in History; press Sync again to continue.`
          );
        }
      } else if (!failed && !cancelled) {
        await finishSync();
      }
    } catch (e) {
      console.error(`[philgeps-sync] ${e.code || 'ERROR'}: ${e.message}`);
    }
  });
}
