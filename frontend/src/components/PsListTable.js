'use client';

import { StatusBadge } from '@/components/FilterControls';
import ResponsiveTable from '@/components/ResponsiveTable';

// A PS-PhilGEPS list as read by ps-philgeps-sync.js ({ headers, rows: [{ cells, links }] }).
// columns: the site's column names to show, in order (default: all but "Actions", PhilGEPS's Select
// menu); the rest, like the long notice title, are in the details panel (onDetails). Links in a cell
// open PhilGEPS in a new tab. extraColumns: [{ label, render(row), after? }] added after the site's columns,
// or right after the site column named in `after`.
export default function PsListTable({ list, rows = list?.rows || [], columns, extraColumns = [], onDetails, empty }) {
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
          label: col.h,
          title: n === 0,
          badge: col === firstStatus,
          nowrap: /budget|amount/i.test(col.h),
          width: columnWidth(col.h),
          optional: optionalRank(col.h),
          render: (row) =>
            STATUS_COLUMN.test(col.h) ? (
              <StatusBadge text={row.cells[col.i]} />
            ) : /date/i.test(col.h) ? (
              <DateCell text={row.cells[col.i]} />
            ) : (
              <Cell text={row.cells[col.i]} links={row.links} />
            ),
        }
  );

  return <ResponsiveTable columns={tableColumns} rows={rows} onDetails={onDetails} />;
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
