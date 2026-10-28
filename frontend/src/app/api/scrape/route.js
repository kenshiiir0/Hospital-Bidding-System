import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { cancelJob, currentJob, requestSync, startRelayWatcher } from '@/lib/fetchJobs';
import { requestCancel } from '@/lib/philgepsSync.mjs';
import { readRelay, requestPending, workerOnline } from '@/lib/philgepsRelay';
import { startServerSync } from '@/lib/philgepsRounds';

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

// The progress ring's Cancel button: stops the running Sync and logs out of PhilGEPS. On a team computer its own
// fetch is stopped here (fetchJobs.js cancelJob); elsewhere the cancel is saved for the server Sync's round or the
// team computer running the Sync (philgepsSync.mjs requestCancel). The ring shows "Cancelled" once the log-out is
// settled.
export async function DELETE(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  try {
    const result = rejectNonLocal(request) ? await requestCancel(user.email) : cancelJob(user.email);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// The server-side Sync's rounds may run up to the host's limit
export const maxDuration = 300;

// Sync: log in and fetch the screened tenders' documents. Starts nothing when PhilGEPS is down;
// waits for an automatic fetch that is still running.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;

  // The deployed dashboard (or any other non-team server): the Sync runs right here, without a browser
  // (lib/philgepsSync.mjs); its progress is read back through GET like a team computer's
  if (rejectNonLocal(request)) {
    try {
      const claim = await startServerSync(new URL(request.url).origin, user.email);
      return Response.json({ ok: true, started: claim.started, alreadyRunning: !claim.started }, { status: 202 });
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
