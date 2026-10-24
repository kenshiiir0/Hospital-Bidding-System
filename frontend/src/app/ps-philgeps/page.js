'use client';

import { useEffect, useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import ResponsiveTable from '@/components/ResponsiveTable';
import PsDetailsPanel, { ChecklistList, KeyValueList, ManualCheckNote, MissingTag, PanelSection, ProductPills } from '@/components/PsDetailsPanel';
import { needsManualCheck } from '@/lib/manualCheck';
import { usePsFilters } from '@/components/PsFilters';
import { ProductChips as Products, PublishedTag, SegmentedTabs, StatusBadge } from '@/components/FilterControls';
import { KpiRow, pesoTotal, pesoValue } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';
import { psRefOf, psTender } from '@/lib/opportunityWorkbook';
import { bidDateText, deliveryText } from '@/lib/bidDates';
import ScreenButton from '@/components/ScreenButton';
import TypeBadge from '@/components/TypeBadge';
import FetchedSection, { startedByLabel } from '@/components/FetchedSection';
import { formatInstant } from '@/lib/format';
import { psType } from '@/lib/tenderType';

// Bid Match: PhilGEPS's matched opportunities, filtered again by our products (molecules.json, checked
// against each notice's full page), with the notice's downloaded documents
export default function BidMatchPage() {
  const { data, search = '', sync } = usePsPhilgeps() || {};
  // Which tenders: true = our products, false = all, 'check' = documents that couldn't be read (lib/manualCheck.js)
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
  const needsCheck = (row) => needsManualCheck(readingOf(row)?.documents_read);
  // Also the tenders with no product found: our products may be in the files that couldn't be read
  const toCheck = (list?.rows || []).filter(needsCheck);
  const filters = usePsFilters(list, {
    headTabs: list && (
      <SegmentedTabs
        label="Which tenders"
        value={onlyOurs}
        onChange={setOnlyOurs}
        options={[
          { value: true, label: 'Our products', count: ours.length },
          { value: false, label: 'All', count: list.rows.length },
          { value: 'check', label: 'Need manual check', count: toCheck.length },
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
  const rows = filters.apply((onlyOurs === 'check' ? toCheck : onlyOurs ? ours : list?.rows || []).filter((row) => matchesSearch(search, row, productsOf(row).join(' '))));


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
                  <div className="font-semibold"><RefLink row={row} /></div>
                  <div className="flex flex-wrap gap-1">
                    <TypeBadge type={psType(cell(row, 'Mode of Procurement'))} />
                    <StatusBadge text={cell(row, 'Status')} />
                  </div>
                  <div className="font-normal"><DocumentCount notice={noticeOf(row)} check={needsCheck(row)} /></div>
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
            {
              label: 'Dates',
              width: '10rem',
              render: (row) => (
                <div className="space-y-1 text-xs">
                  <PublishedTag text={shortPsDate(cell(row, 'Publish Date'), syncYear)} />
                  <div><span className="text-black/46">Close:</span> <span className="font-medium">{shortPsDate(cell(row, 'Closing Date'), syncYear)}</span></div>
                </div>
              ),
            },
            { label: 'Matched Molecules', wide: true, render: (row) => <Products names={productsOf(row)} /> },
          ]}
        />
      )}
      {selected && (
        <PsDetailsPanel
          list={list}
          row={selected}
          titleColumn="Notice Title"
          subtitleColumn="Agency name"
          link={selected.links.find((l) => /viewBidNotice/.test(l.href))?.href}
          wide
          onClose={() => setSelected(null)}
          action={
            <ScreenButton
              source="ps"
              tenderRef={refOf(selected)}
              title={selected.cells[list.headers.indexOf('Notice Title')]}
              products={productsOf(selected)}
              getTender={() => psTender(selected, list.headers, noticeOf(selected), readingOf(selected))}
            />
          }
          lead={
            <>
              <PanelSection title="Bidding dates" tone="blue">
                <ScheduleList schedule={noticeOf(selected)?.schedule} reading={readingOf(selected)} />
              </PanelSection>
              {/* When this tender was fetched (the last Sync's list) and its documents read, and the automatic schedule */}
              <FetchedSection
                items={[
                  ['Last fetched', data?.syncedAt && [formatInstant(data.syncedAt), lastSyncBy].filter(Boolean).join(' · ')],
                  ['Documents read', readingOf(selected)?.analyzed_at && `${formatInstant(readingOf(selected).analyzed_at)} · Automatic`],
                ]}
              />
            </>
          }
        >
          <PanelSection title="Our products" count={productsOf(selected).length} plain>
            <ProductPills names={productsOf(selected)} />
          </PanelSection>
          <FromDocuments reading={readingOf(selected)} />
          <PanelSection title="Documents">
            <Documents ref_={refOf(selected)} notice={noticeOf(selected)} />
          </PanelSection>
        </PsDetailsPanel>
      )}
    </section>
  );
}

// The list shows the hospital; the long notice title, mode and classification are in View details
const LIST_COLUMNS = ['Notice Reference Number', 'Agency name', 'Approve Budget Contract', 'Publish Date', 'Closing Date', 'Status'];

// The top of View details, where the team looks first: every date and term needed to bid. Each comes from
// the notice page (Sync, psSync.mjs readSchedule) or, when the notice page doesn't give it, from the bid
// documents (psDocs.mjs bid data sheet, tagged "from documents"). The full sections stay further down.
function ScheduleList({ schedule, reading }) {
  if (!schedule && !reading) return <MissingTag>Not read yet (Sync again)</MissingTag>;
  const bds = reading?.status === 'done' ? reading.result.bid_data_sheet : {};
  const pick = (fromPage, fromDocs) => fromPage || (fromDocs && <FromDocs text={fromDocs} />) || null;
  return (
    <KeyValueList
      missing="Not found"
      items={[
        ['Pre-bid conference', pick(schedule?.prebid && [schedule.prebid, schedule.prebidVenue].filter(Boolean).join(' · '), bidDateText(bds.prebid_conference))],
        ['Request for clarification', pick(schedule?.clarification)],
        ['Bid opening', pick(schedule?.bidOpening, bidDateText(bds.bid_opening))],
        ['Submission deadline', pick(schedule?.deadline, bidDateText(bds.bid_submission_deadline))],
        ['Closing', pick(schedule?.closing)],
        ['Delivery period', pick(null, deliveryText(bds.delivery_period))],
        ['Bid validity', pick(null, bds.bid_validity)],
        ['Bid security', pick(null, bds.bid_security)],
        ['Last updated', pick(schedule?.lastUpdated)],
      ]}
    />
  );
}

function FromDocs({ text }) {
  return (
    <>
      {text} <span className="ml-1 whitespace-nowrap rounded bg-[#61A644]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#3F6F2C]">from documents</span>
    </>
  );
}

// What was read in the tender's PDFs (lib/psDocs.mjs: free text rules; scanned PDFs can't be read)
const BDS_FIELDS = [
  ['Pre-bid conference', 'prebid_conference'],
  ['Bid opening', 'bid_opening'],
  ['Submission deadline', 'bid_submission_deadline'],
  ['Delivery period', 'delivery_period'],
  ['Bid validity', 'bid_validity'],
  ['Bid security', 'bid_security'],
];
const peso = (n) => (n == null ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 }));

function FromDocuments({ reading }) {
  return (
    <>
      <PanelSection title="Bid data sheet (from the documents)">
        {!reading ? (
          <p className="text-xs text-black/46">The documents haven&rsquo;t been read yet (this happens within a few minutes of a Sync).</p>
        ) : reading.status !== 'done' ? (
          <MissingTag>{reading.error || 'Not read'}</MissingTag>
        ) : (
          <ChecklistList items={BDS_FIELDS.map(([label, key]) => [label, reading.result.bid_data_sheet[key]])} />
        )}
        {needsManualCheck(reading?.documents_read) && (
          <div className="mt-2">
            <ManualCheckNote read={reading.documents_read} />
          </div>
        )}
      </PanelSection>
      {reading?.status === 'done' && (
        <PanelSection title={`Molecule tracker (${reading.result.items.length} lines naming our products)`}>
          {reading.result.items.length === 0 ? (
            <p className="text-sm text-black/46">No line in the readable documents names our products.</p>
          ) : (
            <ResponsiveTable
              size="xs"
              rows={reading.result.items}
              columns={[
                { label: 'Product', title: true, render: (it) => <span className="text-[#3F6F2C]">{it.our_products.join(', ')}</span> },
                { label: 'Item', render: (it) => it.item_no ?? '—' },
                { label: 'Qty', nowrap: true, render: (it) => (it.quantity != null ? it.quantity.toLocaleString('en-PH') : '—') },
                { label: 'Unit', render: (it) => it.unit ?? '—' },
                { label: 'Unit price', nowrap: true, render: (it) => peso(it.unit_price) },
                { label: 'Total', nowrap: true, render: (it) => peso(it.total) },
                { label: 'As written', wide: true, render: (it) => <span className="text-black/62">{it.quantity != null ? it.line : it.context}</span> },
                { label: 'Page', render: (it) => <span className="text-black/46">{it.source.split(', ').pop()}</span> },
              ]}
            />
          )}
        </PanelSection>
      )}
    </>
  );
}

function DocumentCount({ notice, check }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">Not read</span>;
  const n = notice.documents?.length || 0;
  if (!n) return <span className="text-xs text-black/46">None found</span>;
  return (
    <span className="text-xs text-[#3F6F2C]">
      📎 {n} file{n > 1 ? 's' : ''}
      {check && <span className="block font-medium text-[#B3312C]">Check by hand</span>}
    </span>
  );
}

// Same rule as ps-philgeps-sync.js: the row's link to its notice page, else a numeric first cell
const refOf = psRefOf;


function Documents({ ref_, notice }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">{notice.error}</span>;
  if (!notice.documents?.length) return <span className="text-xs text-black/46">None found</span>;
  return (
    <ul className="space-y-1">
      {notice.documents.map((d) => (
        <li key={d.name}>
          <button
            onClick={() => openDocument(ref_, d)}
            className="text-left text-xs text-[#12769F] hover:text-[#0E5C7C] hover:underline break-all"
          >
            📄 {d.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Documents live in the private Supabase bucket "ps-documents" (see tools/ps-publish.js): open a
// short-lived signed link. The tab is opened first so the browser doesn't block it as a pop-up.
// Documents from before the upload existed only on the computer that synced (/api/documents there).
async function openDocument(ref, doc) {
  if (!doc.path) {
    window.open(`/api/documents?source=ps&ref=${ref}&name=${encodeURIComponent(doc.name)}`, '_blank', 'noopener');
    return;
  }
  const tab = window.open('', '_blank');
  const { data, error } = await supabase.storage.from('ps-documents').createSignedUrl(doc.path, 3600);
  if (error || !data?.signedUrl) {
    tab?.close();
    alert(`Could not open ${doc.name}: ${error?.message || 'no link'}`);
    return;
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.location.href = data.signedUrl;
}

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
