'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel, { ChecklistList, KeyValueList, MissingTag, PanelSection, ProductPills } from '@/components/PsDetailsPanel';
import { usePsFilters } from '@/components/PsFilters';
import { ProductChips as Products, SegmentedTabs } from '@/components/FilterControls';
import { psRefOf } from '@/lib/opportunityWorkbook';
import { psTenders } from '@/lib/unifiedExport';
import { useExportScope } from '@/lib/exportScope';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';

// Bid Match: PhilGEPS's matched opportunities, filtered again by our products (molecules.json, checked
// against each notice's full page), with the notice's downloaded documents
export default function BidMatchPage() {
  const { data, search = '' } = usePsPhilgeps() || {};
  const [onlyOurs, setOnlyOurs] = useState(true);
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.bidMatch;
  const notices = data?.notices || {};
  const noticeOf = (row) => notices[refOf(row)];
  const readingOf = (row) => data?.analysis?.[refOf(row)];
  // Our products of a tender: matched on the notice page or named in its documents (a notice titled only
  // "Drugs and Medicines" lists its items in the documents)
  const productsOf = (row) => [...new Set([...(noticeOf(row)?.matched || []), ...(readingOf(row)?.result?.items || []).flatMap((i) => i.our_products)])];
  const ours = (list?.rows || []).filter((row) => productsOf(row).length);
  const filters = usePsFilters(list, {
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
  const rows = filters.apply((onlyOurs ? ours : list?.rows || []).filter((row) => matchesSearch(search, row, productsOf(row).join(' '))));

  // The sidebar's Export Excel uses these rows (all filters applied) plus the PhilGEPS tenders matching the
  // same search (lib/exportScope.js, lib/unifiedExport.js). Until the data loads, it exports everything.
  useExportScope('ps-bid-match', () =>
    data
      ? {
          from: 'ps',
          getShown: () => psTenders(data, rows),
          search,
          type: filters.chosen.Type || '',
          summary: `${rows.length} Bid Match listed here${search ? ` · search "${search}"` : ''}${filters.chosen.Type ? ` · ${filters.chosen.Type} only` : ''}`,
        }
      : {}
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          Bid Match{' '}
          {list && (
            <span className="text-sm font-normal text-black/62">
              · {ours.length} of {list.rows.length} mention our products · {rows.length} shown
            </span>
          )}
        </h2>
        {list && (
          <SegmentedTabs
            label="Which tenders"
            value={onlyOurs}
            onChange={setOnlyOurs}
            options={[
              { value: true, label: 'Our products', count: ours.length },
              { value: false, label: 'All', count: list.rows.length },
            ]}
          />
        )}
      </div>
      {filters.bar}
      <PsListTable
        list={list}
        rows={rows}
        empty="No Bid Match data yet. Press Sync PS-PhilGEPS above."
        columns={LIST_COLUMNS}
        extraColumns={[
          { label: 'Type', after: 'Notice Reference Number', render: (row) => <TypeBadge type={psType(row.cells[list.headers.indexOf('Mode of Procurement')])} /> },
          { label: 'Our products', render: (row) => <Products names={productsOf(row)} /> },
          { label: 'Remarks', render: (row) => <DocumentCount notice={noticeOf(row)} /> },
        ]}
        onDetails={setSelected}
      />
      {selected && (
        <PsDetailsPanel
          list={list}
          row={selected}
          titleColumn="Notice Title"
          subtitleColumn="Agency name"
          link={selected.links.find((l) => /viewBidNotice/.test(l.href))?.href}
          wide
          onClose={() => setSelected(null)}
          lead={
            <PanelSection title="Bidding dates" tone="blue">
              <ScheduleList schedule={noticeOf(selected)?.schedule} reading={readingOf(selected)} />
            </PanelSection>
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
        ['Pre-bid conference', pick(schedule?.prebid && [schedule.prebid, schedule.prebidVenue].filter(Boolean).join(' · '), bds.prebid_conference)],
        ['Bid opening', pick(schedule?.bidOpening, bds.bid_opening)],
        ['Submission deadline', pick(null, bds.bid_submission_deadline)],
        ['Closing', pick(schedule?.closing)],
        ['Delivery period', pick(null, bds.delivery_period)],
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
  const scanned = (reading?.documents_read || []).filter((d) => d.kind === 'scanned');
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
        {scanned.length > 0 && (
          <p className="text-xs text-black/46 mt-2">
            Scanned (not readable as text): {scanned.map((d) => d.name).join(', ')}
          </p>
        )}
      </PanelSection>
      {reading?.status === 'done' && (
        <PanelSection title={`Molecule tracker (${reading.result.items.length} lines naming our products)`}>
          {reading.result.items.length === 0 ? (
            <p className="text-sm text-black/46">No line in the readable documents names our products.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px] border border-[#E2E8F0]">
              <table className="w-full text-xs">
                <thead className="bg-[#1EA0DA]/5 text-left text-black/62">
                  <tr>
                    {['Product', 'Item', 'Qty', 'Unit', 'Unit price', 'Total', 'As written', 'Page'].map((h) => (
                      <th key={h} className="px-2.5 py-2 font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reading.result.items.map((it, i) => (
                    <tr key={i} className="border-t border-[#E2E8F0] align-top">
                      <td className="px-2.5 py-2 font-medium text-[#3F6F2C]">{it.our_products.join(', ')}</td>
                      <td className="px-2.5 py-2">{it.item_no ?? '—'}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{it.quantity != null ? it.quantity.toLocaleString('en-PH') : '—'}</td>
                      <td className="px-2.5 py-2">{it.unit ?? '—'}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{peso(it.unit_price)}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap">{peso(it.total)}</td>
                      <td className="px-2.5 py-2 text-black/62 min-w-[16rem]">{it.quantity != null ? it.line : it.context}</td>
                      <td className="px-2.5 py-2 whitespace-nowrap text-black/46">{it.source.split(', ').pop()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelSection>
      )}
    </>
  );
}

function DocumentCount({ notice }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">Not read</span>;
  const n = notice.documents?.length || 0;
  return n ? <span className="text-xs text-[#3F6F2C]">📎 {n} file{n > 1 ? 's' : ''}</span> : <span className="text-xs text-black/46">None found</span>;
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
