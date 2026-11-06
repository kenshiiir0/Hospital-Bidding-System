'use client';

import { useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import Modal from '@/components/Modal';
import { plainAction } from '@/components/PageHeader';

/**
 * "Import Excel" button for the Catalog Management lists. The .xlsx file is read here in the browser (exceljs, like
 * the document viewer), in the same format as the team's WINNING BID TRACKER sheet; a window shows what was found
 * and what will change, and only "Import" saves (PUT to the list's API). Nothing is saved before that.
 * @param {object} props
 * @param {string} props.sheet      Sheet name expected, e.g. "Active Hospital" (shown to the user)
 * @param {string} props.columns    Its columns, shown in the window
 * @param {(wb) => { sheet: string, rows: object[] }} props.read     Reads the workbook (lib/sheetImport.mjs)
 * @param {(rows: object[]) => { headline: string, lines: React.ReactNode[] }} props.describe  Summary of the change
 * @param {string} props.endpoint   API route, e.g. "/api/hospitals"
 * @param {string} props.field      Body field for the rows, e.g. "hospitals"
 * @param {(message: string) => void} props.onDone
 */
export default function ImportExcel({ sheet, columns, read, describe, endpoint, field, onDone, disabled }) {
  const input = useRef(null);
  const [found, setFound] = useState(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setReading(true);
    setFound({ file: file.name });
    try {
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Please choose an .xlsx file (Excel Workbook). An older .xls file can be saved as .xlsx in Excel first.');
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const { sheet: name, rows } = read(wb);
      if (!rows.length) throw new Error(`The "${name}" sheet has no rows to import.`);
      setFound({ file: file.name, sheet: name, rows });
    } catch (err) {
      setError(err.message || 'This file could not be read.');
    }
    setReading(false);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: found.rows }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setFound(null);
      onDone(`Imported "${found.sheet}" from ${found.file}: ${data.added} added, ${data.updated} updated.`);
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  const summary = found?.rows ? describe(found.rows) : null;
  const close = () => {
    if (saving) return;
    setFound(null);
    setError('');
  };

  return (
    <>
      <button type="button" onClick={() => input.current?.click()} disabled={disabled} className={plainAction} title={`Import the "${sheet}" sheet from an Excel file`}>
        ⇪ Import Excel
      </button>
      <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick} className="hidden" />
      {found && (
        <Modal
          title="Import Excel"
          subtitle={found.file}
          busy={saving}
          onClose={close}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
              <path d="M14 3v6h6M12 18v-6M9 15l3-3 3 3" />
            </svg>
          }
          footer={
            <>
              <button type="button" onClick={close} disabled={saving} className="rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60">
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || reading || !found.rows}
                className="rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? 'Importing…' : `Import ${found.rows ? found.rows.length : ''}`.trim()}
              </button>
            </>
          }
        >
          {reading && <p className="text-sm text-black/62">Reading the file…</p>}
          {summary && (
            <section className="rounded-[14px] border border-[#E2E8F0] bg-[#1EA0DA]/[0.02] p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/62">Sheet “{found.sheet}”</h3>
              <p className="text-sm font-medium text-black">{summary.headline}</p>
              <ul className="mt-2 space-y-1 text-xs text-black/62">
                {summary.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="rounded-[14px] border border-[#E2E8F0] p-4 text-xs text-black/62">
            Same format as the WINNING BID TRACKER: a sheet named <b className="text-black">{sheet}</b> (or any sheet with these headers in row 1): {columns}. Nothing is saved until you press Import.
          </section>
          {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
        </Modal>
      )}
    </>
  );
}
