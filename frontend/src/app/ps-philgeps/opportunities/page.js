'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';
import { usePsFilters } from '@/components/PsFilters';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';

// My Opportunities: the notices the team already took up on PS-PhilGEPS, with their bid submission status
export default function MyOpportunitiesPage() {
  const { data, search = '' } = usePsPhilgeps() || {};
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.opportunities;
  const filters = usePsFilters(list, {
    selects: [
      { label: 'Mode', column: 'Mode of Procurement' },
      { label: 'Notice status', column: 'Status of Bid notice' },
      { label: 'Bid submission', column: 'Bid Submission Status' },
    ],
    dates: [
      { label: 'Published', column: 'Publish Date' },
      { label: 'Closing', column: 'Closing Date' },
    ],
    sorts: [
      { label: 'Latest closing', column: 'Closing Date', kind: 'date', dir: 'desc' },
      { label: 'Closing soonest', column: 'Closing Date', kind: 'date', dir: 'asc' },
      { label: 'Highest budget', column: 'Approve Budget Contract', kind: 'number', dir: 'desc' },
    ],
  });
  const rows = filters.apply((list?.rows || []).filter((row) => matchesSearch(search, row)));
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        My Opportunities {list && <span className="text-sm font-normal text-black/62">· {rows.length} of {list.rows.length} shown</span>}
      </h2>
      {filters.bar}
      <PsListTable
        list={list}
        rows={rows}
        empty="No My Opportunities data yet. Press Sync PS-PhilGEPS above."
        columns={COLUMNS}
        extraColumns={[
          { label: 'Type', after: 'Notice Reference Number', render: (row) => <TypeBadge type={psType(row.cells[list.headers.indexOf('Mode of Procurement')])} /> },
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
        />
      )}
    </section>
  );
}

// Shown in the list; every other column is in View details
const COLUMNS = ['Notice Reference Number', 'Agency name', 'Approve Budget Contract', 'Closing Date', 'Status of Bid notice', 'Bid Submission Status'];
