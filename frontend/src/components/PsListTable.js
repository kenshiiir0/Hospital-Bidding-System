'use client';

import { useState } from 'react';
import { NewPill, PublishedTag, StatusBadge } from '@/components/FilterControls';
import ResponsiveTable from '@/components/ResponsiveTable';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';

// The site's column names as the Bid Match lists (PhilGEPS and PS-PhilGEPS) write them
const LABELS = {
  'notice reference number': 'Ref No.',
  'award notice number': 'Award No.',
  'agency name': 'Procuring Agency',
  'approve budget contract': 'Approved Budget (ABC)',
  'publish date': 'Published',
};
const labelOf = (header) => LABELS[header.toLowerCase()] || header;

const MONTHS = { jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };
// "23-Oct-2026 12:00 AM" -> "Oct 23, 2026" (date only, as the Bid Match lists)
function dayText(text) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(text || '').trim());
  return m ? `${MONTHS[m[2].toLowerCase()] || m[2]} ${Number(m[1])}, ${m[3]}` : text || '—';
}
// "1906762" -> "₱1,906,762.00"
function budgetText(text) {
  const n = Number(String(text || '').replace(/[^\d.]/g, ''));
  return text && Number.isFinite(n) && n > 0 ? `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : text || '—';
}

// A PS-PhilGEPS list as read by ps-philgeps-sync.js ({ headers, rows: [{ cells, links }] }).
// columns: the site's column names to show, in order (default: all but "Actions", PhilGEPS's Select
// menu); the rest, like the long notice title, are in the details panel (onDetails). Links in a cell
// open PhilGEPS in a new tab. extraColumns: [{ label, render(row), after? }] added after the site's columns,
// or right after the site column named in `after`.
// isNew(row): shows NEW next to the first column (lib/newTenders.js).
// Long lists come in pages of 25 / 50 / 100, as on the Bid Match lists.
export default function PsListTable({ list, rows = list?.rows || [], columns, extraColumns = [], onDetails, empty, isNew }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  if (!list) return <EmptyState>{empty}</EmptyState>;
  const indexOf = (name) => list.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const siteColumns = (columns || list.headers.filter((h) => !/^actions?$/i.test(h)))
    .map((h) => ({ h, i: indexOf(h) }))
    .filter(({ i }) => i >= 0);
  // One ordered list: site columns { h, i } with any extra column placed after its `after` column
  const placed = (h) => extraColumns.filter((c) => c.after && c.after.toLowerCase() === h.toLowerCase());
  const shown = [
    ...siteColumns.flatMap((col) => [col, ...placed(col.h)]),
    ...extraColumns.filter((c) => !c.after || !siteColumns.some(({ h }) => h.toLowerCase() === c.after.toLowerCase())),
  ];
  if (!rows.length) return <EmptyState>Nothing to show.</EmptyState>;

  // Cards on narrow screens: the first site column (the notice / award number) is the card's title and the
  // first status column its badge
  const firstStatus = shown.find((c) => !c.render && STATUS_COLUMN.test(c.h));
  const tableColumns = shown.map((col, n) =>
    col.render
      ? {
          label: col.label,
          render: col.render,
          wide: /products|remarks/i.test(col.label),
          width: /products/i.test(col.label) ? undefined : '6.5rem',
          optional: optionalRank(col.label),
        }
      : {
          label: labelOf(col.h),
          title: n === 0,
          badge: col === firstStatus,
          nowrap: /budget|amount/i.test(col.h),
          width: columnWidth(col.h),
          optional: optionalRank(col.h),
          render: (row) =>
            n === 0 && isNew?.(row) ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Cell text={row.cells[col.i]} links={row.links} />
                <NewPill />
              </span>
            ) : STATUS_COLUMN.test(col.h) ? (
              <StatusBadge text={row.cells[col.i]} />
            ) : /publish/i.test(col.h) ? (
              <span className="text-xs">
                <PublishedTag text={dayText(row.cells[col.i])} />
              </span>
            ) : /budget|amount/i.test(col.h) ? (
              <span className="font-mono text-xs font-bold text-black">{budgetText(row.cells[col.i])}</span>
            ) : /agency/i.test(col.h) ? (
              <span className="line-clamp-2 text-xs font-bold leading-tight text-black" title={row.cells[col.i]}>
                {row.cells[col.i]}
              </span>
            ) : /date/i.test(col.h) ? (
              <DateCell text={row.cells[col.i]} />
            ) : (
              <Cell text={row.cells[col.i]} links={row.links} />
            ),
        }
  );

  // Only the current page is drawn; the page is clamped in case the list shrank (a filter, a new Sync)
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  // Row numbers first, as on the PhilGEPS list (counting on across pages)
  const numbered = [{ label: '#', lead: true, width: '3rem', render: (_, i) => <span className="font-mono text-xs text-black/46">{pageStart + i + 1}</span> }, ...tableColumns];
  return (
    <div className="space-y-4">
      <ResponsiveTable columns={numbered} rows={rows.slice(pageStart, pageStart + pageSize)} onDetails={onDetails} />
      <Pagination
        page={currentPage}
        pageSize={pageSize}
        total={rows.length}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </div>
  );
}

// Table widths for the short columns; the rest (agency, title, products) share what is left
function columnWidth(header) {
  if (/budget|amount/i.test(header)) return '7.5rem';
  if (/date/i.test(header)) return '7rem';
  if (/status|acceptance|type|mode/i.test(header)) return '7rem';
  if (/number|ref/i.test(header)) return '6.5rem';
  return undefined;
}

// Columns the table may leave out when space is short (they stay on the cards and in View details):
// publish date first, then mode, remarks, type
function optionalRank(header) {
  if (/publish/i.test(header)) return 1;
  if (/mode/i.test(header)) return 2;
  if (/remarks/i.test(header)) return 3;
  if (/^type$/i.test(header)) return 4;
  return undefined;
}

// Status columns (Status, Status of Bid notice, Bid Submission Status, Award Acceptance) show a coloured pill
const STATUS_COLUMN = /status|acceptance/i;

// "26-Sep-2026 09:00 AM": the date and the time each stay on one line (never "26-Sep-" / "2026")
function DateCell({ text = '' }) {
  const [day, ...time] = String(text).split(' ');
  return (
    <>
      <span className="whitespace-nowrap">{day}</span>
      {time.length > 0 && (
        <>
          {' '}
          <span className="whitespace-nowrap">{time.join(' ')}</span>
        </>
      )}
    </>
  );
}

// A cell whose whole text is one of the row's links (e.g. the notice number) becomes that link
function Cell({ text = '', links = [] }) {
  const link = text && links.find((l) => l.text === text);
  if (!link) return text;
  return (
    <a href={link.href} target="_blank" rel="noreferrer" className="text-[#12769F] hover:text-[#0E5C7C] underline-offset-2 hover:underline">
      {text}
    </a>
  );
}

function EmptyState({ children }) {
  return (
    <div className="rounded-[14px] border border-dashed border-[#CBD5E1] px-4 py-10 text-center text-sm text-black/62">
      {children}
    </div>
  );
}
