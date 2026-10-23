'use client';

import { useEffect, useRef } from 'react';
import HospitalLinks from '@/components/HospitalLinks';
import { StatusBadge } from '@/components/FilterControls';

// The View details drawer for one list row, shared by PS-PhilGEPS (Bid Match, My Opportunities, Award
// Notices) and PhilGEPS (TenderDetails), so every details panel looks the same:
// - header: the agency (hospital) with its website links, the notice title under it, ✕,
// - a scrolling body: `lead` (bidding dates), a two-column "Tender details" card with every other column,
//   then `children` (our products, bid data sheet, documents…),
// - a footer: Close panel / Open original PhilGEPS notice ↗.
// Only the body scrolls; the page behind is locked while the drawer is open.
// titleColumn / subtitleColumn: the columns for the heading (subtitle = the agency); wide: room for tables.
export default function PsDetailsPanel({ list, row, titleColumn, subtitleColumn, link, wide = false, lead, children, onClose }) {
  const closeButton = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Lock the page behind the drawer so only the drawer's body scrolls
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = before;
    };
  }, []);

  const valueOf = (name) => (name ? row.cells[list.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase())] || '' : '');
  const agency = valueOf(subtitleColumn);
  const title = valueOf(titleColumn);
  const fields = list.headers
    .map((h, i) => ({ h, v: row.cells[i] }))
    .filter(({ h, v }) => v && !/^actions?$/i.test(h) && h !== titleColumn && h !== subtitleColumn);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={agency || title}>
      <button className="absolute inset-0 bg-black/30 backdrop-blur-sm" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className={`relative flex h-full w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} flex-col border-l border-[#E2E8F0] bg-white shadow-2xl`}>
        {/* Header */}
        <header className="flex items-start gap-3 border-b border-[#E2E8F0] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-snug text-black">{agency || title}</h2>
            {/* The agency's own website and latest postings */}
            {agency && <HospitalLinks name={agency} />}
            {agency && title && <p className="mt-1.5 text-sm leading-snug text-black/62">{title}</p>}
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 rounded-full p-2 text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        {/* Body: the only part that scrolls */}
        <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
          {lead}

          {fields.length > 0 && (
            <PanelSection title="Tender details">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                {fields.map(({ h, v }) => (
                  <div key={h} className={String(v).length > 48 ? 'sm:col-span-2' : ''}>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-black/46">{h}</dt>
                    <dd className="mt-0.5 break-words text-sm font-medium text-black">
                      <FieldValue name={h} value={v} />
                    </dd>
                  </div>
                ))}
              </dl>
            </PanelSection>
          )}

          {children}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-[#E2E8F0] bg-white p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6"
          >
            Close panel
          </button>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5]"
            >
              Open original PhilGEPS notice ↗
            </a>
          )}
        </footer>
      </div>
    </div>
  );
}

// A column's value, shaped by what it is: reference numbers as a mono tag, budgets bold green, dates
// readable ("Sep 11, 2026 09:00 AM"), statuses as a pill
function FieldValue({ name, value }) {
  if (/status|acceptance/i.test(name)) return <StatusBadge text={value} />;
  if (/reference|ref\.? ?no|notice number|solicitation/i.test(name)) {
    return <span className="rounded-md border border-[#CBD5E1] bg-white px-2 py-0.5 font-mono text-xs text-black">{value}</span>;
  }
  if (/budget|abc|amount|contract price/i.test(name)) return <span className="font-bold text-[#3F6F2C]">{/^[₱\d]/.test(value) && !value.startsWith('₱') ? `₱${value}` : value}</span>;
  if (/date/i.test(name)) return readableDate(value);
  return value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// PhilGEPS writes "11-Sep-2026 09:00 AM"; anything else is shown as given
function readableDate(text) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(.+))?$/.exec(String(text).trim());
  if (!m) return text;
  const month = MONTHS.find((x) => x.toLowerCase() === m[2].toLowerCase()) || m[2];
  return `${month} ${Number(m[1])}, ${m[3]}${m[4] ? ` ${m[4]}` : ''}`;
}

/**
 * A titled card in the drawer. tone 'blue' tints it (bidding dates); plain drops the card (pill groups).
 */
export function PanelSection({ title, count, tone, plain = false, children }) {
  const heading = (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/62">
      {title}
      {count != null && ` (${count})`}
    </h3>
  );
  if (plain) {
    return (
      <section className="px-1 py-1">
        {heading}
        {children}
      </section>
    );
  }
  return (
    <section className={`rounded-[14px] border border-[#E2E8F0] p-4 ${tone === 'blue' ? 'bg-[#1EA0DA]/[0.02]' : 'bg-white'}`}>
      {heading}
      {children}
    </section>
  );
}

/** Muted tag for a value that isn't known ("Not on the notice page"). */
export function MissingTag({ children }) {
  return <span className="inline-block rounded-md bg-[#E2E8F0]/50 px-2 py-0.5 text-xs text-black/46">{children}</span>;
}

/**
 * Compact label / value rows. items: [[label, value]]; an empty value shows `missing` as a muted tag
 * (or the row is left out when missing isn't given).
 */
export function KeyValueList({ items, missing }) {
  const shown = missing ? items : items.filter(([, value]) => value);
  return (
    <dl className="divide-y divide-[#E2E8F0] text-xs">
      {shown.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 py-1.5 first:pt-0 last:pb-0">
          <dt className="text-black/62">{label}</dt>
          <dd className="break-words font-medium text-black">{value || <MissingTag>{missing}</MissingTag>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Requirement rows with a Found / Not found badge (bid data sheet). items: [[label, value]] */
export function ChecklistList({ items }) {
  return (
    <ul className="divide-y divide-[#E2E8F0] text-xs">
      {items.map(([label, value]) => (
        <li key={label} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
          <span
            className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${value ? 'bg-[#61A644] text-white' : 'border border-[#CBD5E1] bg-white'}`}
            aria-hidden
          >
            {value && (
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                <path d="m4.5 10.5 3.5 3.5 7.5-8" />
              </svg>
            )}
          </span>
          <span className="w-36 shrink-0 text-black/62">{label}</span>
          <span className="min-w-0 flex-1 break-words font-medium text-black">{value || <MissingTag>Not found</MissingTag>}</span>
        </li>
      ))}
    </ul>
  );
}

/** Our products in the drawer: larger green pills. */
export function ProductPills({ names }) {
  if (!names?.length) return <MissingTag>None</MissingTag>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((n) => (
        <span key={n} className="rounded-full border border-[#61A644]/25 bg-[#61A644]/10 px-3 py-1 text-xs font-semibold text-[#3F6F2C] transition-colors hover:bg-[#61A644]/20">
          {n}
        </span>
      ))}
    </div>
  );
}
