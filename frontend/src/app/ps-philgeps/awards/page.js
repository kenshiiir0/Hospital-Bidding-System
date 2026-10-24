'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';
import PsAwardResponse from '@/components/PsAwardResponse';
import { usePsFilters } from '@/components/PsFilters';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';

// My Award Notices: awards the hospitals posted for us, with their acceptance status. An award still "Pending
// for Acceptance" can be accepted or refused only inside its View details drawer (components/PsAwardResponse.js),
// which sends the answer to PS-PhilGEPS.
export default function AwardNoticesPage() {
  const { data, search = '', reload, connected, syncing } = usePsPhilgeps() || {};
  // The open award by its number, so the drawer shows the new status after the list is reloaded
  const [selectedNo, setSelectedNo] = useState(null);
  // Answered from the drawer: keep its result showing after the reload (the row is no longer pending)
  const [answered, setAnswered] = useState(null);
  const list = data?.lists?.awards;
  const column = (name) => list?.headers.indexOf(name) ?? -1;
  const pending = (row) => /pending/i.test(row.cells[column('Award Acceptance')] || '');
  const filters = usePsFilters(list, {
    selects: [
      { label: 'Acceptance', column: 'Award Acceptance' },
      { label: 'Status', column: 'Status' },
      // ITB / RFQ from the procurement mode (lib/tenderType.js), as in the Type column
      { label: 'Type', valuesOf: (row) => [psType(row.cells[list.headers.indexOf('Procurement Mode')]).code].filter(Boolean) },
    ],
    dates: [{ label: 'Award date', column: 'Award Date' }],
    sorts: [
      { label: 'Latest award', column: 'Award Date', kind: 'date', dir: 'desc' },
      { label: 'Latest published', column: 'Publish Date', kind: 'date', dir: 'desc' },
    ],
  });
  const rows = filters.apply((list?.rows || []).filter((row) => matchesSearch(search, row)));
  const selected = selectedNo && list?.rows.find((row) => row.cells[0] === selectedNo);
  const waiting = (list?.rows || []).filter(pending).length;
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        Award Notices {list && <span className="text-sm font-normal text-black/62">· {rows.length} of {list.rows.length} shown</span>}
        {waiting > 0 && <span className="text-sm font-normal text-[#12769F]"> · {waiting} waiting for our answer</span>}
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
        onDetails={(row) => setSelectedNo(row.cells[0])}
      />
      {selected && (
        <PsDetailsPanel
          list={list}
          row={selected}
          titleColumn="Line Item"
          link={selected.links.find((l) => /viewAwardNotice/.test(l.href))?.href}
          lead={
            (pending(selected) || answered === selectedNo) && (
              <PsAwardResponse
                key={selectedNo}
                award={selectedNo}
                lineItem={selected.cells[column('Line Item')]}
                connected={connected}
                syncing={syncing}
                onDone={() => {
                  setAnswered(selectedNo);
                  reload?.();
                }}
              />
            )
          }
          onClose={() => setSelectedNo(null)}
        />
      )}
    </section>
  );
}

// Shown in the list; every other column is in View details
const COLUMNS = ['Award Notice Number', 'Line Item', 'Award Date', 'Status', 'Award Acceptance'];
