'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

// The dashboard's filter controls, shared by the PhilGEPS and PS-PhilGEPS pages (and every page added later),
// so all filter bars look and behave the same. Never use a bare <select>, date or search input on a page:
// use these. Dates use our own calendar (DatePicker), never the browser's date picker.

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

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const CALENDAR_WIDTH = 288;

// Dates are "YYYY-MM-DD" strings throughout (what the filters compare), built from local calendar days
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dateOf = (iso) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const addDays = (iso, n) => {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
};
const addMonths = (iso, n) => {
  const d = dateOf(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Stay on the same day, or the month's last day (Jan 31 + 1 month = Feb 28)
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return isoOf(d);
};
const todayIso = () => isoOf(new Date());
const shortDate = (iso) => {
  const d = dateOf(iso);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

function Arrow({ dir, double = false }) {
  const path = dir === 'left' ? (double ? 'm11 5-5 5 5 5M16 5l-5 5 5 5' : 'm12.5 5-5 5 5 5') : double ? 'm9 5 5 5-5 5M4 5l5 5-5 5' : 'm7.5 5 5 5-5 5';
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
      <path d={path} />
    </svg>
  );
}

/**
 * One date, picked on our own calendar (no browser date picker).
 * @param {string} props.label           Read by screen readers ("Published from")
 * @param {string} props.value           "YYYY-MM-DD" or '' (no limit)
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.min] [props.max]  Days outside are greyed out and can't be picked
 * @param {string} [props.rangeStart] [props.rangeEnd]  Shades the days between (the other end of a range)
 */
export function DatePicker({ label, value, onChange, min, max, rangeStart, rangeEnd, placeholder = 'Any date' }) {
  const [open, setOpen] = useState(false);
  // The day the keyboard is on; its month is the month shown (set when the calendar opens, in the browser:
  // today's date must not be read while the page renders on the server)
  const [cursor, setCursor] = useState(value);
  // 'days', or 'months' after a click on the month name (jump to any month and year)
  const [view, setView] = useState('days');
  const [place, setPlace] = useState({ up: false, left: 0 });
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();

  const allowed = (iso) => (!min || iso >= min) && (!max || iso <= max);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (iso) => {
    if (!allowed(iso)) return;
    onChange(iso);
    close();
  };
  const openCalendar = () => {
    // An empty "to" opens on the "from" month (and the other way round), else on today
    const start = value || rangeStart || rangeEnd || (allowed(todayIso()) ? todayIso() : min || max || todayIso());
    setCursor(start);
    setView('days');
    // Keep the calendar on screen: open upwards near the bottom, shift left near the right edge
    const box = trigger.current?.getBoundingClientRect();
    if (box) {
      const overflowRight = box.left + CALENDAR_WIDTH - (window.innerWidth - 12);
      setPlace({
        up: window.innerHeight - box.bottom < 380 && box.top > 380,
        left: overflowRight > 0 ? -Math.min(overflowRight, box.left - 12) : 0,
      });
    }
    setOpen(true);
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
  };

  // A click elsewhere, or another menu / calendar opening, closes this one
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !root.current?.contains(e.target) && setOpen(false);
    const onOther = (e) => e.detail !== id && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener(OPEN_EVENT, onOther);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener(OPEN_EVENT, onOther);
    };
  }, [open, id]);

  // Keyboard focus follows the cursor day
  useEffect(() => {
    if (open && view === 'days') document.getElementById(`${id}-${cursor}`)?.focus();
  }, [open, cursor, view, id]);

  const onKeyDown = (e) => {
    if (view === 'months') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setView('days');
      }
      return;
    }
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in moves) setCursor((c) => addDays(c, moves[e.key]));
    else if (e.key === 'PageUp' || e.key === 'PageDown') setCursor((c) => addMonths(c, (e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1)));
    else if (e.key === 'Home') setCursor((c) => addDays(c, -dateOf(c).getDay()));
    else if (e.key === 'End') setCursor((c) => addDays(c, 6 - dateOf(c).getDay()));
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  };

  // The six weeks shown (only while open): from the Sunday on or before the 1st of the cursor's month
  const showing = open && cursor;
  const shown = showing ? dateOf(cursor) : null;
  const first = showing ? new Date(shown.getFullYear(), shown.getMonth(), 1) : null;
  const days = showing ? Array.from({ length: 42 }, (_, i) => addDays(isoOf(first), i - first.getDay())) : [];
  const month = shown?.getMonth();
  const today = showing ? todayIso() : '';
  const lo = rangeStart || value;
  const hi = rangeEnd || value;

  const navButton = 'flex h-7 w-7 items-center justify-center rounded-lg text-[#12769F] transition hover:bg-[#1EA0DA]/8';

  return (
    <span
      ref={root}
      className="relative inline-flex"
      onBlur={(e) => !root.current?.contains(e.relatedTarget) && setOpen(false)}
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? close() : openCalendar())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value ? shortDate(value) : placeholder}`}
        className={`rounded-full px-2.5 py-1 text-xs font-medium transition hover:bg-[#1EA0DA]/8 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30 ${
          open ? 'bg-[#1EA0DA]/10 text-[#12769F]' : value ? 'text-black' : 'text-black/46'
        }`}
      >
        {value ? shortDate(value) : placeholder}
      </button>

      {showing && (
        <div
          role="dialog"
          aria-label={label}
          onKeyDown={onKeyDown}
          // Focusable, so a click on an empty spot (month name, weekday row, gaps) keeps the calendar open
          tabIndex={-1}
          style={{ left: place.left, width: CALENDAR_WIDTH }}
          className={`absolute z-50 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[#E2E8F0] bg-white p-3 shadow-xl shadow-black/5 focus:outline-none ${
            place.up ? 'bottom-full mb-2' : 'top-full mt-2'
          }`}
        >
          {/* Month and year; the name opens the month / year chooser */}
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              className={navButton}
              onClick={() => setCursor((c) => addMonths(c, -12))}
              aria-label="Previous year"
            >
              <Arrow dir="left" double />
            </button>
            {view === 'days' && (
              <button type="button" className={navButton} onClick={() => setCursor((c) => addMonths(c, -1))} aria-label="Previous month">
                <Arrow dir="left" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setView(view === 'days' ? 'months' : 'days')}
              aria-label={view === 'days' ? 'Choose month and year' : 'Back to days'}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg py-1 text-sm font-semibold text-black transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F]"
            >
              <span aria-live="polite">{view === 'days' ? `${MONTHS_LONG[month]} ${shown.getFullYear()}` : shown.getFullYear()}</span>
              <Chevron open={view === 'months'} />
            </button>
            {view === 'days' && (
              <button type="button" className={navButton} onClick={() => setCursor((c) => addMonths(c, 1))} aria-label="Next month">
                <Arrow dir="right" />
              </button>
            )}
            <button type="button" className={navButton} onClick={() => setCursor((c) => addMonths(c, 12))} aria-label="Next year">
              <Arrow dir="right" double />
            </button>
          </div>

          {/* Months of the shown year: pick one to see its days */}
          {view === 'months' && (
            <div className="grid grid-cols-3 gap-1.5 py-1">
              {MONTHS_SHORT.map((name, m) => {
                const firstDay = isoOf(new Date(shown.getFullYear(), m, 1));
                const lastDay = isoOf(new Date(shown.getFullYear(), m + 1, 0));
                const ok = (!min || lastDay >= min) && (!max || firstDay <= max);
                const current = m === month;
                return (
                  <button
                    key={name}
                    type="button"
                    disabled={!ok}
                    onClick={() => {
                      setCursor((c) => addMonths(c, m - dateOf(c).getMonth()));
                      setView('days');
                    }}
                    className={`rounded-lg py-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:text-black/20 ${
                      current ? 'bg-[#1EA0DA] font-semibold text-white' : 'text-black hover:bg-[#1EA0DA]/8 hover:text-[#12769F]'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Days */}
          <div className={`${view === 'days' ? 'grid' : 'hidden'} grid-cols-7 gap-y-0.5 text-center`} role="grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-black/46" role="columnheader">
                {w}
              </div>
            ))}
            {days.map((iso) => {
              const d = dateOf(iso);
              const inMonth = d.getMonth() === month;
              const ok = allowed(iso);
              const selected = iso === value;
              // The other end of the range counts too, so "to" shows where "from" is
              const inRange = lo && hi && iso >= lo && iso <= hi;
              const isToday = iso === today;
              return (
                <button
                  key={iso}
                  id={`${id}-${iso}`}
                  type="button"
                  role="gridcell"
                  tabIndex={iso === cursor ? 0 : -1}
                  aria-selected={selected}
                  aria-disabled={!ok}
                  aria-label={`${shortDate(iso)}${isToday ? ', today' : ''}`}
                  onClick={() => pick(iso)}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-lg text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA] ${
                    selected
                      ? 'bg-[#1EA0DA] font-semibold text-white'
                      : !ok
                        ? 'cursor-not-allowed text-black/20'
                        : inRange
                          ? 'bg-[#1EA0DA]/10 text-[#12769F] hover:bg-[#1EA0DA]/20'
                          : isToday
                            ? 'font-semibold text-[#12769F] ring-1 ring-inset ring-[#1EA0DA]/40 hover:bg-[#1EA0DA]/8'
                            : inMonth
                              ? 'text-black hover:bg-[#1EA0DA]/8'
                              : 'text-black/30 hover:bg-[#1EA0DA]/8'
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {/* Clear / Today */}
          <div className="mt-2 flex items-center justify-between border-t border-[#E2E8F0] pt-2">
            <button
              type="button"
              onClick={() => {
                onChange('');
                close();
              }}
              className="rounded-lg px-2.5 py-1 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 hover:text-black"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => pick(today)}
              disabled={!allowed(today)}
              className="rounded-lg border border-[#1EA0DA]/25 px-2.5 py-1 text-xs font-semibold text-[#12769F] transition hover:bg-[#1EA0DA]/8 disabled:cursor-not-allowed disabled:border-[#E2E8F0] disabled:text-black/36"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * "📅 Published  [Any date] to [Any date] ✕" in one pill; each date opens our calendar.
 * from / to are "YYYY-MM-DD" ('' = no limit).
 */
export function DateRangePill({ label, from, to, onFrom, onTo, className = '' }) {
  const set = Boolean(from || to);
  return (
    <span
      className={`flex flex-wrap items-center gap-x-1 gap-y-1 rounded-[14px] border px-3.5 py-1 text-xs text-black transition focus-within:border-[#1EA0DA] focus-within:ring-2 focus-within:ring-[#1EA0DA]/20 sm:inline-flex sm:rounded-full ${className} ${
        set ? 'border-[#1EA0DA] bg-[#1EA0DA]/5' : 'border-[#CBD5E1] bg-white hover:border-[#1EA0DA]'
      }`}
    >
      {/* Phones: "📅 Published" on its own line, then "from … to …" */}
      <span className="flex basis-full items-center gap-1.5 sm:basis-auto sm:pr-1">
        <svg viewBox="0 0 20 20" fill="none" stroke="#12769F" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden>
          <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
          <path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
        </svg>
        <span className="font-medium text-black/62">{label}</span>
      </span>
      <span className="text-black/46">from</span>
      <DatePicker label={`${label} from`} value={from} onChange={onFrom} max={to || undefined} rangeEnd={to || undefined} />
      <span className="text-black/46">to</span>
      <DatePicker label={`${label} to`} value={to} onChange={onTo} min={from || undefined} rangeStart={from || undefined} />
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
  // Long statuses ("Pending for Acceptance") wrap inside the pill instead of spilling out of a narrow column
  const long = text.length > 14;
  return (
    <span className={`inline-block max-w-full border px-2.5 py-0.5 text-[11px] font-semibold leading-snug ${long ? 'rounded-xl' : 'whitespace-nowrap rounded-full'} ${tone}`}>
      {text}
    </span>
  );
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
