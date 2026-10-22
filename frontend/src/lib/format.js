// Dates are stored as Philippine local time without a zone ("2026-10-23T13:00:00"),
// so format the parts directly instead of letting the browser shift them.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-20" -> "Oct 20, 2026"
export function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : null;
}

// "2026-10-23T13:00:00" -> "Oct 23, 2026 1:00 PM"
export function formatDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  const hour = Number(m[4]);
  return `${formatDate(value)} ${hour % 12 || 12}:${m[5]} ${hour < 12 ? 'AM' : 'PM'}`;
}

// 113980 -> "₱113,980.00"
export function formatPeso(value) {
  return value == null ? null : `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// created_at columns are moments in time (UTC; philgeps_opportunities stores them without a zone),
// shown in Philippine time whatever the browser's zone is
function toInstant(value) {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "2026-10-21T01:05:00Z" -> "Oct 21, 2026 9:05 AM"
export function formatInstant(value) {
  const date = toInstant(value);
  return date
    ? date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
}

// "2026-10-21T01:05:00Z" -> "2026-10-21" (Philippine date), for grouping by day
export function instantDay(value) {
  const date = toInstant(value);
  return date ? date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) : '';
}
