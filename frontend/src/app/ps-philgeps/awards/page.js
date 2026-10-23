'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';
import { usePsFilters } from '@/components/PsFilters';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';

// My Award Notices: awards the hospitals posted for us, with their acceptance status. Read only for now;
// Accept / Refuse from here comes later, behind a confirmation step.
export default function AwardNoticesPage() {
  const { data, search = '' } = usePsPhilgeps() || {};
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.awards;
  const filters = usePsFilters(list, {
    selects: [
      { label: 'Acceptance', column: 'Award Acceptance' },
      { label: 'Status', column: 'Status' },
      { label: 'Mode', column: 'Procurement Mode' },
    ],
    dates: [{ label: 'Award date', column: 'Award Date' }],
    sorts: [
      { label: 'Latest award', column: 'Award Date', kind: 'date', dir: 'desc' },
      { label: 'Latest published', column: 'Publish Date', kind: 'date', dir: 'desc' },
    ],
  });
  const rows = filters.apply((list?.rows || []).filter((row) => matchesSearch(search, row)));
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        Award Notices {list && <span className="text-sm font-normal text-black/62">· {rows.length} of {list.rows.length} shown</span>}
      </h2>
      {filters.bar}
      <PsListTable
        list={list}
        rows={rows}
        empty="No Award Notices data yet. Press Sync PS-PhilGEPS above."
        columns={COLUMNS}
        extraColumns={[
          { label: 'Type', after: 'Award Notice Number', render: (row) => <TypeBadge type={psType(row.cells[list.headers.indexOf('Procurement Mode')])} /> },
        ]}
        onDetails={setSelected}
      />
      {selected && (
        <PsDetailsPanel
          list={list}
          row={selected}
          titleColumn="Line Item"
          link={selected.links.find((l) => /viewAwardNotice/.test(l.href))?.href}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

// Shown in the list; every other column is in View details
const COLUMNS = ['Award Notice Number', 'Line Item', 'Award Date', 'Status', 'Award Acceptance'];
