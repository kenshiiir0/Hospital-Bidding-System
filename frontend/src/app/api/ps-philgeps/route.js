import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { psConnectStatus, startPsConnect } from '@/lib/psPhilgeps';
import { cloudConnectStatus, startCloudConnect } from '@/lib/psCloudConnect.mjs';

// PS-PhilGEPS Connect. On a team computer's own dashboard: a Chrome log-in window on that computer
// (lib/psPhilgeps.js). Anywhere else (the deployed dashboard, any device): the log-in page runs on GitHub and its
// picture shows in the dashboard (lib/psCloudConnect.mjs), for a signed-in team member.
export async function GET(request) {
  if (!rejectNonLocal(request)) return Response.json(psConnectStatus());
  const { response } = await requireUser(request);
  if (response) return response;
  try {
    return Response.json(await cloudConnectStatus());
  } catch (e) {
    return Response.json({ job: { status: 'idle' }, error: e.message });
  }
}

export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  if (!rejectNonLocal(request)) return Response.json({ ok: true, ...startPsConnect(user.email) }, { status: 202 });
  try {
    return Response.json({ ok: true, ...(await startCloudConnect(user.email)) }, { status: 202 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
