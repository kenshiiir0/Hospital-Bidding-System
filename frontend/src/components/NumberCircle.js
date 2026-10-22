'use client';

const RADIUS = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// What each documents status means, shown when hovering a row's number
const LABELS = {
  waiting: 'Waiting for its turn in this Sync',
  working: 'Fetching its documents now',
  downloaded: 'Documents downloaded',
  'pick-up': 'Pick-up only: the procuring entity has no file on PhilGEPS',
  closed: 'Closed on PhilGEPS: bidding has ended, documents can no longer be ordered',
  'needs-payment': 'PhilGEPS asks for a payment; not ordered',
  'no-order-link': 'No Order link on PhilGEPS yet',
  'order-flow-changed': 'PhilGEPS showed an unexpected page; tried again next Sync',
  'none-found': 'Ordered, but no file came through yet',
  failed: 'Could not be checked this time',
  'not-reached': 'Not reached before the Sync time limit; next Sync continues',
};

// A list row's number in a circle that fills like a progress bar during a Sync: an empty ring while the
// tender waits its turn, a blue arc growing with each step (checking orders, ordering, downloading), then
// the result: solid green = documents downloaded (also outside a Sync when they exist), grey ring =
// pick-up only, red ring = stopped (hover for why).
// state: the tender's state in the current/last Sync, or undefined; percent: 0-100 while working.
export default function NumberCircle({ n, state, percent = 0, error, hasDocs }) {
  const shown = state || (hasDocs ? 'downloaded' : null);
  const working = state === 'working';
  const done = shown && shown !== 'waiting' && !working;

  const arc = working
    ? { color: 'stroke-[#1EA0DA]', fill: Math.max(4, Math.min(100, percent)) }
    : shown === 'downloaded'
      ? null
      : done
        ? { color: shown === 'pick-up' || shown === 'closed' ? 'stroke-[#94A3B8]' : 'stroke-[#B3312C]/70', fill: 100 }
        : null;

  return (
    <span className="relative inline-flex h-8 w-8 items-center justify-center" title={shown ? `${LABELS[shown] || shown}${error ? `: ${error}` : ''}` : undefined}>
      {shown === 'downloaded' && !working ? (
        <span className="absolute inset-0 rounded-full bg-[#61A644]" aria-hidden />
      ) : (
        <svg viewBox="0 0 32 32" className="absolute inset-0 h-8 w-8 -rotate-90" aria-hidden>
          <circle cx="16" cy="16" r={RADIUS} fill="none" strokeWidth={state === 'waiting' ? 2 : 1.5} className={state === 'waiting' ? 'stroke-[#1EA0DA]/25' : 'stroke-[#E2E8F0]'} />
          {arc && (
            <circle
              cx="16"
              cy="16"
              r={RADIUS}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - arc.fill / 100)}
              className={`${arc.color} transition-[stroke-dashoffset] duration-700`}
            />
          )}
        </svg>
      )}
      <span className={`relative font-mono text-xs ${shown === 'downloaded' && !working ? 'text-white font-semibold' : working ? 'text-[#12769F] font-semibold' : 'text-black/62'}`}>
        {n}
      </span>
    </span>
  );
}
