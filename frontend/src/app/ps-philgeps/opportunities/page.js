'use client';

import { usePsPhilgeps } from '@/lib/psContext';
import PsListTable from '@/components/PsListTable';

// My Opportunities: the notices the team already took up on PS-PhilGEPS, with their bid submission status
export default function MyOpportunitiesPage() {
  const { data } = usePsPhilgeps() || {};
  const list = data?.lists?.opportunities;
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">
        My Opportunities {list && <span className="text-sm font-normal text-black/62">· {list.rows.length}</span>}
      </h2>
      <PsListTable list={list} empty="No My Opportunities data yet. Press Sync PS-PhilGEPS above." />
    </section>
  );
}
