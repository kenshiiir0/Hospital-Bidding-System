import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { psPhilgepsData, psPhilgepsStatus, startPsSync } from '@/lib/psPhilgeps';

// PS-PhilGEPS connection + Sync status on this computer (the data itself comes from Supabase;
// ?data=1 still returns this computer's last local result)
export async function GET(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const wantData = new URL(request.url).searchParams.has('data');
  return Response.json({ ...psPhilgepsStatus(), ...(wantData && { data: psPhilgepsData() }) });
}

// PS-PhilGEPS Sync for a signed-in team member (opens the log-in window first when not connected)
export async function POST(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const { user, response } = await requireUser(request);
  if (response) return response;
  return Response.json({ ok: true, ...startPsSync(user.email) }, { status: 202 });
}
