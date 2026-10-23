'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

// The dashboard's filter controls, shared by the PhilGEPS and PS-PhilGEPS pages (and every page added later),
// so all filter bars look and behave the same. Never use a bare <select>, date or search input on a page:
// use these.

const OPEN_EVENT = 'customselect:open';

function Chevron({ open }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 shrink-0 text-[#12769F] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
      aria-hidden
    >
      <path d="m5 7.5 5 5 5-5" />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="#61A644" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </svg>
  );
}

/**
 * Dropdown drawn by us (pill trigger + floating menu), replacing <select>.
 * @param {object} props
 * @param {string} props.label             What is being picked ("Mode"); shown on the trigger and read by screen readers
 * @param {string|number} props.value      The chosen option's value
 * @param {(value: any) => void} props.onChange
 * @param {Array<{ value: string|number, label: string, count?: number }>} props.options
 * @param {string|number} [props.defaultValue='']  The "nothing filtered" value; any other value shows the blue dot
 * @param {boolean} [props.showLabel=true] false: the trigger shows only the chosen option (e.g. "25" in Rows per page)
 * @param {'down'|'up'|'auto'} [props.placement='auto']
 */
export function CustomSelect({ label, value, onChange, options, defaultValue = '', showLabel = true, placement = 'auto', className = '' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [up, setUp] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  // Enter on the trigger also "clicks" it; after choosing with Enter, ignore that click
  const skipClick = useRef(false);
  const listId = useId();
  const searchable = options.length > 10;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => String(o.label).toLowerCase().includes(q)) : options;
  }, [options, query]);
  const selected = options.find((o) => o.value === value);
  const filtered = value !== defaultValue && value !== undefined && value !== null;

  const openMenu = () => {
    const box = trigger.current?.getBoundingClientRect();
    setUp(placement === 'up' || (placement === 'auto' && box && window.innerHeight - box.bottom < 300 && box.top > 300));
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
    // Only one menu open at a time
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: listId }));
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const choose = (option, byKey = false) => {
    onChange(option.value);
    skipClick.current = byKey;
    close();
  };

  // A click anywhere else, or another menu opening, closes this one
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !root.current?.contains(e.target) && setOpen(false);
    const onOther = (e) => e.detail !== listId && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener(OPEN_EVENT, onOther);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener(OPEN_EVENT, onOther);
    };
  }, [open, listId]);

  // Keep the highlighted option in view while moving with the arrow keys
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  const onKeyDown = (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : shown.length - 1);
    } else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) {
      e.preventDefault();
      if (shown[active]) choose(shown[active], true);
    }
  };

  return (
    <div
      ref={root}
      className={`relative inline-flex max-w-full ${className}`}
      onKeyDown={onKeyDown}
      // Focus moving out of the control (Tab, click elsewhere) closes the menu
      onBlur={(e) => !root.current?.contains(e.relatedTarget) && setOpen(false)}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          if (skipClick.current) {
            skipClick.current = false;
            return;
          }
          if (open) close();
          else openMenu();
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={showLabel ? undefined : label}
        className={`inline-flex w-full min-w-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium text-black transition ${
          open || filtered
            ? 'border-[#1EA0DA] bg-[#1EA0DA]/5 ring-2 ring-[#1EA0DA]/20'
            : 'border-[#CBD5E1] bg-white hover:border-[#1EA0DA]'
        } focus:outline-none focus-visible:border-[#1EA0DA] focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/20`}
      >
        {filtered && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1EA0DA]" aria-hidden />}
        <span className="min-w-0 truncate">
          {showLabel && <span className={filtered ? 'text-[#12769F]' : 'text-black/62'}>{label}: </span>}
          {selected?.label ?? '—'}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          className={`absolute left-0 z-50 min-w-[180px] max-w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-[#E2E8F0] bg-white p-1.5 shadow-xl shadow-black/5 ${
            up ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {searchable && (
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={`Find ${label.toLowerCase()}…`}
              aria-label={`Find ${label.toLowerCase()}`}
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              className="mb-1 w-full rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1.5 text-xs text-black placeholder:text-black/46 focus:border-[#1EA0DA] focus:outline-none"
            />
          )}
          <ul id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
            {shown.length === 0 && <li className="px-3 py-2 text-xs text-black/46">No matches</li>}
            {shown.map((o, i) => {
              const isSelected = o.value === value;
              return (
                <li
                  key={String(o.value)}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors ${
                    isSelected
                      ? 'bg-[#1EA0DA]/10 font-semibold text-[#12769F]'
                      : i === active
                        ? 'bg-[#1EA0DA]/8 font-medium text-[#12769F]'
                        : 'text-black/80'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate" title={String(o.label)}>{o.label}</span>
                  {o.count != null && <span className="tabular-nums text-black/46">{o.count}</span>}
                  <span className="w-3.5">{isSelected && <Check />}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "📅 Published from [date] to [date]" in one white pill. from / to are "YYYY-MM-DD" ('' = no limit).
 * The date fields themselves stay the browser's (its calendar and typing work everywhere).
 */
export function DateRangePill({ label, from, to, onFrom, onTo, className = '' }) {
  const input = 'bg-transparent text-xs text-black focus:outline-none focus:text-[#12769F] cursor-pointer';
  const set = Boolean(from || to);
  return (
    <span
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[14px] border px-3.5 py-1.5 text-xs text-black transition focus-within:border-[#1EA0DA] focus-within:ring-2 focus-within:ring-[#1EA0DA]/20 sm:inline-flex sm:rounded-full ${className} ${
        set ? 'border-[#1EA0DA] bg-[#1EA0DA]/5' : 'border-[#CBD5E1] bg-white hover:border-[#1EA0DA]'
      }`}
    >
      {/* Phones: "📅 Published" on its own line, then "from … to …" */}
      <span className="flex basis-full items-center gap-1.5 sm:basis-auto">
        <svg viewBox="0 0 20 20" fill="none" stroke="#12769F" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden>
          <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
          <path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
        </svg>
        <span className="font-medium text-black/62">{label}</span>
      </span>
      <span className="text-black/46">from</span>
      <input type="date" aria-label={`${label} from`} value={from} max={to || undefined} onChange={(e) => onFrom(e.target.value)} className={input} />
      <span className="text-black/46">to</span>
      <input type="date" aria-label={`${label} to`} value={to} min={from || undefined} onChange={(e) => onTo(e.target.value)} className={input} />
      {set && (
        <button
          type="button"
          onClick={() => {
            onFrom('');
            onTo('');
          }}
          aria-label={`Clear ${label.toLowerCase()} dates`}
          className="ml-0.5 rounded-full px-1 text-black/46 hover:text-[#12769F]"
        >
          ✕
        </button>
      )}
    </span>
  );
}

/** Full-width search pill with a magnifier and a ✕ to clear. */
export function SearchPill({ value, onChange, placeholder = 'Search reference no., title, hospital name or molecule...', label = 'Search', className = '' }) {
  return (
    <div
      className={`flex min-w-[16rem] flex-1 items-center gap-2 rounded-full border border-[#CBD5E1] bg-white px-4 py-2 transition hover:border-[#1EA0DA] focus-within:border-[#1EA0DA] focus-within:ring-2 focus-within:ring-[#1EA0DA]/20 ${className}`}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 shrink-0 text-black/46" aria-hidden>
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m13 13 4 4" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-sm text-black placeholder:text-black/46 focus:outline-none"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="rounded-full px-1 text-xs text-black/46 hover:text-[#12769F]">
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * A row of pill tabs ("All (178)" | "With documents (78)" …); the chosen one is solid blue.
 * @param {Array<{ value: any, label: string, count?: number }>} props.options
 */
export function SegmentedTabs({ label, value, onChange, options }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2 text-xs font-medium">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={`rounded-full border px-3.5 py-1.5 transition ${
              on ? 'border-[#1EA0DA] bg-[#1EA0DA] text-white' : 'border-[#CBD5E1] bg-white text-black/62 hover:border-[#1EA0DA] hover:bg-[#1EA0DA]/6 hover:text-black'
            }`}
          >
            {o.label}
            {o.count != null && <span className={`ml-1 tabular-nums ${on ? 'text-white/85' : 'text-black/46'}`}>({o.count})</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Product (molecule) pills: green chips. */
export function ProductChips({ names }) {
  if (!names?.length) return <span className="text-black/46">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <span key={n} className="rounded-full border border-[#61A644]/25 bg-[#61A644]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#3F6F2C] transition-colors hover:bg-[#61A644]/20">
          {n}
        </span>
      ))}
    </div>
  );
}

// PhilGEPS status words: done/positive → solid green, waiting → light blue, ended/negative → white with grey outline
const POSITIVE = /^(active|open|opened|accepted|awarded|approved|submitted|complete[d]?|done|posted|published)\b/i;
const WAITING = /(pending|waiting|for |in progress|ongoing|draft|not yet|open for|evaluation|review)/i;
const ENDED = /(closed|cancel|fail|reject|refus|declin|expired|withdraw|lapsed|not accepted|unsuccessful)/i;

/** A status word as a pill, coloured by meaning. */
export function StatusBadge({ text }) {
  if (!text) return <span className="text-black/46">—</span>;
  const tone = ENDED.test(text)
    ? 'border-[#CBD5E1] bg-white text-black/62'
    : WAITING.test(text)
      ? 'border-[#1EA0DA]/25 bg-[#1EA0DA]/10 text-[#12769F]'
      : POSITIVE.test(text)
        ? 'border-[#61A644] bg-[#61A644] text-white'
        : 'border-[#CBD5E1] bg-white text-black';
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>{text}</span>;
}

/** The row's "View details" action. */
export function DetailsButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-lg px-3 py-1 text-xs font-semibold text-[#12769F] transition-all hover:bg-[#1EA0DA]/8 hover:text-[#0E5C7C]"
    >
      View details
    </button>
  );
}
