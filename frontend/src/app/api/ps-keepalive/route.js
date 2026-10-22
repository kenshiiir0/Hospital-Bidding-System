import { keepAlive } from '@/lib/psSync.mjs';

// Opens one PS-PhilGEPS page with the saved session so PhilGEPS doesn't end it for being idle (it ends
// after well under an hour without use). Called every few minutes by a Supabase cron job with
// "Authorization: Bearer <CRON_SECRET>" (CRON_SECRET is a server environment variable).
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false }, { status: 401 });
  }
  try {
    return Response.json({ ok: true, ...(await keepAlive()) });
  } catch (e) {
    return Response.json({ ok: false, error: e.message, code: e.code }, { status: 200 });
  }
}
