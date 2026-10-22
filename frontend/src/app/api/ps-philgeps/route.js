import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { psConnectStatus, startPsConnect } from '@/lib/psPhilgeps';

// PS-PhilGEPS Connect on this computer (only where the dashboard runs on a team computer: it opens a
// Chrome log-in window here). A deployed copy refuses, and its dashboard says how to connect instead.
export async function GET(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  return Response.json(psConnectStatus());
}

export async function POST(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const { user, response } = await requireUser(request);
  if (response) return response;
  return Response.json({ ok: true, ...startPsConnect(user.email) }, { status: 202 });
}
