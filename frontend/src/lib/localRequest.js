// The scrape route starts the scraper, which uses the Supabase secret key and (soon) logs in to
// PhilGEPS with the company account, so it must only answer the dashboard on this machine.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Returns a 403 response for anything other than a same-origin request to a local address, else null.
// Blocks other devices on the network, other websites posting to localhost (CSRF) and DNS rebinding.
export function rejectNonLocal(request) {
  const host = request.headers.get('host') || '';
  const hostname = host.replace(/:\d+$/, '');
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');

  const allowed =
    LOCAL_HOSTS.has(hostname) &&
    (!origin || safeHost(origin) === host) &&
    (!fetchSite || fetchSite === 'same-origin');

  return allowed ? null : Response.json({ ok: false, error: 'Forbidden' }, { status: 403 });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
