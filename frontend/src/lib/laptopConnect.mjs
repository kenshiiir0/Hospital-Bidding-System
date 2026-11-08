import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// One-time codes for the PS-PhilGEPS log-in on a team laptop (ps-philgeps-session.js connectLaptop,
// app/api/ps-philgeps/laptop). The dashboard gives a code only to a signed-in team member who pressed Sync; the
// laptop shows it back to get the log-in and to hand over the session. A code is signed with a key only the
// server has (derived from SUPABASE_KEY) and ends after 15 minutes, so the laptop itself keeps no key or password.
// purpose 'login': one log-in (15 minutes); 'setup': downloading the laptop files (lib/laptopKit.generated.mjs, 60 min)
const MINUTES = { login: 15, setup: 60 };

function signingKey() {
  const secret = process.env.SUPABASE_KEY;
  if (!secret) throw new Error('SUPABASE_KEY is not set on the server.');
  return createHash('sha256').update(`ps-laptop-connect:${secret}`).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => createHmac('sha256', signingKey()).update(payload).digest();

export function issueCode(email, purpose = 'login', now = Date.now()) {
  const payload = b64(JSON.stringify({ e: email, p: purpose, x: now + MINUTES[purpose] * 60 * 1000 }));
  return `${payload}.${b64(sign(payload))}`;
}

// The team member's e-mail for a valid, unexpired code of that purpose; null otherwise
export function checkCode(code, purpose = 'login', now = Date.now()) {
  if (typeof code !== 'string' || code.length > 400) return null;
  const [payload, mac, extra] = code.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const given = Buffer.from(mac, 'base64url');
  const expected = sign(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, p, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof e === 'string' && p === purpose && typeof x === 'number' && now < x ? e : null;
  } catch {
    return null;
  }
}

// The cookies a laptop hands over: PhilGEPS cookies only, in the shape the Sync uses (lib/psSync.mjs)
export function philgepsCookies(cookies) {
  if (!Array.isArray(cookies) || !cookies.length || cookies.length > 60) return null;
  const ours = cookies.filter(
    (c) => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string' && c.domain.replace(/^\./, '').endsWith('philgeps.gov.ph') && c.value.length < 8000
  );
  return ours.length === cookies.length ? ours : null;
}
