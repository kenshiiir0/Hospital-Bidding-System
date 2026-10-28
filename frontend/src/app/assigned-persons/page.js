'use client';

import { useRef, useState } from 'react';
import { BACKUPS, HOSPITALS, PEOPLE, routeAward } from '@/lib/awardRouting.mjs';
import { useScreened } from '@/lib/screened';
import ResponsiveTable from '@/components/ResponsiveTable';
import PageHeader from '@/components/PageHeader';
import { SearchPill, SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';

// Who handles each hospital on the "2MG Incorporated served list of hospitals": the same list the award-notice
// emails go by (lib/awardRouting.mjs), so this page and the emails always agree. The back-ups are copied on every
// email and take any hospital not on the list. Screened: tenders on Screened Tenders (PhilGEPS and PS-PhilGEPS)
// whose agency is that hospital.

const initials = (name) =>
  name
    .split(' ')
    .filter((w) => /^[A-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('');

export default function AssignedPersonsPage() {
  const screened = useScreened();
  const [person, setPerson] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Screened tenders per hospital number, both portals; tenders from agencies not on the list go to the back-ups
  const perHospital = {};
  let unlisted = 0;
  for (const r of screened.rows || []) {
    const { hospital } = routeAward(r.tender?.hospital || '');
    const counts = hospital ? (perHospital[hospital.no] ||= { philgeps: 0, ps: 0 }) : null;
    if (counts) counts[r.source === 'ps' ? 'ps' : 'philgeps']++;
    else unlisted++;
  }

  const hospitals = HOSPITALS.map(([no, name, rep, aliases = []]) => ({ no, name, rep, aliases, screened: perHospital[no] || { philgeps: 0, ps: 0 } })).sort((a, b) => a.no - b.no);
  const representatives = Object.keys(PEOPLE).filter((p) => hospitals.some((h) => h.rep === p));
  const query = search.trim().toLowerCase();
  const rows = hospitals.filter(
    (h) => (person === 'all' || h.rep === person) && (!query || `${h.no} ${h.name} ${h.aliases.join(' ')} ${PEOPLE[h.rep].name}`.toLowerCase().includes(query)),
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const pick = (next) => {
    setPerson(next);
    setPage(1);
  };

  const columns = [
    { label: 'No.', width: '4.5rem', lead: true, render: (h) => <span className="tabular-nums text-black/46">#{h.no}</span> },
    {
      label: 'Hospital',
      title: true,
      render: (h) => (
        <>
          {h.name}
          {h.aliases.length > 0 && <span className="mt-0.5 block text-xs text-black/46">Also: {h.aliases.join(' · ')}</span>}
        </>
      ),
    },
    {
      label: 'Assigned Person',
      width: '15rem',
      render: (h) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={PEOPLE[h.rep].name} />
          <span className="min-w-0">
            <span className="block truncate text-black">{PEOPLE[h.rep].name}</span>
            <a href={`mailto:${PEOPLE[h.rep].email}`} className="block truncate text-xs text-[#12769F] hover:text-[#0E5C7C]">
              {PEOPLE[h.rep].email}
            </a>
          </span>
        </span>
      ),
    },
    { label: 'Back-ups (Cc)', width: '11rem', optional: 1, render: () => BACKUPS.map((p) => PEOPLE[p].name.split(' ')[0]).join(' · ') },
    {
      label: 'Screened',
      width: '8rem',
      nowrap: true,
      render: (h) =>
        h.screened.philgeps + h.screened.ps ? (
          <span className="text-xs text-black/62" title="Screened Tenders from PhilGEPS · PS-PhilGEPS">
            <span className="rounded-full bg-[#61A644]/10 px-2 py-0.5 font-medium text-[#3F6F2C]">{h.screened.philgeps + h.screened.ps}</span>
            <span className="ml-1.5 text-black/46">
              {h.screened.philgeps} · {h.screened.ps}
            </span>
          </span>
        ) : (
          <span className="text-black/46">—</span>
        ),
    },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader
          title="Assigned Persons"
          subtitle={`The representative for each hospital we serve, on PhilGEPS and PS-PhilGEPS · ${hospitals.length} hospitals. Award notices waiting for our answer are emailed to them.`}
        />

        {/* One card per person; a representative's card filters the list to their hospitals */}
        <section aria-label="People" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Object.entries(PEOPLE).map(([key, p]) => {
            const count = hospitals.filter((h) => h.rep === key).length;
            const backup = BACKUPS.includes(key);
            const on = person === key;
            const body = (
              <>
                <Avatar name={p.name} large />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-medium text-black">{p.name}</span>
                  <span className="block truncate text-xs text-black/46">{p.email}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] font-medium">
                    {count > 0 && <span className="rounded-full bg-[#1EA0DA]/8 px-2 py-0.5 text-[#12769F]">{count} hospitals</span>}
                    {backup && <span className="rounded-full bg-[#61A644]/10 px-2 py-0.5 text-[#3F6F2C]">Back-up · Cc on all</span>}
                  </span>
                </span>
              </>
            );
            const box = `flex min-w-0 items-start gap-3 rounded-[14px] border bg-white p-3 sm:p-4 transition ${on ? 'border-[#1EA0DA]/40 bg-[#1EA0DA]/6' : 'border-[#E2E8F0]'}`;
            return count ? (
              <button key={key} type="button" aria-pressed={on} onClick={() => pick(on ? 'all' : key)} className={`${box} hover:border-[#1EA0DA]/40 hover:bg-[#1EA0DA]/6`}>
                {body}
              </button>
            ) : (
              <div key={key} className={box}>
                {body}
              </div>
            );
          })}
        </section>

        <p className="rounded-xl border border-[#E2E8F0] bg-[#1EA0DA]/[0.02] p-3.5 text-xs font-medium text-black/62">
          A hospital not on this list goes to the back-ups ({BACKUPS.map((p) => PEOPLE[p].name.split(' ')[0]).join(' and ')})
          {unlisted ? ` · ${unlisted} screened tender${unlisted > 1 ? 's are' : ' is'} from such agencies` : ''}.
        </p>

        <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 lg:flex-row lg:items-center">
          <SegmentedTabs
            label="Assigned person"
            value={person}
            onChange={pick}
            options={[
              { value: 'all', label: 'All', count: hospitals.length },
              ...representatives.map((p) => ({ value: p, label: PEOPLE[p].name.split(' ')[0], count: hospitals.filter((h) => h.rep === p).length })),
            ]}
          />
          <SearchPill
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search hospital, sheet number or person..."
          />
        </div>

        {screened.error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{screened.error}</p>}

        {rows.length ? (
          <>
            <ResponsiveTable columns={columns} rows={pageRows} rowKey={(h) => h.no} />
            {rows.length > PAGE_SIZES[0] && (
              <Pagination
                page={currentPage}
                pageSize={pageSize}
                total={rows.length}
                onPageChange={goToPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            )}
          </>
        ) : (
          <p className="py-12 text-center text-black/46">No hospital matches the search.</p>
        )}
      </div>
    </div>
  );
}

function Avatar({ name, large }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#1EA0DA]/10 font-semibold text-[#12769F] ${large ? 'h-10 w-10 text-sm' : 'h-7 w-7 text-[11px]'}`}
    >
      {initials(name)}
    </span>
  );
}
