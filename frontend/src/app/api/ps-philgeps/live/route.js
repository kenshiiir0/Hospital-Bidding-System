import { rejectNonLocal } from '@/lib/localRequest';
import { requireUser } from '@/lib/auth';
import { liveClick, liveFrame, switchToLiveView } from '@/lib/psPhilgeps';

// Live picture of the PS-PhilGEPS log-in page while connecting (the captcha is answered on it)
export async function GET(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const frame = liveFrame();
  if (!frame) return new Response(null, { status: 204 });
  return new Response(frame, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
}

// A signed-in team member's click on the picture: { x, y } in page pixels, or { switch: true }
export async function POST(request) {
  const forbidden = rejectNonLocal(request);
  if (forbidden) return forbidden;
  const { response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  // { switch: true }: close the log-in window and show the log-in page here instead
  if (body.switch) return Response.json({ ok: switchToLiveView() });
  const { x, y } = body;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 2000 || y > 2000) {
    return Response.json({ ok: false, error: 'Invalid click' }, { status: 400 });
  }
  return Response.json({ ok: liveClick(x, y) });
}
