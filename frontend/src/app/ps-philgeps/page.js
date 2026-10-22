'use client';

import { useState } from 'react';
import { usePsPhilgeps } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel, { PanelSection } from '@/components/PsDetailsPanel';

// Bid Match: PhilGEPS's matched opportunities, filtered again by our products (molecules.json, checked
// against each notice's full page), with the notice's downloaded documents
export default function BidMatchPage() {
  const { data } = usePsPhilgeps() || {};
  const [onlyOurs, setOnlyOurs] = useState(true);
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.bidMatch;
  const notices = data?.notices || {};
  const noticeOf = (row) => notices[refOf(row)];
  const ours = (list?.rows || []).filter((row) => noticeOf(row)?.matched?.length);
  const rows = onlyOurs ? ours : list?.rows;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          Bid Match{' '}
          {list && (
            <span className="text-sm font-normal text-black/62">
              · {ours.length} of {list.rows.length} mention our products
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
      <PsListTable
        list={list}
        rows={rows}
        empty="No Bid Match data yet. Press Sync PS-PhilGEPS above."
        columns={LIST_COLUMNS}
        extraColumns={[
          { label: 'Pre-bid / Opening', render: (row) => <KeyDates schedule={noticeOf(row)?.schedule} /> },
          { label: 'Our products', render: (row) => <Products names={noticeOf(row)?.matched} /> },
          { label: 'Documents', render: (row) => <DocumentCount notice={noticeOf(row)} /> },
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
          onClose={() => setSelected(null)}
        >
          <PanelSection title="Schedule">
            <ScheduleList schedule={noticeOf(selected)?.schedule} />
          </PanelSection>
          <PanelSection title="Our products">
            <Products names={noticeOf(selected)?.matched} />
          </PanelSection>
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

// Key dates read from the notice page by the Sync (psSync.mjs readSchedule); a missing one is usually
// only in the bid documents
function KeyDates({ schedule }) {
  if (!schedule) return <span className="text-black/46">—</span>;
  return (
    <div className="text-xs space-y-0.5">
      <div><span className="text-black/46">Pre-bid </span>{schedule.prebid || '—'}</div>
      <div><span className="text-black/46">Opening </span>{schedule.bidOpening || '—'}</div>
    </div>
  );
}

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
