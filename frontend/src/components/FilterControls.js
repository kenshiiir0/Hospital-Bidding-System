'use client';

// Filter controls shared by the PhilGEPS and PS-PhilGEPS lists, so both sites' filter bars look the same.

// A <select> drawn as a white pill with our own chevron (the OS arrow is hidden). It stays a real
// <select>, so the keyboard, screen readers and the phone pickers keep working.
export function SelectPill({ className = '', children, ...props }) {
  return (
    <span className={`relative inline-flex max-w-full ${className}`}>
      <select
        {...props}
        className="w-full min-w-0 appearance-none truncate cursor-pointer bg-white border border-[#CBD5E1] rounded-full pl-4 pr-9 py-2 text-xs font-medium text-black transition hover:border-[#1EA0DA] focus:outline-none focus:border-[#1EA0DA] focus:ring-1 focus:ring-[#1EA0DA]"
      >
        {children}
      </select>
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="#12769F"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
        aria-hidden
      >
        <path d="m5 7.5 5 5 5-5" />
      </svg>
    </span>
  );
}

// "Published  [from] to [to]" in one white pill. from / to are "YYYY-MM-DD" ('' = no limit).
export function DateRangePill({ label, from, to, onFrom, onTo }) {
  const input = 'bg-transparent text-xs text-black focus:outline-none focus:text-[#12769F] cursor-pointer';
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 bg-white border border-[#CBD5E1] rounded-full px-3 py-1.5 text-xs text-black transition hover:border-[#1EA0DA] focus-within:border-[#1EA0DA] focus-within:ring-1 focus-within:ring-[#1EA0DA]">
      <span className="font-medium text-black/62">{label}</span>
      <input type="date" aria-label={`${label} from`} value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} className={input} />
      <span className="text-black/46">to</span>
      <input type="date" aria-label={`${label} to`} value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} className={input} />
    </span>
  );
}
