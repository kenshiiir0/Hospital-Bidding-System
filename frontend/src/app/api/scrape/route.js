import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { currentJob, requestSync, startRelayWatcher } from '@/lib/fetchJobs';
import { readRelay, requestPending, requestRelaySync, workerOnline } from '@/lib/philgepsRelay';

// The current or last PhilGEPS fetch (automatic or Sync), read by the dashboard's progress bar and ring.
// On a team computer: its own fetches. Elsewhere (the deployed dashboard): the team computer's, as shared
// through Supabase (lib/philgepsRelay.js), for a signed-in team member.
export async function GET(request) {
  if (!rejectNonLocal(request)) {
    startRelayWatcher();
    return Response.json(currentJob());
  }
  const { response } = await requireUser(request);
  if (response) return response;
  try {
    const row = await readRelay();
    return Response.json({ ...(row.job || { status: 'idle' }), remote: true, workerOnline: workerOnline(row), requestPending: requestPending(row) });
  } catch (err) {
    return Response.json({ status: 'idle', remote: true, error: err.message });
  }
}

// Sync: log in and fetch the screened tenders' documents. Starts nothing when PhilGEPS is down;
// waits for an automatic fetch that is still running.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;

  // Not this team computer: ask the team computer to run it
  if (rejectNonLocal(request)) {
    try {
      const row = await readRelay();
      if (row.job?.kind === 'sync' && row.job.status === 'running') return Response.json({ ok: true, alreadyRunning: true }, { status: 202 });
      if (!workerOnline(row)) {
        return Response.json(
          { ok: false, offline: true, error: 'No team computer is running the dashboard right now. Start it on the team computer (npm run dev), then press Sync again.' },
          { status: 409 }
        );
      }
      await requestRelaySync(user.email);
      return Response.json({ ok: true, requested: true }, { status: 202 });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
  }

  const result = await requestSync();
  if (result.unavailable) {
    return Response.json({ ok: false, unavailable: true, error: result.error }, { status: 503 });
  }
  return Response.json({ ok: true, ...result }, { status: 202 });
}
