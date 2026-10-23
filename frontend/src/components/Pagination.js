'use client';

import { CustomSelect } from '@/components/FilterControls';

export const PAGE_SIZES = [25, 50, 100];

// Page numbers to show: always the first and last, the current one and its neighbours, '…' for the gaps
function pageList(page, totalPages) {
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  return pages;
}

// "Showing 26–50 of 129" with a rows-per-page picker and Previous / page numbers / Next
export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  const button =
    'min-w-8 h-8 px-2.5 rounded-full text-sm border transition disabled:text-black/36 disabled:border-[#E2E8F0] disabled:cursor-not-allowed';

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-black/62">
        <span>
          Showing <span className="font-semibold text-black tabular-nums">{first}–{last}</span> of{' '}
          <span className="font-semibold text-black tabular-nums">{total}</span>
        </span>
        <div className="flex items-center gap-2">
          Rows per page
          <CustomSelect
            label="Rows per page"
            showLabel={false}
            value={pageSize}
            defaultValue={pageSize}
            onChange={onPageSizeChange}
            options={PAGE_SIZES.map((size) => ({ value: size, label: String(size) }))}
          />
        </div>
      </div>
      {totalPages > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page === 1}
            className={`${button} bg-white border-[#CBD5E1] text-black hover:bg-[#1EA0DA]/6`}
          >
            ← Prev
          </button>
          {pageList(page, totalPages).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="px-1 text-black/46">…</span>
            ) : (
              <button
                key={p}
                onClick={() => onPageChange(p)}
                aria-current={p === page ? 'page' : undefined}
                className={`${button} tabular-nums ${
                  p === page
                    ? 'bg-[#1EA0DA] border-[#1EA0DA] text-white font-semibold'
                    : 'bg-white border-[#CBD5E1] text-black hover:bg-[#1EA0DA]/6'
                }`}
              >
                {p}
              </button>
            )
          )}
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page === totalPages}
            className={`${button} bg-white border-[#CBD5E1] text-black hover:bg-[#1EA0DA]/6`}
          >
            Next →
          </button>
        </nav>
      )}
    </div>
  );
}
