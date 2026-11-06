'use client';

// The top of every dashboard page, so all pages read the same way:
// title + live status pill on the left, actions on the right (primary blue action last), then a row of
// KPI cards. Phones: the actions go under the title in an even two-column grid.

/**
 * @param {string} props.title
 * @param {{ tone: 'ok' | 'busy' | 'off' | 'error', text: string } | Array} [props.status]  The live status pill(s)
 *   (the merged Bid Match shows one per portal)
 * @param {React.ReactNode} [props.subtitle]  One quiet line under the title (the site's address, etc.)
 * @param {React.ReactNode} [props.actions]
 */
export default function PageHeader({ title, status, subtitle, actions }) {
  return (
    <header className="flex flex-col gap-4 border-b border-[#E2E8F0] pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-black">{title}</h1>
          {[].concat(status || []).map((st) => (
            <StatusPill key={st.text} {...st} />
          ))}
        </div>
        {subtitle && <p className="mt-1 text-xs text-black/62">{subtitle}</p>}
      </div>
      {actions && <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end [&>*:last-child:nth-child(odd)]:col-span-2">{actions}</div>}
    </header>
  );
}

const TONES = {
  ok: { dot: 'bg-[#61A644]', pill: 'border-[#61A644]/25 bg-[#61A644]/8 text-[#3F6F2C]' },
  busy: { dot: 'bg-[#1EA0DA] animate-pulse', pill: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/8 text-[#12769F]' },
  off: { dot: 'bg-black/30', pill: 'border-[#CBD5E1] bg-white text-black/62' },
  error: { dot: 'bg-[#B3312C]', pill: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]' },
};

/** "● Connected · Sync 12:38 PM": green when live, blue while working, grey when off, red on errors. */
export function StatusPill({ tone = 'ok', text }) {
  const t = TONES[tone] || TONES.ok;
  return (
    <span role="status" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${t.pill}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      {text}
    </span>
  );
}

/** Green-tinted secondary action (Export Excel). */
export const greenAction =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-[#61A644]/25 bg-[#61A644]/10 px-4 py-2 text-xs font-semibold text-[#3F6F2C] transition hover:bg-[#61A644]/20 disabled:cursor-not-allowed disabled:opacity-50';
/** Solid blue primary action (Sync). */
export const blueAction =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#1790C5] disabled:cursor-wait disabled:opacity-70';
/** Quiet outlined action (Reload). */
export const plainAction =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-xs font-medium text-black/62 transition hover:border-[#1EA0DA] hover:text-[#12769F] disabled:cursor-wait disabled:opacity-60';

/**
 * Summary cards under the header: an icon in a soft circle, a quiet label, the number, one short note.
 * Three cards in a row; four: two by two on tablets, one row on wide screens.
 * @param {Array<{ label: string, value: React.ReactNode, note?: React.ReactNode, tone?: 'black' | 'green' | 'blue' | 'docs' }>} props.items
 */
export function KpiRow({ items }) {
  const tile = { black: 'bg-[#1EA0DA]/8 text-[#12769F]', green: 'bg-[#61A644]/12 text-[#3F6F2C]', blue: 'bg-[#1EA0DA]/8 text-[#12769F]', docs: 'bg-[#1EA0DA]/8 text-[#12769F]' };
  const value = { black: 'text-black', green: 'text-[#3F6F2C]', blue: 'text-[#12769F]', docs: 'text-black' };
  const icon = {
    // A list of tenders
    black: <path d="M6 5.5h8M6 10h8M6 14.5h5M3.5 3.5h13v13h-13z" />,
    // A product (capsule)
    green: <path d="M7.3 15.7a3.8 3.8 0 0 1-5.4-5.4l5.3-5.3a3.8 3.8 0 0 1 5.4 5.4zM5.2 7.6l5.4 5.4" />,
    // Money (peso)
    blue: <path d="M6 16.5v-13h4.5a3.5 3.5 0 0 1 0 7H6M3.5 6.5h11M3.5 9h11" />,
    // A document with a folded corner
    docs: <path d="M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15M7.5 10h5M7.5 13h5" />,
  };
  const columns = items.length === 4 ? 'sm:grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-3';
  return (
    <section className={`grid grid-cols-2 gap-3 ${columns} [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1`} aria-label="Summary">
      {items.map((k) => {
        const tone = k.tone || 'black';
        return (
          <div key={k.label} className="flex min-w-0 items-start gap-3 rounded-[14px] border border-[#E2E8F0] bg-white p-3 sm:p-4">
            <span className={`hidden h-9 w-9 shrink-0 items-center justify-center rounded-full sm:flex ${tile[tone]}`} aria-hidden>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                {icon[tone]}
              </svg>
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-black/50">{k.label}</div>
              <div className={`mt-0.5 truncate text-lg font-semibold tabular-nums sm:text-xl ${value[tone]}`}>{k.value}</div>
              {k.note && <div className="mt-0.5 hidden truncate text-xs text-black/46 sm:block">{k.note}</div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** "₱12,345,678" (whole pesos) for KPI totals. */
export const pesoTotal = (n) => `₱${Math.round(n || 0).toLocaleString('en-PH')}`;

/** A peso amount from PhilGEPS text ("1,906,762.00", "₱ 211,768") or a number; 0 when unreadable. */
export const pesoValue = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0);
