'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { agencyKey } from '@/lib/agencyKey';
import { HOSPITALS, PEOPLE, routeAward } from '@/lib/awardRouting.mjs';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';
import { SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import PageHeader, { KpiRow, blueAction } from '@/components/PageHeader';

// The hospitals we bid for (table hospitals, /api/hospitals): the "Active Hospital" sheet of the WINNING BID TRACKER
// (tools/import-hospitals.mjs) plus Add Hospital. The same hospitals post tenders on PhilGEPS and PS-PhilGEPS.
const STATUS = {
  active: { label: 'Active tender', tab: 'Active', pill: 'bg-[#61A644]/10 text-[#3F6F2C]' },
  rfq: { label: 'RFQ', tab: 'RFQ', pill: 'bg-[#1EA0DA]/8 text-[#12769F]' },
  prospect: { label: 'Prospect', tab: 'Prospects', pill: 'bg-[#E2E8F0]/70 text-black/62' },
};

// Who handles the hospital (Assigned Persons, lib/awardRouting.mjs); not on that list = the back-ups
function assigned(name) {
  const { hospital } = routeAward(name);
  const rep = hospital && HOSPITALS.find(([no]) => no === hospital.no)?.[2];
  return rep ? PEOPLE[rep].name.split(' ')[0] : null;
}

export default function HospitalsPage() {
  const [hospitals, setHospitals] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState('');
  const [view, setView] = useState('active');
  const [archiving, setArchiving] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/hospitals');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setHospitals(data);
      setError('');
    } catch (e) {
      setError(`Could not load the hospital list: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(load);
  }, [load]);

  const setArchived = async (hospital, archived) => {
    const res = await authFetch('/api/hospitals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agency_key: hospital.agency_key, archived }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    setAdded(archived ? `${hospital.name} was archived. Restore it from Archived any time.` : `${hospital.name} was restored to the list.`);
    await load();
  };

  const restore = async (hospital) => {
    setRestoring(hospital.agency_key);
    setError('');
    try {
      await setArchived(hospital, false);
    } catch (e) {
      setError(`Could not restore ${hospital.name}: ${e.message}`);
    }
    setRestoring(null);
  };

  const all = hospitals || [];
  const listed = all.filter((h) => !h.archived_at);
  const archived = all.filter((h) => h.archived_at);
  const byStatus = (s) => listed.filter((h) => h.status === s);
  const shown = view === 'archived' ? archived : byStatus(view);
  const query = search.trim().toLowerCase();
  const text = (h) => `${h.name} ${h.list_note || ''} ${h.emails.join(' ')} ${h.contacts.map((c) => `${c.name || ''} ${c.phone || ''}`).join(' ')} ${assigned(h.name) || ''}`.toLowerCase();
  const rows = shown.filter((h) => !query || text(h).includes(query));
  const noEmail = listed.filter((h) => h.status !== 'prospect' && !h.emails.length).length;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const actionButton = 'whitespace-nowrap rounded-lg px-3 py-1 text-xs font-semibold transition-all disabled:opacity-60';
  const columns = [
    {
      label: 'Hospital',
      title: true,
      render: (h) => (
        <span>
          {/* Capitals as on the sheet; names saved from View details are in mixed case */}
          {h.name.toUpperCase()}
          {h.website && (
            <a href={h.website} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-xs font-normal text-[#12769F] hover:text-[#0E5C7C] hover:underline">
              {h.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
            </a>
          )}
        </span>
      ),
    },
    {
      label: 'Status',
      width: '11rem',
      render: (h) => (
        <span>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS[h.status].pill}`}>{STATUS[h.status].label}</span>
          {h.list_note && <span className="mt-1 block text-xs text-black/62">{h.list_note}</span>}
        </span>
      ),
    },
    {
      label: 'Contact Person',
      render: (h) =>
        h.contacts.length ? (
          <ul className="space-y-1 text-xs">
            {h.contacts.map((c, i) => (
              <li key={i}>
                <span className="text-black">{c.name || '—'}</span>
                {c.phone && <span className="block tabular-nums text-black/62">{c.phone}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-black/46">—</span>
        ),
    },
    {
      label: 'Email',
      render: (h) =>
        h.emails.length ? (
          <ul className="space-y-1 text-xs">
            {h.emails.map((e) => (
              <li key={e} className="break-all">
                <a href={`mailto:${e}`} className="text-[#12769F] hover:text-[#0E5C7C] hover:underline">
                  {e}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-black/46">—</span>
        ),
    },
    view === 'archived'
      ? {
          label: 'Archived',
          width: '8rem',
          render: (h) => (
            <span className="text-xs text-black/62">
              {new Date(h.archived_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
              {h.archived_by && <span className="block text-black/46">by {h.archived_by.split('@')[0]}</span>}
            </span>
          ),
        }
      : { label: 'Assigned To', width: '7rem', render: (h) => assigned(h.name) || <span className="text-black/46">Back-ups</span> },
    {
      label: 'Actions',
      width: '7rem',
      nowrap: true,
      render: (h) =>
        h.archived_at ? (
          <button type="button" onClick={() => restore(h)} disabled={restoring === h.agency_key} className={`${actionButton} text-[#3F6F2C] hover:bg-[#61A644]/10`}>
            {restoring === h.agency_key ? 'Restoring…' : '↺ Restore'}
          </button>
        ) : (
          <button type="button" onClick={() => setArchiving(h)} className={`${actionButton} text-black/62 hover:bg-[#1EA0DA]/8 hover:text-[#12769F]`}>
            <ArchiveIcon className="mr-1 inline h-3.5 w-3.5 -translate-y-px" />
            Archive
          </button>
        ),
    },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader
          title="Hospital List"
          subtitle="The hospitals we bid for on PhilGEPS and PS-PhilGEPS, with their contact persons and e-mail addresses"
          actions={
            <button
              onClick={() => {
                setAdding(true);
                setAdded('');
              }}
              className={blueAction}
            >
              + Add Hospital
            </button>
          }
        />
        <KpiRow
          items={[
            { label: 'Active tender', value: hospitals ? byStatus('active').length : '—', tone: 'green', note: 'hospitals we bid for' },
            { label: 'RFQ', value: hospitals ? byStatus('rfq').length : '—', tone: 'blue', note: 'requests for quotation' },
            { label: 'Prospects', value: hospitals ? byStatus('prospect').length : '—', note: 'not bidding yet' },
            { label: 'No e-mail yet', value: hospitals ? noEmail : '—', tone: 'docs', note: 'active or RFQ, no address' },
          ]}
        />

        {error && <p className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">{error}</p>}
        {added && <p className="rounded-[14px] border border-[#61A644]/30 bg-[#61A644]/8 px-4 py-3 text-sm text-[#2F5321]">{added}</p>}
        {adding && (
          <AddHospital
            hospitals={all}
            onCancel={() => setAdding(false)}
            onAdded={(hospital) => {
              setAdding(false);
              setAdded(`${hospital.name} was added to the list.`);
              setView(hospital.status);
              load();
            }}
          />
        )}
        {archiving && (
          <ArchiveHospital
            hospital={archiving}
            onCancel={() => setArchiving(null)}
            onArchive={async () => {
              await setArchived(archiving, true);
              setArchiving(null);
            }}
          />
        )}

        <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 sm:flex-row sm:items-center">
          <SegmentedTabs
            label="Show"
            value={view}
            onChange={(next) => {
              setView(next);
              setPage(1);
            }}
            options={[
              ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.tab, count: byStatus(value).length })),
              { value: 'archived', label: 'Archived', count: archived.length },
            ]}
          />
          <input
            type="text"
            placeholder="Search by hospital, contact person, number or e-mail..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
          />
        </div>

        {!hospitals ? (
          <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the hospital list...'}</p>
        ) : rows.length ? (
          <>
            <ResponsiveTable columns={columns} rows={pageRows} rowKey={(h) => h.agency_key} />
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
          <p className="py-12 text-center text-black/46">
            {query ? 'No hospital matches the search.' : view === 'archived' ? 'Nothing is archived.' : 'No hospitals here yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

function ArchiveIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </svg>
  );
}

const cancelButton = 'rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60';
const saveButton = 'rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60';

function ArchiveHospital({ hospital, onCancel, onArchive }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const archive = async () => {
    setSaving(true);
    setError('');
    try {
      await onArchive();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Archive hospital?"
      subtitle="It stays on the list under Archived and can be restored any time."
      busy={saving}
      onClose={onCancel}
      icon={<ArchiveIcon className="h-5 w-5" />}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="button" onClick={archive} disabled={saving} className={saveButton}>
            {saving ? 'Archiving…' : 'Archive'}
          </button>
        </>
      }
    >
      <section className="rounded-[14px] border border-[#E2E8F0] p-4">
        <p className="text-base font-semibold text-black">{hospital.name}</p>
        <p className="mt-1 text-xs text-black/62">
          {STATUS[hospital.status].label}
          {hospital.contacts.length > 0 && ` · ${hospital.contacts.length} contact${hospital.contacts.length > 1 ? 's' : ''}`}
          {hospital.emails.length > 0 && ` · ${hospital.emails.join(', ')}`}
        </p>
      </section>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}

// The Add Hospital window: Hospital Name is required; one contact person, number and e-mail to start with.
function AddHospital({ hospitals, onCancel, onAdded }) {
  const [form, setForm] = useState({ name: '', status: 'active', contact_name: '', contact_phone: '', email: '', note: '' });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const duplicate = form.name.trim() && hospitals.find((h) => h.agency_key === agencyKey(form.name));
  const fields = [
    ['contact_name', 'Contact Person', "e.g. Ma'am Lou (BAC Sec)"],
    ['contact_phone', 'Contact Number', 'e.g. 0942 971 9227'],
    ['email', 'Hospital E-mail', 'e.g. bac@hospital.doh.gov.ph'],
    ['note', 'Note', 'e.g. Needs a product presentation first'],
  ];
  const input = (invalid) =>
    `mt-1.5 w-full rounded-full border bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:outline-none focus:ring-2 ${
      invalid ? 'border-[#B3312C] focus:ring-[#B3312C]/20' : 'border-[#CBD5E1] focus:border-[#1EA0DA] focus:ring-[#1EA0DA]/25'
    }`;

  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!form.name.trim() || duplicate) return;
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/hospitals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onAdded(data.hospital);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Hospital"
      subtitle="Add a hospital we bid for, with a contact person and e-mail."
      busy={saving}
      onClose={onCancel}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          <path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16M2 21h20M12 7v6M9 10h6" />
        </svg>
      }
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="add-hospital" disabled={saving || !!duplicate} className={saveButton}>
            {saving ? 'Adding…' : 'Add Hospital'}
          </button>
        </>
      }
    >
      <form id="add-hospital" onSubmit={save} noValidate className="space-y-3.5">
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wider text-black/62">
            Hospital Name <span className="text-[#B3312C]">*</span>
          </span>
          <input
            value={form.name}
            placeholder="e.g. Bicol Medical Center"
            maxLength={200}
            aria-invalid={tried && !form.name.trim()}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={input(tried && !form.name.trim())}
          />
          {tried && !form.name.trim() && <span className="mt-1 block px-4 text-xs text-[#B3312C]">Hospital Name is required.</span>}
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-black/62">Status</span>
          <SegmentedTabs label="Status" value={form.status} onChange={(status) => setForm({ ...form, status })} options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        </div>
        {fields.map(([key, label, placeholder]) => (
          <label key={key} className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-black/62">{label}</span>
            <input value={form[key]} placeholder={placeholder} maxLength={key === 'note' ? 500 : 200} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={input(false)} />
          </label>
        ))}
      </form>
      {duplicate && (
        <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">
          {duplicate.archived_at ? `${duplicate.name} is archived. Restore it from the Archived tab instead.` : `${duplicate.name} is already on the list.`}
        </p>
      )}
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}
