'use client';

import { useState } from 'react';
import { usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';

// My Award Notices: awards the hospitals posted for us, with their acceptance status. Read only for now;
// Accept / Refuse from here comes later, behind a confirmation step.
export default function AwardNoticesPage() {
  const { data } = usePsPhilgeps() || {};
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.awards;
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        Award Notices {list && <span className="text-sm font-normal text-black/62">· {list.rows.length}</span>}
      </h2>
      <PsListTable list={list} empty="No Award Notices data yet. Press Sync PS-PhilGEPS above." columns={COLUMNS} onDetails={setSelected} />
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
