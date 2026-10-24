'use client';

import { useRef, useState } from 'react';
import { SearchPill } from '@/components/FilterControls';
import { usePsFilters } from '@/components/PsFilters';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ResponsiveTable from '@/components/ResponsiveTable';
import TypeBadge from '@/components/TypeBadge';
import TenderDetails from '@/components/TenderDetails';
import PsBidMatchDetails from '@/components/PsBidMatchDetails';
import PsDetailsPanel, { KeyValueList, PanelSection, ProductPills } from '@/components/PsDetailsPanel';
import ScreenButton from '@/components/ScreenButton';
import WorkingDots from '@/components/WorkingDots';
import { exportScreened, loadScreenedDetails, removeScreened, useScreened } from '@/lib/screened';
import { formatDate, formatDateTime, formatInstant, instantDay } from '@/lib/format';
import { displayName } from '@/lib/username';

const SOURCES = { philgeps: 'PhilGEPS', ps: 'PS-PhilGEPS' };

// Screened Tenders: the tenders the team picked with "Add to Screened" in View details on the PhilGEPS
// Dashboard and PS-PhilGEPS Bid Match (lib/screened.js). Export Excel writes the ones listed here to the
// team's Opportunity sheet, with each tender as it is now (latest update / Sync), stacked in the order they were screened.
export default function ScreenedPage() {
  const { rows, error } = useScreened();
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState({ tone: '', text: '' });
  const [removing, setRemoving] = useState(null);
  const listTop = useRef(null);

  const all = rows || [];
  // The screened rows as a list the shared filter bar reads (the PS-PhilGEPS pages' usePsFilters): one cell
  // per filter column, dates written as PhilGEPS does ("22-Oct-2026"); `item` is the screened row
  const list = rows ? { headers: LIST_HEADERS, rows: all.map(toListRow) } : null;
  const filters = usePsFilters(list, {
    selects: [
      { label: 'Source', tabs: true, options: Object.values(SOURCES), column: 'Source' },
      { label: 'Our product', valuesOf: (row) => row.item.tender?.products || [] },
      { label: 'Type', column: 'Type' },
      { label: 'Hospital', column: 'Hospital' },
      { label: 'Added by', column: 'Added by' },
    ],
    dates: [
      { label: 'Screened', column: 'Screened Date' },
      { label: 'Published', column: 'Publish Date' },
      { label: 'Closing', column: 'Closing Date' },
    ],
    sorts: [
      // "Added at" is the ISO time; as a number (its digits) it sorts to the second
      { label: 'Recently added', column: 'Added at', kind: 'number', dir: 'desc' },
      { label: 'Closing soonest', column: 'Closing Date', kind: 'date', dir: 'asc' },
      { label: 'Latest published', column: 'Publish Date', kind: 'date', dir: 'desc' },
      { label: 'Oldest published', column: 'Publish Date', kind: 'date', dir: 'asc' },
    ],
  });
  const text = search.trim().toLowerCase();
  // Newest screening day first; within a day the chosen sort (the Excel export still stacks them all in one list)
  const shown = filters
    .apply((list?.rows || []).filter((row) => !text || row.searchText.includes(text)))
    .map((row) => row.item)
    .map((r, i) => ({ r, i, day: instantDay(r.added_at) }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.i - b.i)
    .map(({ r }) => r);
  const perDay = {};
  for (const r of shown) perDay[instantDay(r.added_at)] = (perDay[instantDay(r.added_at)] || 0) + 1;

  // Page shown (1-based) and rows per page; any search, filter or sort change goes back to page 1 (the page
  // number belongs to the filters it was picked under)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const filterKey = JSON.stringify([search, filters.chosen, shown.map((r) => `${r.source}:${r.ref}`)]);
  const [paging, setPaging] = useState({ page: 1, key: '' });
  const page = paging.key === filterKey ? paging.page : 1;
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const goToPage = (next) => {
    setPaging({ page: next, key: filterKey });
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const runExport = async () => {
    setExporting(true);
    setMessage({ tone: '', text: '' });
    try {
      const count = await exportScreened(shown);
      setMessage({ tone: 'success', text: `Exported ${count} screened tender${count === 1 ? '' : 's'}, first screened at the top, latest at the bottom.` });
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

  // View details: the same drawer as on the tender's own page (PhilGEPS Bid Match / PS-PhilGEPS Bid Match),
  // loaded fresh; the saved copy shows while it loads and when the tender is no longer in the latest data.
  // details = { r, result?: { kind, ... }, error? }
  const [details, setDetails] = useState(null);
  const openDetails = (r) => {
    setDetails({ r });
    loadScreenedDetails(r)
      .then((result) => setDetails((d) => (d?.r === r ? { r, result } : d)))
      .catch((err) => setDetails((d) => (d?.r === r ? { r, result: { kind: 'saved' }, error: err.message } : d)));
  };
  const closeDetails = () => setDetails(null);

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
            title="The tenders listed below in the team's Opportunity sheet, first screened at the top, latest at the bottom"
            className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-[#4A8033] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#3F6F2C] disabled:cursor-not-allowed disabled:bg-[#4A8033]/50"
          >
            {exporting ? <>Exporting <WorkingDots /></> : `⬇ Export Excel${rows ? ` (${shown.length})` : ''}`}
          </button>
        </header>

        {error && <Notice tone="error">{error}</Notice>}
        {message.text && <Notice tone={message.tone}>{message.text}</Notice>}

        <SearchPill value={search} onChange={setSearch} placeholder="Search reference no., title, hospital or molecule..." label="Search screened tenders" />
        {filters.bar}

        <div ref={listTop} className="scroll-mt-20 space-y-4">
          {!rows && !error ? (
            <p className="text-sm text-black/46">
              Loading <WorkingDots />
            </p>
          ) : !shown.length ? (
            <div className="rounded-[14px] border border-[#E2E8F0] p-6 text-center text-sm text-black/62">
              {all.length
                ? 'No screened tender matches this search and these filters.'
                : 'Nothing screened yet. Open a tender’s View details on the PhilGEPS Dashboard or PS-PhilGEPS Bid Match and press “+ Add to Screened”.'}
            </div>
          ) : (
            <>
              {/* One block per day the tenders were screened (Philippine date) */}
              {groupByDay(pageRows).map(({ day, items }) => (
                <section key={day} className="space-y-2">
                  <h2 className="flex items-center gap-2 border-b border-[#E2E8F0] pb-1.5 text-sm font-semibold text-black">
                    <span className="h-2 w-2 rounded-full bg-[#61A644]" aria-hidden />
                    Screened {dayLabel(day)}
                    <span className="text-xs font-normal text-black/62">
                      · {perDay[day]} tender{perDay[day] === 1 ? '' : 's'}
                    </span>
                  </h2>
                  <ResponsiveTable columns={columns} rows={items} rowKey={(r) => `${r.source}:${r.ref}`} onDetails={openDetails} />
                </section>
              ))}
              {shown.length > PAGE_SIZES[0] && (
                <Pagination
                  page={currentPage}
                  pageSize={pageSize}
                  total={shown.length}
                  onPageChange={goToPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPaging({ page: 1, key: filterKey });
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {details?.result?.kind === 'philgeps' ? (
        <TenderDetails bid={details.result.bid} onClose={closeDetails} />
      ) : details?.result?.kind === 'ps' ? (
        <PsBidMatchDetails data={details.result.data} row={details.result.row} onClose={closeDetails} />
      ) : details ? (
        <SavedDetails r={details.r} loading={!details.result} error={details.error} onClose={closeDetails} />
      ) : null}
    </div>
  );
}

const LIST_HEADERS = ['Source', 'Type', 'Hospital', 'Added by', 'Publish Date', 'Closing Date', 'Added at', 'Screened Date'];

// Rows (already newest day first) split into days: [{ day: '2026-10-24', items }]
function groupByDay(rows) {
  const groups = [];
  for (const r of rows) {
    const day = instantDay(r.added_at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(r);
  }
  return groups;
}

// "today · Oct 24, 2026", "yesterday · Oct 23, 2026", else "Thu · Oct 22, 2026" (Philippine days)
function dayLabel(day) {
  if (!day) return 'on an unknown day';
  const today = instantDay(new Date().toISOString());
  const yesterday = instantDay(new Date(Date.now() - 86400000).toISOString());
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-PH', { weekday: 'short', timeZone: 'UTC' });
  return `${day === today ? 'today' : day === yesterday ? 'yesterday' : weekday} · ${formatDate(day)}`;
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-10-22..." -> "22-Oct-2026" (closing is stored as the Philippine time written in UTC, so its date part is right)
const philgepsDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
  return m ? `${m[3]}-${MONTH_NAMES[Number(m[2]) - 1]}-${m[1]}` : '';
};
function toListRow(r) {
  const t = r.tender || {};
  return {
    item: r,
    links: [],
    cells: [SOURCES[r.source] || r.source, t.type || '', t.hospital || '', displayName(r.added_by || ''), philgepsDay(t.published), philgepsDay(t.closing), r.added_at || '', philgepsDay(instantDay(r.added_at))],
    searchText: `${r.ref} ${r.title || ''} ${t.hospital || ''} ${(t.products || []).join(' ')} ${(t.molecules || []).map((m) => m[0]).join(' ')}`.toLowerCase(),
  };
}

// The screened tender as it was saved (no longer in the latest update / Sync, or while the latest loads)
function SavedDetails({ r, loading, error, onClose }) {
  const t = r.tender || {};
  const headers = ['Notice Title', 'Agency name', 'Reference Number', 'Source', 'Type', 'Solicitation No.', 'Publish Date', 'Closing Date'];
  const cells = [r.title, t.hospital, r.ref, SOURCES[r.source], t.type, t.solicitationNo, formatDate(t.published), formatDateTime(typeof t.closing === 'string' ? t.closing : '')];
  return (
    <PsDetailsPanel
      list={{ headers }}
      row={{ cells: cells.map((c) => c || ''), links: [] }}
      titleColumn="Notice Title"
      subtitleColumn="Agency name"
      wide
      onClose={onClose}
      action={<ScreenButton source={r.source} tenderRef={r.ref} title={r.title} products={t.products} getTender={() => t} />}
      lead={
        loading ? (
          <Notice>
            Loading the latest details <WorkingDots />
          </Notice>
        ) : (
          <Notice tone={error ? 'error' : 'info'}>
            {error || 'This tender is no longer in the latest PhilGEPS update / PS-PhilGEPS Sync, so this is the copy saved when it was screened.'}
          </Notice>
        )
      }
    >
      <PanelSection title="Bidding dates" tone="blue">
        <KeyValueList
          missing="Not found"
          items={[
            ['Pre-bid conference', t.preBid],
            ['Bid opening', t.bidOpening],
            ['Delivery period', t.deliveryPeriod],
          ]}
        />
      </PanelSection>
      <PanelSection title="Our products" count={(t.products || []).length} plain>
        <ProductPills names={t.products} />
      </PanelSection>
      <PanelSection title="Molecules (as exported)">
        <ResponsiveTable
          size="xs"
          rows={t.molecules || []}
          columns={[
            { label: 'Molecule', title: true, render: (m) => m[0] },
            { label: 'Qty', nowrap: true, render: (m) => m[1] || '—' },
            { label: 'ABC/Unit', nowrap: true, render: (m) => m[2] || '—' },
            { label: 'ABC Total', nowrap: true, render: (m) => (m[3] != null ? Number(m[3]).toLocaleString('en-PH', { minimumFractionDigits: 2 }) : '—') },
          ]}
        />
      </PanelSection>
      <PanelSection title="Contact person">
        <KeyValueList
          items={[
            ['Name', t.contactName],
            ['Designation', t.designation],
            ['Contact no.', t.phone],
            ['Email', t.email],
            ['Address', t.address],
          ]}
        />
      </PanelSection>
    </PsDetailsPanel>
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
