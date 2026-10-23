'use client';

import { DetailsButton, StatusBadge } from '@/components/FilterControls';

// A PS-PhilGEPS list as read by ps-philgeps-sync.js ({ headers, rows: [{ cells, links }] }).
// columns: the site's column names to show, in order (default: all but "Actions", PhilGEPS's Select
// menu); the rest, like the long notice title, are in the details panel (onDetails). Links in a cell
// open PhilGEPS in a new tab. extraColumns: [{ label, render(row) }] added after the site's columns.
export default function PsListTable({ list, rows = list?.rows || [], columns, extraColumns = [], onDetails, empty }) {
  if (!list) return <EmptyState>{empty}</EmptyState>;
  const indexOf = (name) => list.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const shown = (columns || list.headers.filter((h) => !/^actions?$/i.test(h)))
    .map((h) => ({ h, i: indexOf(h) }))
    .filter(({ i }) => i >= 0);
  if (!rows.length) return <EmptyState>Nothing to show.</EmptyState>;

  return (
    <div className="bg-white rounded-[14px] border border-[#E2E8F0] overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[#1EA0DA]/5 text-left text-xs font-semibold uppercase tracking-wide text-black/62">
          <tr>
            {shown.map(({ h, i }) => (
              <th key={i} className="px-3 py-2.5 font-semibold">{h}</th>
            ))}
            {extraColumns.map((c) => (
              <th key={c.label} className="px-3 py-2.5 font-semibold">{c.label}</th>
            ))}
            {onDetails && <th className="px-3 py-2.5" aria-label="Details" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-[#E2E8F0] align-top bg-white hover:bg-[#1EA0DA]/6 transition-colors">
              {shown.map(({ h, i }) => (
                <td key={i} className="px-3 py-2.5">
                  {STATUS_COLUMN.test(h) ? <StatusBadge text={row.cells[i]} /> : <Cell text={row.cells[i]} links={row.links} />}
                </td>
              ))}
              {extraColumns.map((c) => (
                <td key={c.label} className="px-3 py-2.5">{c.render(row)}</td>
              ))}
              {onDetails && (
                <td className="px-3 py-2.5 text-right">
                  <DetailsButton onClick={() => onDetails(row)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Status columns (Status, Status of Bid notice, Bid Submission Status, Award Acceptance) show a coloured pill
const STATUS_COLUMN = /status|acceptance/i;

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
