'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel, { PanelSection } from '@/components/PsDetailsPanel';
import { usePsFilters } from '@/components/PsFilters';

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
      { label: 'Mode', column: 'Mode of Procurement' },
      { label: 'Status', column: 'Status' },
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
          <div className="flex gap-1 rounded-full border border-[#CBD5E1] p-0.5 text-sm">
            {[
              [true, 'Our products'],
              [false, 'All'],
            ].map(([value, label]) => (
              <button
                key={label}
                onClick={() => setOnlyOurs(value)}
                className={`rounded-full px-3 py-1 transition ${onlyOurs === value ? 'bg-[#1EA0DA] text-white' : 'text-black/62 hover:text-black'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {filters.bar}
      <PsListTable
        list={list}
        rows={rows}
        empty="No Bid Match data yet. Press Sync PS-PhilGEPS above."
        columns={LIST_COLUMNS}
        extraColumns={[
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
            <PanelSection title="Bidding dates">
              <ScheduleList schedule={noticeOf(selected)?.schedule} />
            </PanelSection>
          }
        >
          <PanelSection title="Our products">
            <Products names={productsOf(selected)} />
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

// Bidding dates read from the notice page by the Sync (psSync.mjs readSchedule); a missing one is
// usually only in the bid documents (see "Bid data sheet")
function ScheduleList({ schedule }) {
  if (!schedule) return <span className="text-sm text-black/46">Not read yet (Sync again).</span>;
  const items = [
    ['Pre-bid conference', schedule.prebid],
    ['Pre-bid venue', schedule.prebidVenue],
    ['Bid opening', schedule.bidOpening],
    ['Closing', schedule.closing],
    ['Last updated', schedule.lastUpdated],
  ];
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-black/62">{label}</dt>
          <dd className={value ? 'text-black break-words' : 'text-black/46'}>{value || 'Not on the notice page'}</dd>
        </div>
      ))}
    </dl>
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
          <p className="text-sm text-black/46">The documents haven&rsquo;t been read yet (this happens within a few minutes of a Sync).</p>
        ) : reading.status !== 'done' ? (
          <p className="text-sm text-black/46">{reading.error || 'Not read.'}</p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
            {BDS_FIELDS.map(([label, key]) => (
              <div key={key} className="contents">
                <dt className="text-black/62">{label}</dt>
                <dd className={reading.result.bid_data_sheet[key] ? 'text-black break-words' : 'text-black/46'}>
                  {reading.result.bid_data_sheet[key] || 'Not found'}
                </dd>
              </div>
            ))}
          </dl>
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
function refOf(row) {
  const link = row.links.find((l) => /viewBidNotice\/(\d+)/.test(l.href));
  if (link) return link.href.match(/viewBidNotice\/(\d+)/)[1];
  return /^\d+$/.test(row.cells[0]) ? row.cells[0] : null;
}

function Products({ names }) {
  if (!names?.length) return <span className="text-black/46">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <span key={n} className="rounded-full bg-[#61A644]/10 text-[#3F6F2C] px-2 py-0.5 text-xs">{n}</span>
      ))}
    </div>
  );
}

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
