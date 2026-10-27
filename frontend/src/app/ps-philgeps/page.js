'use client';

import { useEffect, useRef, useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import ResponsiveTable from '@/components/ResponsiveTable';
import PsBidMatchDetails from '@/components/PsBidMatchDetails';
import NumberCircle from '@/components/NumberCircle';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import { stillReading } from '@/lib/documentsReading';
import { usePsFilters, PS_SORTS } from '@/components/PsFilters';
import { MultiSelectDropdown, NewPill, ProductChips as Products, PublishedTag, SegmentedTabs, StatusBadge } from '@/components/FilterControls';
import { useExcludedProducts } from '@/lib/excludedProducts';
import { useSeenOnOpen, useTenderNews } from '@/lib/newTenders';
import { KpiRow, pesoTotal, pesoValue } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';
import { psRefOf } from '@/lib/opportunityWorkbook';
import TypeBadge from '@/components/TypeBadge';
import { startedByLabel } from '@/components/FetchedSection';
import { psType } from '@/lib/tenderType';
import { useScreened } from '@/lib/screened';

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
  // Exclude products: shared with the PhilGEPS page (same saved list); a tender asking for one is hidden
  const { products, excluded, update: updateExcluded } = useExcludedProducts();
  const notExcluded = (row) => !productsOf(row).some((name) => excluded.includes(name));
  // Screened tenders always stay in the list (findable by search) even without our products now (user, 2026-10-27)
  const screened = useScreened();
  const ours = (list?.rows || []).filter((row) => productsOf(row).length || screened.has('ps', refOf(row)));
  const tendersPerProduct = {};
  for (const row of ours) for (const name of productsOf(row)) tendersPerProduct[name] = (tendersPerProduct[name] || 0) + 1;
  // Pages of 25 / 50 / 100, as on the PhilGEPS list
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);
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
      // Whether the Sync found and downloaded the notice's documents (same words as the PhilGEPS tabs)
      {
        label: 'Documents',
        tabs: true,
        options: ['With documents', 'No documents yet'],
        valuesOf: (row) => [noticeOf(row)?.documents?.length ? 'With documents' : 'No documents yet'],
      },
    ],
    extraControls: (
      <MultiSelectDropdown
        label="Exclude products"
        className="w-full sm:w-auto"
        value={excluded}
        onChange={updateExcluded}
        hint="Checked products are left out: any tender asking for one of them is hidden."
        options={products.map((name) => ({ value: name, count: tendersPerProduct[name] || 0 }))}
      />
    ),
    dates: [
      { label: 'Published', column: 'Publish Date' },
      { label: 'Closing', column: 'Closing Date' },
    ],
    // Same choices as the PhilGEPS list, latest published first
    sorts: PS_SORTS,
  });
  // Sidebar badge: tenders asking for our products
  const oursCount = list ? ours.length : null;
  useEffect(() => {
    if (oursCount != null) setNavCount('/ps-philgeps', oursCount);
  }, [oursCount]);
  // New, unread tenders first (a stable sort keeps the chosen order otherwise)
  const rows = [
    ...filters.apply((onlyOurs ? ours : list?.rows || []).filter((row) => notExcluded(row) && matchesSearch(search, row, productsOf(row).join(' ')))),
  ].sort((a, b) => Number(isNew(b)) - Number(isNew(a)));
  // Only the current page is drawn; the page is clamped in case the list shrank (a filter, a new Sync)
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Bid documents the Sync downloaded into the system for a tender (as on PhilGEPS)
  const filesOf = (row) => (noticeOf(row)?.documents || []).filter((doc) => doc.path).length;

  return (
    <section ref={listTop} className="scroll-mt-6 space-y-4">
      <KpiRow
        items={[
          { label: 'Total opportunities', value: rows.length, note: list ? `of ${list.rows.length} in Bid Match · ${ours.length} ask for our products` : 'Waiting for the first Sync' },
          { label: 'Product matches', value: new Set(rows.flatMap(productsOf)).size, tone: 'green', note: 'of our products requested' },
          { label: 'Total ABC value', value: pesoTotal(rows.reduce((sum, row) => sum + pesoValue(cell(row, 'Approve Budget Contract')), 0)), tone: 'blue', note: 'approved budgets of the listed tenders' },
          { label: 'Documents fetched', value: rows.reduce((sum, row) => sum + filesOf(row), 0), tone: 'docs', note: `files of ${rows.filter((row) => filesOf(row) > 0).length} of the ${rows.length} listed tenders` },
        ]}
      />
      {filters.bar}
      {!list ? (
        <EmptyList>No Bid Match data yet. Press Sync PS-PhilGEPS above.</EmptyList>
      ) : !rows.length ? (
        <EmptyList>Nothing to show.</EmptyList>
      ) : (
        <ResponsiveTable
          rows={pageRows}
          rowKey={(row) => refOf(row) || row.cells[0]}
          onDetails={setSelected}
          columns={[
            // Same circle as the PhilGEPS list: green once the notice's documents are downloaded
            { label: '#', lead: true, width: '3rem', render: (row, i) => <NumberCircle n={pageStart + i + 1} hasDocs={noticeOf(row)?.documents?.length > 0} /> },
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
                <span className="line-clamp-2 text-[13px] font-medium leading-snug text-black" title={cell(row, 'Agency name')}>
                  {cell(row, 'Agency name')}
                </span>
              ),
            },
            {
              label: 'Approved Budget (ABC)',
              width: '9rem',
              align: 'right',
              nowrap: true,
              render: (row) => <span className="text-[13px] font-medium tabular-nums text-black">{budgetText(cell(row, 'Approve Budget Contract'))}</span>,
            },
            // Only the published date in the list; the closing date is in View details
            {
              label: 'Published',
              width: '8rem',
              render: (row) => (
                <div className="text-xs">
                  <PublishedTag text={shortPsDay(cell(row, 'Publish Date'), syncYear)} />
                </div>
              ),
            },
            { label: 'Matched Molecules', wide: true, render: (row) => <Products names={productsOf(row)} /> },
          ]}
        />
      )}
      {list && rows.length > 0 && (
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={rows.length}
          onPageChange={goToPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      )}
      {selected && <PsBidMatchDetails data={data} row={selected} lastSyncBy={lastSyncBy} onClose={() => setSelected(null)} />}
    </section>
  );
}

function DocumentCount({ notice, reading }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">Not read</span>;
  const n = notice.documents?.length || 0;
  if (!n) return <span className="text-xs text-[#B3312C]">None yet</span>;
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
// "27-Oct-2026 12:01 AM" -> "Oct 27" (the year only when it isn't `year`), as the PhilGEPS list's Published
function shortPsDay(text, year) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(text || '').trim());
  if (!m) return text || '—';
  return `${MONTH_SHORT[m[2].toLowerCase()] || m[2]} ${Number(m[1])}${m[3] === year ? '' : `, ${m[3]}`}`;
}

// "1906762" -> "₱1,906,762.00"
function budgetText(text) {
  const n = Number(String(text || '').replace(/[^\d.]/g, ''));
  return text && Number.isFinite(n) && n > 0 ? `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : text || '—';
}

function EmptyList({ children }) {
  return <div className="rounded-[14px] border border-dashed border-[#CBD5E1] px-4 py-10 text-center text-sm text-black/62">{children}</div>;
}
