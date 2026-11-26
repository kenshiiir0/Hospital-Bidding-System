import { OWN_AUTH, readSessionToken, sessionUser } from '@/lib/ownAuth.mjs';

// Our own sign-in: who is signed in on this browser → { user } or { user: null }
export async function GET(request) {
  if (!OWN_AUTH) return new Response(null, { status: 404 });
  try {
    const user = await sessionUser(readSessionToken(request));
    return Response.json({ user }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error(`[auth] session check failed: ${e.message}`);
    return Response.json({ user: null, error: 'Sign-in is not available right now.' }, { status: 503 });
  }
}
