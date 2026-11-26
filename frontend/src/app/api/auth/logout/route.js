import { OWN_AUTH, readSessionToken, sameOrigin, sessionCookie, signOut } from '@/lib/ownAuth.mjs';

// Our own sign-out: ends this browser's session only (other devices stay signed in)
export async function POST(request) {
  if (!OWN_AUTH) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return Response.json({ ok: false, error: 'Refused.' }, { status: 403 });
  try {
    await signOut(readSessionToken(request));
  } catch (e) {
    console.error(`[auth] sign-out failed: ${e.message}`);
  }
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(request, '', null), 'Cache-Control': 'no-store' } });
}
