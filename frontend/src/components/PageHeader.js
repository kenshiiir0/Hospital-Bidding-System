'use client';

// The top of every dashboard page, so all pages read the same way:
// title + live status pill on the left, actions on the right (primary blue action last), then a row of
// KPI cards. Phones: the actions go under the title in an even two-column grid.

/**
 * @param {string} props.title
 * @param {{ tone: 'ok' | 'busy' | 'off' | 'error', text: string }} [props.status]  The live status pill
 * @param {React.ReactNode} [props.subtitle]  One quiet line under the title (the site's address, etc.)
 * @param {React.ReactNode} [props.actions]
 */
export default function PageHeader({ title, status, subtitle, actions }) {
  return (
    <header className="flex flex-col gap-4 border-b border-[#E2E8F0] pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-xl font-bold tracking-tight text-black">{title}</h1>
          {status && <StatusPill {...status} />}
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
 * Summary cards under the header.
 * @param {Array<{ label: string, value: React.ReactNode, note?: React.ReactNode, tone?: 'black' | 'green' | 'blue' }>} props.items
 */
export function KpiRow({ items }) {
  const value = { black: 'text-2xl text-black', green: 'text-2xl text-[#3F6F2C]', blue: 'text-xl text-[#12769F]' };
  const dot = { black: 'bg-black/30', green: 'bg-[#61A644]', blue: 'bg-[#1EA0DA]' };
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Summary">
      {items.map((k) => (
        <div key={k.label} className="flex items-center justify-between gap-3 rounded-[14px] border border-[#E2E8F0] bg-white p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-black/46">
              <span className={`h-1.5 w-1.5 rounded-full ${dot[k.tone || 'black']}`} aria-hidden />
              {k.label}
            </div>
            {k.note && <div className={`mt-1 truncate text-xs ${k.tone === 'green' ? 'text-[#61A644]' : 'text-black/46'}`}>{k.note}</div>}
          </div>
          <div className={`shrink-0 font-bold tabular-nums ${value[k.tone || 'black']}`}>{k.value}</div>
        </div>
      ))}
    </section>
  );
}

/** "₱12,345,678" (whole pesos) for KPI totals. */
export const pesoTotal = (n) => `₱${Math.round(n || 0).toLocaleString('en-PH')}`;

/** A peso amount from PhilGEPS text ("1,906,762.00", "₱ 211,768") or a number; 0 when unreadable. */
export const pesoValue = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0);
