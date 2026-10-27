'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// View of a tender's Word or Excel file (browsers can't show them and download them instead; user, 2026-10-27).
// Opened by View in Attached documents (DocumentsPanel) for both portals: ?bucket=&path=&name= for a file in
// Storage, ?src=&name= for an older one served by /api/documents. Read in the browser only (docx-preview, exceljs):
// the file goes to no other service.
export default function DocumentView() {
  return (
    <Suspense fallback={null}>
      <Viewer />
    </Suspense>
  );
}

const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

function Viewer() {
  const params = useSearchParams();
  const name = params.get('name') || 'Document';
  const [url, setUrl] = useState(null);
  const [state, setState] = useState({ status: 'loading' });
  const [sheets, setSheets] = useState(null);
  const docRef = useRef(null);

  useEffect(() => {
    document.title = name;
    let cancelled = false;
    (async () => {
      try {
        let link = params.get('src');
        if (!link) {
          const { data, error } = await supabase.storage.from(params.get('bucket')).createSignedUrl(params.get('path'), 3600);
          if (error || !data?.signedUrl) throw new Error(error?.message || 'no link');
          link = data.signedUrl;
        }
        if (cancelled) return;
        setUrl(link);
        const response = await fetch(link);
        if (!response.ok) throw new Error(`the file could not be fetched (${response.status})`);
        const bytes = await response.arrayBuffer();
        const ext = extensionOf(name);
        if (ext === 'docx') {
          const { renderAsync } = await import('docx-preview');
          if (cancelled || !docRef.current) return;
          await renderAsync(bytes, docRef.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true });
        } else if (ext === 'xlsx') {
          const ExcelJS = (await import('exceljs')).default;
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(bytes);
          const read = workbook.worksheets.map((ws) => {
            const rows = [];
            ws.eachRow({ includeEmpty: false }, (row) => {
              const cells = [];
              for (let c = 1; c <= ws.columnCount; c++) cells.push(row.getCell(c).text ?? '');
              rows.push(cells);
            });
            return { name: ws.name, rows };
          });
          if (!cancelled) setSheets(read);
        } else {
          // Anything else the browser can show itself
          window.location.replace(link);
          return;
        }
        if (!cancelled) setState({ status: 'done' });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: e.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, name]);

  return (
    <div className="min-h-screen bg-[#F1F5F9] text-black antialiased">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[#E2E8F0] bg-white px-4 py-3 sm:px-6">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#3F6F2C]" title={name}>
          {name}
        </h1>
        {url && (
          <a
            href={url}
            download={name}
            className="flex items-center gap-1.5 rounded-lg bg-[#1EA0DA] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-[#1790C5]"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
              <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3.5 16.5h13" />
            </svg>
            Save
          </a>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {state.status === 'loading' && <p className="text-sm text-black/46">Opening the file…</p>}
        {state.status === 'error' && (
          <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/8 p-3 text-sm text-[#B3312C]">
            Could not show {name}: {state.message}. Use Save to download it.
          </p>
        )}
        {/* Word: the document as laid out in the file */}
        <div ref={docRef} className="overflow-x-auto" />
        {/* Excel: each sheet as a table */}
        {sheets?.map((sheet) => (
          <section key={sheet.name} className="mb-6 rounded-xl border border-[#E2E8F0] bg-white p-3 shadow-sm">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-black/46">{sheet.name}</h2>
            {sheet.rows.length === 0 ? (
              <p className="text-sm text-black/46">Empty sheet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <tbody>
                    {sheet.rows.map((cells, r) => (
                      <tr key={r} className={r === 0 ? 'bg-[#61A644]/10 font-semibold' : ''}>
                        {cells.map((text, c) => (
                          <td key={c} className="border border-[#E2E8F0] px-2 py-1 align-top whitespace-pre-wrap">
                            {text}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </main>
    </div>
  );
}
