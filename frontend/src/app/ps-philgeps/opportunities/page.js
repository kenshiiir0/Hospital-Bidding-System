'use client';

import { useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';

// My Opportunities: the notices the team already took up on PS-PhilGEPS, with their bid submission status
export default function MyOpportunitiesPage() {
  const { data, search = '' } = usePsPhilgeps() || {};
  const [selected, setSelected] = useState(null);
  const list = data?.lists?.opportunities;
  const rows = (list?.rows || []).filter((row) => matchesSearch(search, row));
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        My Opportunities {list && <span className="text-sm font-normal text-black/62">· {search ? `${rows.length} of ${list.rows.length}` : list.rows.length}</span>}
      </h2>
      <PsListTable list={list} rows={rows} empty="No My Opportunities data yet. Press Sync PS-PhilGEPS above." columns={COLUMNS} onDetails={setSelected} />
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
