'use client';

import { useEffect, useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import ResponsiveTable from '@/components/ResponsiveTable';
import PsBidMatchDetails from '@/components/PsBidMatchDetails';
import { stillReading } from '@/lib/documentsReading';
import { usePsFilters } from '@/components/PsFilters';
import { NewPill, ProductChips as Products, PublishedTag, SegmentedTabs, StatusBadge } from '@/components/FilterControls';
import { useSeenOnOpen, useTenderNews } from '@/lib/newTenders';
import { KpiRow, pesoTotal, pesoValue } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';
import { psRefOf } from '@/lib/opportunityWorkbook';
import TypeBadge from '@/components/TypeBadge';
import { startedByLabel } from '@/components/FetchedSection';
import { psType } from '@/lib/tenderType';

// Bid Match: PhilGEPS's matched opportunities, filtered again by our products (molecules.json, checked
// against each notice's full page), with the notice's downloaded documents
export default function BidMatchPage() {
  const { data, search = '', sync } = usePsPhilgeps() || {};
  // Which tenders: true = our products, false = all
  const [onlyOurs, setOnlyOurs] = useState(true);
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.bidMatch;
  const cell = (row, name) => row.cells[list.headers.indexOf(name)] || '';
  // Dates are shown without the year when it is the year of the last Sync
  const syncYear = data?.syncedAt?.slice(0, 4);
  const notices = data?.notices || {};
  const noticeOf = (row) => notices[refOf(row)];
  const readingOf = (row) => data?.analysis?.[refOf(row)];
  // Who started the Sync that fetched the current list (the status row describes the last run)
  const lastSyncBy = sync?.finished_at && data?.syncedAt && Math.abs(new Date(sync.finished_at) - new Date(data.syncedAt)) < 10 * 60 * 1000 ? startedByLabel(sync.started_by) : null;
  // Our products of a tender: matched on the notice page or named in its documents (a notice titled only
  // "Drugs and Medicines" lists its items in the documents)
  const productsOf = (row) => [...new Set([...(noticeOf(row)?.matched || []), ...(readingOf(row)?.result?.items || []).flatMap((i) => i.our_products)])];
  const ours = (list?.rows || []).filter((row) => productsOf(row).length);
  // Scanned documents still being read automatically with OCR (lib/documentsReading.js)
  const reading = (row) => stillReading(readingOf(row)?.documents_read);
  // New since last read (lib/newTenders.js; the PS-PhilGEPS layout records each Sync's rows)
  const news = useTenderNews();
  const newKey = (row) => `ps:${refOf(row) || row.cells[0]}`;
  // Opening this page reads them: labelled NEW for this visit, gone from the sidebar count
  const seenNow = useSeenOnOpen((list?.rows || []).filter((row) => news.isNewPs(newKey(row))).map(newKey));
  const isNew = (row) => news.isNewPs(newKey(row)) || seenNow.has(newKey(row));
  const filters = usePsFilters(list, {
    headTabs: list && (
      <SegmentedTabs
        label="Which tenders"
        value={onlyOurs}
        onChange={setOnlyOurs}
        options={[
          { value: true, label: 'Our products', count: ours.length },
          { value: false, label: 'All', count: list.rows.length },
        ]}
      />
    ),
    selects: [
      { label: 'Our product', valuesOf: productsOf },
      // ITB / RFQ from the mode of procurement (lib/tenderType.js), as in the Type column
      { label: 'Type', valuesOf: (row) => [psType(row.cells[list.headers.indexOf('Mode of Procurement')]).code].filter(Boolean) },
      { label: 'Status', column: 'Status' },
      // Whether the Sync found and downloaded the notice's documents
      {
        label: 'Documents',
        tabs: true,
        options: ['With documents', 'Without documents'],
        valuesOf: (row) => [noticeOf(row)?.documents?.length ? 'With documents' : 'Without documents'],
      },
    ],
    dates: [
      { label: 'Published', column: 'Publish Date' },
      { label: 'Closing', column: 'Closing Date' },
    ],
    sorts: [
      { label: 'Closing soonest', column: 'Closing Date', kind: 'date', dir: 'asc' },
      { label: 'Latest published', column: 'Publish Date', kind: 'date', dir: 'desc' },
      { label: 'Highest budget', column: 'Approve Budget Contract', kind: 'number', dir: 'desc' },
    ],
  });
  // Sidebar badge: tenders asking for our products
  const oursCount = list ? ours.length : null;
  useEffect(() => {
    if (oursCount != null) setNavCount('/ps-philgeps', oursCount);
  }, [oursCount]);
  // New, unread tenders first (a stable sort keeps the chosen order otherwise)
  const rows = [...(filters.apply((onlyOurs ? ours : list?.rows || []).filter((row) => matchesSearch(search, row, productsOf(row).join(' ')))))].sort((a, b) => Number(isNew(b)) - Number(isNew(a)));


  return (
    <section className="space-y-4">
      <KpiRow
        items={[
          { label: 'Total opportunities', value: rows.length, note: list ? `of ${list.rows.length} in Bid Match · ${ours.length} ask for our products` : 'Waiting for the first Sync' },
          { label: 'Product matches', value: new Set(rows.flatMap(productsOf)).size, tone: 'green', note: 'of our products requested' },
          { label: 'Total ABC value', value: pesoTotal(rows.reduce((sum, row) => sum + pesoValue(cell(row, 'Approve Budget Contract')), 0)), tone: 'blue', note: 'approved budgets of the listed tenders' },
        ]}
      />
      {filters.bar}
      {!list ? (
        <EmptyList>No Bid Match data yet. Press Sync PS-PhilGEPS above.</EmptyList>
      ) : !rows.length ? (
        <EmptyList>Nothing to show.</EmptyList>
      ) : (
        <ResponsiveTable
          rows={rows}
          rowKey={(row) => refOf(row) || row.cells[0]}
          onDetails={setSelected}
          columns={[
            { label: '#', lead: true, width: '3rem', render: (_, i) => <span className="font-mono text-xs text-black/46">{i + 1}</span> },
            {
              label: 'Ref No. & Type',
              title: true,
              width: '8.5rem',
              render: (row) => (
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                    <RefLink row={row} />
                    {isNew(row) && <NewPill />}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <TypeBadge type={psType(cell(row, 'Mode of Procurement'))} />
                    <StatusBadge text={cell(row, 'Status')} />
                  </div>
                  <div className="font-normal"><DocumentCount notice={noticeOf(row)} reading={reading(row)} /></div>
                </div>
              ),
            },
            {
              label: 'Procuring Agency',
              wide: true,
              render: (row) => (
                <span className="line-clamp-2 text-xs font-bold leading-tight text-black" title={cell(row, 'Agency name')}>
                  {cell(row, 'Agency name')}
                </span>
              ),
            },
            {
              label: 'Approved Budget (ABC)',
              width: '9rem',
              align: 'right',
              nowrap: true,
              render: (row) => <span className="font-mono text-xs font-bold text-black">{budgetText(cell(row, 'Approve Budget Contract'))}</span>,
            },
            // Only the published date in the list; the closing date is in View details
            {
              label: 'Published',
              width: '8rem',
              render: (row) => (
                <div className="text-xs">
                  <PublishedTag text={shortPsDate(cell(row, 'Publish Date'), syncYear)} />
                </div>
              ),
            },
            { label: 'Matched Molecules', wide: true, render: (row) => <Products names={productsOf(row)} /> },
          ]}
        />
      )}
      {selected && <PsBidMatchDetails data={data} row={selected} lastSyncBy={lastSyncBy} onClose={() => setSelected(null)} />}
    </section>
  );
}

// The list shows the hospital; the long notice title, mode and classification are in View details
const LIST_COLUMNS = ['Notice Reference Number', 'Agency name', 'Approve Budget Contract', 'Publish Date', 'Closing Date', 'Status'];

function DocumentCount({ notice, reading }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">Not read</span>;
  const n = notice.documents?.length || 0;
  if (!n) return <span className="text-xs text-black/46">None found</span>;
  return (
    <span className="text-xs text-[#3F6F2C]">
      📎 {n} file{n > 1 ? 's' : ''}
      {reading && <span className="block font-medium text-[#12769F]">Reading scans (OCR)</span>}
    </span>
  );
}

// Same rule as ps-philgeps-sync.js: the row's link to its notice page, else a numeric first cell
const refOf = psRefOf;


// The notice number links to the notice on PS-PhilGEPS
function RefLink({ row }) {
  const ref = row.cells[0];
  const link = row.links.find((l) => l.text === ref);
  if (!link) return ref;
  return (
    <a href={link.href} target="_blank" rel="noreferrer" className="text-[#12769F] underline-offset-2 hover:text-[#0E5C7C] hover:underline">
      {ref}
    </a>
  );
}

const MONTH_SHORT = { jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };
// "27-Oct-2026 12:01 AM" -> "Oct 27, 12:01 AM" (the year only when it isn't `year`)
function shortPsDate(text, year) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(.+))?$/.exec(String(text || '').trim());
  if (!m) return text || '—';
  const day = `${MONTH_SHORT[m[2].toLowerCase()] || m[2]} ${Number(m[1])}${m[3] === year ? '' : `, ${m[3]}`}`;
  return m[4] ? `${day}, ${m[4]}` : day;
}

// "1906762" -> "₱1,906,762.00"
function budgetText(text) {
  const n = Number(String(text || '').replace(/[^\d.]/g, ''));
  return text && Number.isFinite(n) && n > 0 ? `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : text || '—';
}

function EmptyList({ children }) {
  return <div className="rounded-[14px] border border-dashed border-[#CBD5E1] px-4 py-10 text-center text-sm text-black/62">{children}</div>;
}
