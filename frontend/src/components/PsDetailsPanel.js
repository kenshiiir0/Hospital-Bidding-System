'use client';

import { useEffect } from 'react';

// Side panel for one PS-PhilGEPS list row: the title (long notice title or award line item) as the
// heading, then every column PhilGEPS shows, plus optional extra sections (our products, documents).
// titleColumn / subtitleColumn: column names used for the heading.
export default function PsDetailsPanel({ list, row, titleColumn, subtitleColumn, link, children, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valueOf = (name) => row.cells[list.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase())] || '';
  const fields = list.headers
    .map((h, i) => ({ h, v: row.cells[i] }))
    .filter(({ h, v }) => v && !/^actions?$/i.test(h) && h !== titleColumn && h !== subtitleColumn);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={valueOf(titleColumn)}>
      <button className="absolute inset-0 bg-black/20" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full overflow-y-auto bg-white p-6 shadow-[0_4px_16px_rgba(0,0,0,.08)] space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-black leading-snug">{valueOf(titleColumn)}</h2>
            {subtitleColumn && <p className="text-sm text-black/62 mt-1">{valueOf(subtitleColumn)}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full px-3 py-1 text-sm text-black/62 hover:bg-[#1EA0DA]/6" aria-label="Close">
            ✕
          </button>
        </div>

        <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
          {fields.map(({ h, v }) => (
            <div key={h} className="contents">
              <dt className="text-black/62">{h}</dt>
              <dd className="text-black break-words">{v}</dd>
            </div>
          ))}
        </dl>

        {children}

        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="inline-block text-sm text-[#12769F] hover:text-[#0E5C7C] hover:underline">
            Open on PhilGEPS ↗
          </a>
        )}
      </div>
    </div>
  );
}

export function PanelSection({ title, children }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-black/46">{title}</h3>
      {children}
    </section>
  );
}
