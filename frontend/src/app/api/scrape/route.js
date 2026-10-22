import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { currentJob, requestSync } from '@/lib/fetchJobs';

// The current or last PhilGEPS fetch (automatic or Sync), read by the dashboard's progress bar and ring
export async function GET(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  return Response.json(currentJob());
}

// Sync: log in and fetch the screened tenders' documents. Starts nothing when PhilGEPS is down;
// waits for an automatic fetch that is still running.
export async function POST(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const { response } = await requireUser(request);
  if (response) return response;

  const result = await requestSync();
  if (result.unavailable) {
    return Response.json({ ok: false, unavailable: true, error: result.error }, { status: 503 });
  }
  return Response.json({ ok: true, ...result }, { status: 202 });
}
