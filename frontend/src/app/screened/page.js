'use client';

import { useRef, useState } from 'react';
import { SearchPill, SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ResponsiveTable from '@/components/ResponsiveTable';
import TypeBadge from '@/components/TypeBadge';
import WorkingDots from '@/components/WorkingDots';
import { exportScreened, removeScreened, useScreened } from '@/lib/screened';
import { formatDate, formatDateTime, formatInstant } from '@/lib/format';
import { displayName } from '@/lib/username';

const SOURCES = { philgeps: 'PhilGEPS', ps: 'PS-PhilGEPS' };

// Screened Tenders: the tenders the team picked with "Add to Screened" in View details on the PhilGEPS
// Dashboard and PS-PhilGEPS Bid Match (lib/screened.js). Export Excel writes the ones listed here to the
// team's Opportunity sheet, with each tender as it is now (latest update / Sync), oldest published at the top.
export default function ScreenedPage() {
  const { rows, error } = useScreened();
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState({ tone: '', text: '' });
  const [removing, setRemoving] = useState(null);
  // Page shown (1-based) and rows per page; a search or tab change goes back to page 1
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);

  const all = rows || [];
  const text = search.trim().toLowerCase();
  const shown = all.filter(
    (r) =>
      (source === 'all' || r.source === source) &&
      (!text || `${r.ref} ${r.title || ''} ${r.tender?.hospital || ''} ${(r.tender?.molecules || []).map((m) => m[0]).join(' ')}`.toLowerCase().includes(text))
  );
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const runExport = async () => {
    setExporting(true);
    setMessage({ tone: '', text: '' });
    try {
      const count = await exportScreened(shown);
      setMessage({ tone: 'success', text: `Exported ${count} screened tender${count === 1 ? '' : 's'}, oldest published at the top.` });
    } catch (err) {
      setMessage({ tone: 'error', text: `Export failed: ${err.message}` });
    }
    setExporting(false);
  };

  const remove = async (r) => {
    setRemoving(`${r.source}:${r.ref}`);
    setMessage({ tone: '', text: '' });
    try {
      await removeScreened(r.source, r.ref);
    } catch (err) {
      setMessage({ tone: 'error', text: `Could not remove ${r.ref}: ${err.message}` });
    }
    setRemoving(null);
  };

  const columns = [
    { label: 'Source', width: '7.5rem', badge: true, render: (r) => <SourceTag source={r.source} /> },
    { label: 'Reference', title: true, width: '8rem', nowrap: true, render: (r) => <span className="font-mono text-xs">{r.ref}</span> },
    { label: 'Type', width: '6rem', render: (r) => <TypeBadge type={r.tender?.type ? { code: r.tender.type, title: r.tender.type } : null} /> },
    {
      label: 'Hospital',
      wide: true,
      render: (r) => (
        <>
          <span className="font-medium text-black">{r.tender?.hospital || '—'}</span>
          {r.title && <span className="mt-0.5 block text-xs text-black/62">{r.title}</span>}
        </>
      ),
    },
    { label: 'Molecules', wide: true, render: (r) => <Molecules lines={r.tender?.molecules} /> },
    { label: 'Published', width: '7.5rem', nowrap: true, optional: 2, render: (r) => formatDate(r.tender?.published) || '—' },
    { label: 'Closing', width: '9.5rem', optional: 3, render: (r) => formatDateTime(typeof r.tender?.closing === 'string' ? r.tender.closing : '') || '—' },
    {
      label: 'Added',
      width: '9rem',
      optional: 1,
      render: (r) => (
        <span className="text-xs text-black/62">
          {displayName(r.added_by || '') || '—'}
          <span className="block text-black/46">{formatInstant(r.added_at)}</span>
        </span>
      ),
    },
    {
      label: '',
      width: '6.5rem',
      render: (r) => (
        <button
          type="button"
          onClick={() => remove(r)}
          disabled={removing === `${r.source}:${r.ref}`}
          className="rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-xs font-medium text-black/62 transition hover:border-[#B3312C]/40 hover:bg-[#B3312C]/6 hover:text-[#B3312C] disabled:cursor-wait disabled:opacity-60"
        >
          {removing === `${r.source}:${r.ref}` ? 'Removing…' : 'Remove'}
        </button>
      ),
    },
  ];

  const count = (key) => all.filter((r) => key === 'all' || r.source === key).length;

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#61A644]" aria-hidden />
              Screened Tenders
            </h1>
            <p className="text-xs text-black/62 mt-1">
              Tenders added with &ldquo;Add to Screened&rdquo; in View details on PhilGEPS and PS-PhilGEPS
              {rows ? ` · ${all.length} screened` : ''}
            </p>
          </div>
          <button
            onClick={runExport}
            disabled={exporting || !shown.length}
            title="The tenders listed below in the team's Opportunity sheet, oldest published at the top"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-[#4A8033] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#3F6F2C] disabled:cursor-not-allowed disabled:bg-[#4A8033]/50"
          >
            {exporting ? <>Exporting <WorkingDots /></> : `⬇ Export Excel${rows ? ` (${shown.length})` : ''}`}
          </button>
        </header>

        {error && <Notice tone="error">{error}</Notice>}
        {message.text && <Notice tone={message.tone}>{message.text}</Notice>}

        <div className="flex flex-wrap items-center gap-3">
          <SearchPill
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search reference no., title, hospital or molecule..."
            label="Search screened tenders"
          />
          <SegmentedTabs
            label="Source"
            value={source}
            onChange={(value) => {
              setSource(value);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All', count: count('all') },
              { value: 'philgeps', label: 'PhilGEPS', count: count('philgeps') },
              { value: 'ps', label: 'PS-PhilGEPS', count: count('ps') },
            ]}
          />
        </div>

        <div ref={listTop} className="scroll-mt-20 space-y-4">
          {!rows && !error ? (
            <p className="text-sm text-black/46">
              Loading <WorkingDots />
            </p>
          ) : !shown.length ? (
            <div className="rounded-[14px] border border-[#E2E8F0] p-6 text-center text-sm text-black/62">
              {all.length
                ? 'No screened tender matches this search.'
                : 'Nothing screened yet. Open a tender’s View details on the PhilGEPS Dashboard or PS-PhilGEPS Bid Match and press “+ Add to Screened”.'}
            </div>
          ) : (
            <>
              <ResponsiveTable columns={columns} rows={pageRows} rowKey={(r) => `${r.source}:${r.ref}`} />
              {shown.length > PAGE_SIZES[0] && (
                <Pagination
                  page={currentPage}
                  pageSize={pageSize}
                  total={shown.length}
                  onPageChange={goToPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceTag({ source }) {
  const tone = source === 'ps' ? 'border-[#1EA0DA]/30 bg-[#1EA0DA]/8 text-[#12769F]' : 'border-[#CBD5E1] bg-white text-black/62';
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{SOURCES[source] || source}</span>;
}

// The tender's molecule lines as they go into the sheet (first column), the first three then "+n more"
function Molecules({ lines = [] }) {
  if (!lines.length) return <span className="text-black/46">—</span>;
  return (
    <span className="block text-xs text-[#3F6F2C]">
      {lines.slice(0, 3).map((line, i) => (
        <span key={i} className="block">
          {line[0]}
        </span>
      ))}
      {lines.length > 3 && <span className="block text-black/46">+{lines.length - 3} more</span>}
    </span>
  );
}

function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/6 text-[#12769F]',
    success: 'border-[#61A644]/25 bg-[#61A644]/8 text-[#3F6F2C]',
    error: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-3.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </div>
  );
}
