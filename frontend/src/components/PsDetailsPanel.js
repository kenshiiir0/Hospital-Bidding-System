'use client';

import { useEffect, useRef } from 'react';
import HospitalLinks from '@/components/HospitalLinks';
import { StatusBadge } from '@/components/FilterControls';
import WorkingDots from '@/components/WorkingDots';
import { readingDocuments } from '@/lib/documentsReading';

// The View details drawer for one list row, shared by PS-PhilGEPS (Bid Match, My Opportunities, Award
// Notices, Screened Tenders) and PhilGEPS (TenderDetails), so every details panel looks the same. Laid out like
// an invoice panel: a floating rounded panel with
// - a header: "Notice #109036" (the row's number), the notice title, open-on-PhilGEPS and ✕,
// - a two-column summary: the procuring entity (with its website links) | published, closing, status,
// - a scrolling body: `lead` (bidding dates), the other details as a quiet list ending in the approved
//   budget as the "total", then `children` (our products, bid data sheet, documents…),
// - a footer: Close / `action` (Add to Screened) / Open original PhilGEPS notice.
// Only the body scrolls; the page behind is locked while the drawer is open.
// titleColumn / subtitleColumn: the columns for the heading (subtitle = the agency); wide: room for tables.
export default function PsDetailsPanel({ list, row, titleColumn, subtitleColumn, link, wide = false, lead, action, children, onClose }) {
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

  // The summary pulls out the number, dates, status and budget; the rest stays in the details list
  const pick = (re) => fields.find(({ h }) => re.test(h));
  const number = pick(/reference|notice number|award notice/i);
  const published = pick(/publish/i);
  const closing = pick(/closing|award date/i);
  const status = pick(/^status$|status of bid|acceptance/i);
  const budget = pick(/budget|abc|contract price|amount/i);
  const used = new Set([number, published, closing, status, budget].filter(Boolean));
  const rest = fields.filter((f) => !used.has(f));
  const kind = /award/i.test(number?.h || '') ? 'Award' : 'Notice';

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={agency || title}>
      <button className="absolute inset-0 bg-black/20" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div
        className={`relative m-0 flex h-dvh w-full ${wide ? 'max-w-2xl' : 'max-w-xl'} flex-col overflow-hidden bg-white shadow-2xl sm:m-3 sm:h-[calc(100dvh-1.5rem)] sm:rounded-2xl sm:border sm:border-[#E2E8F0]`}
      >
        {/* Header: "Notice #109036", the title, link and close */}
        <header className="flex items-start gap-3 border-b border-[#EEF1F5] px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs font-medium uppercase tracking-wide text-black/40">{kind}</span>
              <h2 className="text-base font-semibold text-black">{number ? `#${number.v}` : agency || title}</h2>
            </div>
            {title && <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-black/62" title={title}>{title}</p>}
          </div>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              title="Open the original notice on PhilGEPS"
              aria-label="Open the original notice on PhilGEPS"
              className="shrink-0 rounded-lg border border-[#E2E8F0] p-2 text-black/62 transition hover:border-[#1EA0DA]/40 hover:text-[#12769F]"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                <path d="M11 4h5v5M16 4l-7 7M14 11.5V16H4V6h4.5" />
              </svg>
            </a>
          )}
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 rounded-lg p-2 text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        {/* Body: the only part that scrolls */}
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
          {/* Summary: who it is for | when, and its status */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-black/40">{agency ? 'Procuring entity' : 'Line item'}</div>
              <div className="mt-1 break-words text-sm font-semibold text-black">{agency || title}</div>
              {/* The agency's own website and latest postings */}
              {agency && <HospitalLinks name={agency} />}
            </div>
            <div className="space-y-1.5 text-[13px] sm:min-w-[11rem] sm:text-right">
              {published && (
                <div>
                  <span className="text-black/46">Published </span>
                  <span className="font-medium text-black">{readableDate(published.v)}</span>
                </div>
              )}
              {closing && (
                <div>
                  <span className="text-black/46">{/award/i.test(closing.h) ? 'Awarded ' : 'Closing '}</span>
                  <span className="font-medium text-black">{readableDate(closing.v)}</span>
                </div>
              )}
              {status && (
                <div className="pt-0.5">
                  <StatusBadge text={status.v} />
                </div>
              )}
            </div>
          </section>

          {lead}

          {(rest.length > 0 || budget) && (
            <PanelSection title="Tender details">
              <dl className="text-[13px]">
                {rest.map(({ h, v }) => (
                  <div key={h} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
                    <dt className="text-black/50">{h}</dt>
                    <dd className="min-w-0 break-words text-right font-medium text-black">
                      <FieldValue name={h} value={v} />
                    </dd>
                  </div>
                ))}
                {budget && (
                  <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 border-t border-[#EEF1F5] pt-3">
                    <dt className="font-semibold text-black">Approved budget (ABC)</dt>
                    <dd className="text-base font-semibold tabular-nums text-black">{pesoText(budget.v)}</dd>
                  </div>
                )}
              </dl>
            </PanelSection>
          )}

          {children}
        </div>

        {/* Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#EEF1F5] bg-white px-5 py-3.5">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 hover:text-black">
            Close
          </button>
          <div className="flex flex-wrap items-start justify-end gap-2">
            {action}
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#1790C5]"
              >
                Open original notice ↗
              </a>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// "1906762" / "₱1,906,762.00" -> "₱1,906,762.00"
function pesoText(value) {
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : value;
}

// A column's value, shaped by what it is: reference numbers as a mono tag, budgets bold green, dates
// readable ("Sep 11, 2026 09:00 AM"), statuses as a pill
function FieldValue({ name, value }) {
  if (/status|acceptance/i.test(name)) return <StatusBadge text={value} />;
  if (/reference|ref\.? ?no|notice number|solicitation/i.test(name)) {
    return <span className="font-mono text-xs text-black">{value}</span>;
  }
  if (/budget|abc|amount|contract price/i.test(name)) return <span className="font-semibold text-[#3F6F2C]">{/^[₱\d]/.test(value) && !value.startsWith('₱') ? `₱${value}` : value}</span>;
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
export function PanelSection({ title, count, tone, plain = false, aside, children }) {
  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <h3 className="text-[13px] font-semibold text-black">
        {title}
        {count != null && <span className="ml-1 font-normal text-black/46">({count})</span>}
      </h3>
      {aside}
    </div>
  );
  if (plain) {
    return (
      <section className="space-y-2.5">
        {heading}
        {children}
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white">
      <div className={`border-b border-[#EEF1F5] px-4 py-2.5 ${tone === 'blue' ? 'bg-[#1EA0DA]/[0.05]' : 'bg-[#1EA0DA]/[0.025]'}`}>{heading}</div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** Muted tag for a value that isn't known ("Not on the notice page"). */
/** Scanned files still being read automatically with OCR (read: documents_read); nothing once they are read */
export function ReadingNote({ read }) {
  const reading = readingDocuments(read);
  if (!reading.length) return null;
  return (
    <div role="status" className="rounded-xl border border-[#1EA0DA]/25 bg-[#1EA0DA]/6 p-3 text-xs">
      <p className="inline-flex items-center gap-2 font-semibold text-[#12769F]">
        Reading {reading.length} scanned file{reading.length > 1 ? 's' : ''} automatically (OCR) <WorkingDots />
      </p>
      <p className="mt-0.5 text-black/62">Their products and dates appear here when it finishes.</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-black/80">
        {reading.map((doc) => (
          <li key={doc.name} className="break-all">
            {doc.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
    <dl className="divide-y divide-[#EEF1F5] text-[13px]">
      {shown.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,9rem)_1fr] gap-3 py-2 first:pt-0 last:pb-0">
          <dt className="text-black/50">{label}</dt>
          <dd className="break-words font-medium text-black">{value || <MissingTag>{missing}</MissingTag>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Requirement rows with a Found / Not found badge (bid data sheet). items: [[label, value]] */
export function ChecklistList({ items }) {
  return (
    <ul className="divide-y divide-[#EEF1F5] text-[13px]">
      {items.map(([label, value]) => (
        <li key={label} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
          <span
            className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${value ? 'bg-[#61A644]/15 text-[#3F6F2C]' : 'border border-[#CBD5E1] bg-white'}`}
            aria-hidden
          >
            {value && (
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                <path d="m4.5 10.5 3.5 3.5 7.5-8" />
              </svg>
            )}
          </span>
          <span className="w-36 shrink-0 text-black/50">{label}</span>
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
        <span key={n} className="rounded-full bg-[#61A644]/10 px-3 py-1 text-xs font-medium text-[#3F6F2C] transition-colors hover:bg-[#61A644]/18">
          {n}
        </span>
      ))}
    </div>
  );
}
