'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { DetailsButton } from '@/components/FilterControls';

// Columns without a set width need at least this much room to stay readable in the table
const FLEX_COLUMN_REM = 8;
const DETAILS_COLUMN_REM = 6.5;
const rem = (value) => (value ? parseFloat(value) : FLEX_COLUMN_REM);

/**
 * Every list in the dashboard: a table when its box is wide enough for its columns (set widths, plus 8rem for
 * each column without one). When it is a little short, the table first leaves out the `optional` columns
 * (lowest number first; they stay on the cards and in View details); only when even that doesn't fit does it
 * become one card per row (phones, tablets, a narrow window, the details drawer). The box is measured, so this
 * follows the space the list really has, whatever the screen or zoom. Nothing scrolls sideways.
 *
 * columns: [{ label, render(row, index), lead?, title?, badge?, wide?, nowrap?, align?, width? }]
 *   lead   - shown before the card's title (e.g. the row number circle)
 *   title  - the card's heading (e.g. the reference number)
 *   badge  - shown at the card's top right (e.g. the status pill)
 *   wide   - takes the card's full width (long text, product pills)
 *   nowrap - keeps the table cell on one line (short values like amounts)
 *   width  - the table column's width (e.g. '8rem'); columns without one share the rest
 *   optional - a number: the table may leave this column out when space is short (1 goes first)
 * onDetails(row): adds the "View details" action (last table column, full-width button on cards).
 * rowKey(row, index): React key.
 */
export default function ResponsiveTable({ columns, rows, onDetails, rowKey = (_, i) => i, size = 'sm' }) {
  const lead = columns.find((c) => c.lead);
  const title = columns.find((c) => c.title);
  const badge = columns.find((c) => c.badge);
  const body = columns.filter((c) => !c.lead && !c.title && !c.badge);
  const text = size === 'xs' ? 'text-xs' : 'text-sm';

  // The list's box width (cards until it has been measured)
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Table columns: all of them if they fit, else without the optional ones (lowest number first)
  const fits = (cols) => (cols.reduce((sum, c) => sum + rem(c.width), 0) + (onDetails ? DETAILS_COLUMN_REM : 0)) * 16 <= width;
  let tableColumns = columns;
  for (const drop of columns.filter((c) => c.optional).sort((a, b) => a.optional - b.optional)) {
    if (fits(tableColumns)) break;
    tableColumns = tableColumns.filter((c) => c !== drop);
  }
  const asTable = width > 0 && fits(tableColumns);

  return (
    <div ref={box} className="@container min-w-0">
      {/* Wide: a table */}
      <div className={`${asTable ? 'block' : 'hidden'} overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-white`}>
        <table className={`w-full table-fixed ${text}`}>
          <thead className="bg-[#1EA0DA]/5 text-left text-xs font-semibold uppercase tracking-wide text-black/62">
            <tr>
              {tableColumns.map((c) => (
                <th
                  key={c.label}
                  style={c.width ? { width: c.width } : undefined}
                  className={`px-3 py-2.5 font-semibold break-words first:rounded-tl-[14px] ${c.align === 'right' ? 'text-right' : ''}`}
                >
                  {c.label}
                </th>
              ))}
              {onDetails && <th style={{ width: `${DETAILS_COLUMN_REM}rem` }} className="px-3 py-2.5 rounded-tr-[14px]" aria-label="Details" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={rowKey(row, i)} className="border-t border-[#E2E8F0] align-top bg-white transition-colors hover:bg-[#1EA0DA]/6">
                {tableColumns.map((c) => (
                  <td
                    key={c.label}
                    className={`px-3 py-2.5 ${c.nowrap ? 'whitespace-nowrap' : 'break-words [overflow-wrap:anywhere]'} ${c.align === 'right' ? 'text-right' : ''}`}
                  >
                    {c.render(row, i)}
                  </td>
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

      {/* Narrow: one card per row */}
      <ul className={`${asTable ? 'hidden' : ''} space-y-2.5`}>
        {rows.map((row, i) => (
          <li key={rowKey(row, i)} className="rounded-[14px] border border-[#E2E8F0] bg-white p-4">
            {(lead || title || badge) && (
              <div className="flex items-start gap-2.5">
                {lead && <div className="shrink-0">{lead.render(row, i)}</div>}
                {title && (
                  <div className="min-w-0 flex-1 break-words text-sm font-semibold text-black [overflow-wrap:anywhere]">
                    <span className="sr-only">{title.label}: </span>
                    {title.render(row, i)}
                  </div>
                )}
                {badge && <div className="ml-auto shrink-0">{badge.render(row, i)}</div>}
              </div>
            )}
            {body.length > 0 && (
              <dl className={`grid grid-cols-1 gap-x-4 gap-y-2.5 @xs:grid-cols-2 @2xl:grid-cols-4 ${lead || title || badge ? 'mt-3' : ''}`}>
                {body.map((c) => (
                  <div key={c.label} className={`min-w-0 ${c.wide ? '@xs:col-span-2 @2xl:col-span-4' : ''}`}>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-black/46">{c.label}</dt>
                    <dd className={`mt-0.5 break-words text-black [overflow-wrap:anywhere] ${text}`}>{c.render(row, i)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {onDetails && (
              <div className="mt-3 border-t border-[#E2E8F0] pt-3">
                <button
                  type="button"
                  onClick={() => onDetails(row)}
                  className="w-full rounded-lg border border-[#1EA0DA]/25 px-3 py-2 text-xs font-semibold text-[#12769F] transition hover:bg-[#1EA0DA]/8"
                >
                  View details
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
