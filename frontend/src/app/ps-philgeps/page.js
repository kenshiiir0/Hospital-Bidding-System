'use client';

import { useState } from 'react';
import { usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';

// Bid Match: PhilGEPS's matched opportunities, filtered again by our products (molecules.json, checked
// against each notice's full page), with the notice's downloaded documents
export default function BidMatchPage() {
  const { data } = usePsPhilgeps() || {};
  const [onlyOurs, setOnlyOurs] = useState(true);
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
        extraColumns={[
          { label: 'Our products', render: (row) => <Products names={noticeOf(row)?.matched} /> },
          { label: 'Documents', render: (row) => <Documents ref_={refOf(row)} notice={noticeOf(row)} /> },
        ]}
      />
    </section>
  );
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
          <a
            href={`/api/documents?source=ps&ref=${ref_}&name=${encodeURIComponent(d.name)}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[#12769F] hover:text-[#0E5C7C] hover:underline break-all"
          >
            📄 {d.name}
          </a>
        </li>
      ))}
    </ul>
  );
}
