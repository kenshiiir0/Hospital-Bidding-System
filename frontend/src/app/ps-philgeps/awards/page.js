'use client';

import { useEffect, useState } from 'react';
import { matchesSearch, usePsPhilgeps } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import { PEOPLE } from '@/lib/awardRouting.mjs';
import PsListTable from '@/components/PsListTable';
import PsDetailsPanel from '@/components/PsDetailsPanel';
import PsAwardResponse from '@/components/PsAwardResponse';
import { usePsFilters } from '@/components/PsFilters';
import TypeBadge from '@/components/TypeBadge';
import { psType } from '@/lib/tenderType';
import { KpiRow } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';

// My Award Notices: awards the hospitals posted for us, with their acceptance status. An award still "Pending
// for Acceptance" can be accepted or refused only inside its View details drawer (components/PsAwardResponse.js),
// which sends the answer to PS-PhilGEPS.
export default function AwardNoticesPage() {
  const { data, search = '', reload, connected, syncing } = usePsPhilgeps() || {};
  // The open award by its number, so the drawer shows the new status after the list is reloaded
  const [selectedNo, setSelectedNo] = useState(null);
  // Answered from the drawer: keep its result showing after the reload (the row is no longer pending)
  const [answered, setAnswered] = useState(null);
  // Who was emailed about each award waiting for our answer (lib/awardNotify.mjs, run by the Sync)
  const [emails, setEmails] = useState({});
  useEffect(() => {
    supabase
      .from('award_notifications')
      .select('award_no, agency, recipients, status, error, sent_at')
      .then(({ data: rows }) => setEmails(Object.fromEntries((rows || []).map((r) => [r.award_no, r]))));
  }, [data]);
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
  const total = list ? list.rows.length : null;
  useEffect(() => {
    if (total != null) setNavCount('/ps-philgeps/awards', total);
  }, [total]);
  return (
    <section className="space-y-4">
      <KpiRow
        items={[
          { label: 'Total awards', value: rows.length, note: list ? `of ${list.rows.length} award notices` : 'Waiting for the first Sync' },
          { label: 'Accepted', value: rows.filter((row) => /^accepted/i.test(row.cells[column('Award Acceptance')] || '')).length, tone: 'green', note: 'of the listed awards' },
          { label: 'Waiting for our answer', value: waiting, tone: 'blue', note: waiting ? 'Accept or refuse in View details' : 'Nothing pending' },
        ]}
      />
      {filters.bar}
      <PsListTable
        list={list}
        rows={rows}
        empty="No Award Notices data yet. Press Sync PS-PhilGEPS above."
        columns={COLUMNS}
        extraColumns={[
          { label: 'Type', after: 'Award Notice Number', render: (row) => <TypeBadge type={psType(row.cells[list.headers.indexOf('Procurement Mode')])} /> },
          { label: 'Emailed to', render: (row) => <EmailedTo note={emails[row.cells[0]]} /> },
        ]}
        onDetails={(row) => setSelectedNo(row.cells[0])}
      />
      {selected && (
        <PsDetailsPanel
          list={list}
          row={selected}
          titleColumn="Line Item"
          link={selected.links.find((l) => /viewAwardNotice/.test(l.href))?.href}
          onClose={() => setSelectedNo(null)}
        >
          {/* Below Tender details */}
          {(pending(selected) || answered === selectedNo) && (
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
          )}
        </PsDetailsPanel>
      )}
    </section>
  );
}

const firstName = (email) => Object.values(PEOPLE).find((p) => p.email === email)?.name.split(' ')[0] || email;

// The representative first (the back-ups are copied on every email); a failed send shows why
function EmailedTo({ note }) {
  if (!note) return null;
  if (note.status !== 'sent') return <span className="text-xs text-[#B3312C]" title={note.error || ''}>Not sent</span>;
  return (
    <span className="whitespace-nowrap text-xs text-black/70" title={`${note.agency || ''}\n${note.recipients.join(', ')}`}>
      {note.recipients.map(firstName).join(', ')}
    </span>
  );
}

// Shown in the list; every other column is in View details
const COLUMNS = ['Award Notice Number', 'Line Item', 'Award Date', 'Status', 'Award Acceptance'];
