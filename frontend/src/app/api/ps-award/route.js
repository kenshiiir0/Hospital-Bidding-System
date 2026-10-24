import { requireUser } from '@/lib/auth';
import { actOnAward } from '@/lib/psAward.mjs';

export const maxDuration = 60;

// Accept or Refuse one PS-PhilGEPS award notice for a signed-in team member: { award, action: 'ACCEPT' |
// 'REFUSE', comment }. Sent to PS-PhilGEPS with the saved session (lib/psAward.mjs); answers once PS-PhilGEPS
// shows the new status, or with what went wrong (nothing is sent when the award is no longer pending).
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  let input;
  try {
    input = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Bad request.' }, { status: 400 });
  }
  try {
    const result = await actOnAward({ award: input.award, action: input.action, comment: input.comment }, user.email);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const status = { BAD_INPUT: 400, NOT_FOUND: 404, ALREADY: 409, BUSY: 409, NOT_CONNECTED: 409 }[e.code] || 502;
    return Response.json({ ok: false, code: e.code, error: e.message }, { status });
  }
}
