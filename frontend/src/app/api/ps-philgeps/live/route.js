import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { liveClick, liveFrame, switchToLiveView } from '@/lib/psPhilgeps';
import { cloudFrame, cloudInput } from '@/lib/psCloudConnect.mjs';

// Live picture of the PS-PhilGEPS log-in page while connecting (the captcha is answered on it): from this
// computer's log-in (team computer), else from the cloud log-in (lib/psCloudConnect.mjs, signed-in team members)
export async function GET(request) {
  const local = !rejectNonLocal(request);
  if (!local) {
    const { response } = await requireUser(request);
    if (response) return response;
  }
  const frame = local ? liveFrame() : await cloudFrame().catch(() => null);
  if (!frame) return new Response(null, { status: 204 });
  return new Response(frame, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
}

// A signed-in team member's click on the picture: { x, y } in page pixels, { switch: true } (team computer: show
// the log-in page here instead of its window) or { cancel: true } (cloud log-in)
export async function POST(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const local = !rejectNonLocal(request);
  const body = await request.json().catch(() => ({}));
  if (body.switch) return Response.json({ ok: local && switchToLiveView() });
  if (body.cancel) return Response.json({ ok: !local && (await cloudInput({ cancel: true })) });
  const { x, y } = body;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 2000 || y > 2000) {
    return Response.json({ ok: false, error: 'Invalid click' }, { status: 400 });
  }
  return Response.json({ ok: local ? liveClick(x, y) : await cloudInput({ x, y }) });
}
