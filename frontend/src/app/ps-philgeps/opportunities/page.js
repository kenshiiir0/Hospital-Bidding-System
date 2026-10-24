'use client';

import { useEffect, useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';
import { usePsFilters } from '@/components/PsFilters';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';
import { KpiRow, pesoTotal, pesoValue } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';

// My Opportunities: the notices the team already took up on PS-PhilGEPS, with their bid submission status
export default function MyOpportunitiesPage() {
  const { data, search = '' } = usePsPhilgeps() || {};
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.opportunities;
  const filters = usePsFilters(list, {
    selects: [
      // ITB / RFQ from the mode of procurement (lib/tenderType.js), as in the Type column
      { label: 'Type', valuesOf: (row) => [psType(row.cells[list.headers.indexOf('Mode of Procurement')]).code].filter(Boolean) },
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
  const cell = (row, name) => row.cells[list.headers.indexOf(name)] || '';
  const total = list ? list.rows.length : null;
  useEffect(() => {
    if (total != null) setNavCount('/ps-philgeps/opportunities', total);
  }, [total]);
  return (
    <section className="space-y-4">
      <KpiRow
        items={[
          { label: 'Total opportunities', value: rows.length, note: list ? `of ${list.rows.length} taken up` : 'Waiting for the first Sync' },
          { label: 'Bids submitted', value: rows.filter((row) => /submitted/i.test(cell(row, 'Bid Submission Status')) && !/not/i.test(cell(row, 'Bid Submission Status'))).length, tone: 'green', note: 'of the listed opportunities' },
          { label: 'Total ABC value', value: pesoTotal(rows.reduce((sum, row) => sum + pesoValue(cell(row, 'Approve Budget Contract')), 0)), tone: 'blue', note: 'approved budgets of the listed tenders' },
        ]}
      />
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
