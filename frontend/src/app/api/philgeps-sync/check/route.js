import { hasCronSecret } from '@/lib/auth';

// Diagnostic for the server-side PhilGEPS Sync: can this server reach notices.philgeps.gov.ph, and how fast?
// Reads public pages only (no log-in). Needs "Authorization: Bearer <CRON_SECRET>".
export const maxDuration = 120;

const PAGES = [
  'https://notices.philgeps.gov.ph/GEPS/log-in.aspx',
  'https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashOpenOpportunitiesUI.aspx?ClickFrom=OpenOpp&menuIndex=3',
  'https://philgeps.gov.ph/',
];

export async function GET(request) {
  if (!hasCronSecret(request)) return Response.json({ ok: false }, { status: 401 });
  const results = [];
  for (const url of PAGES) {
    const started = Date.now();
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36' } });
      const body = await res.text();
      results.push({ url, status: res.status, location: res.headers.get('location'), bytes: body.length, ms: Date.now() - started });
    } catch (e) {
      results.push({ url, error: `${e.name}: ${e.message}`, cause: e.cause?.code || e.cause?.message, ms: Date.now() - started });
    }
  }
  return Response.json({ ok: true, region: process.env.VERCEL_REGION || null, results });
}
