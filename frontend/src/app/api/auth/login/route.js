import { OWN_AUTH, clientIp, sameOrigin, sessionCookie, signIn } from '@/lib/ownAuth.mjs';

// Our own sign-in (lib/ownAuth.mjs): { login, password } → session cookie + { ok, user }. Only with AUTH_MODE=own;
// otherwise Supabase Auth signs people in and this route doesn't exist.
export async function POST(request) {
  if (!OWN_AUTH) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return Response.json({ ok: false, error: 'Refused.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    const result = await signIn(body.login, body.password, { ip: clientIp(request), userAgent: request.headers.get('user-agent') || '' });
    if (result.error) return Response.json({ ok: false, error: result.error }, { status: result.status });
    return Response.json(
      { ok: true, user: result.user },
      { headers: { 'Set-Cookie': sessionCookie(request, result.token, result.expires), 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error(`[auth] sign-in failed: ${e.message}`);
    return Response.json({ ok: false, error: 'Sign-in is not available right now. Try again in a minute.' }, { status: 503 });
  }
}
