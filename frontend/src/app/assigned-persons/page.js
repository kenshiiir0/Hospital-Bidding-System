'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fromRows, makeRouter } from '@/lib/awardRouting.mjs';
import { authFetch } from '@/lib/authFetch';
import { useScreened } from '@/lib/screened';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';
import PageHeader, { blueAction, plainAction } from '@/components/PageHeader';
import { CustomSelect, SearchPill, SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';

// Who handles each hospital on the "2MG Incorporated served list of hospitals" (tables assigned_people and
// assigned_hospitals, /api/assigned-persons). The award notice emails go by the same tables (lib/awardRouting.mjs
// loadRouting), so an edit here changes who is emailed from the next Sync on. The back-ups are copied on every email
// and take any hospital not on the list. Screened: tenders on Screened Tenders (PhilGEPS and PS-PhilGEPS) whose
// agency is that hospital.

const initials = (name) =>
  name
    .split(' ')
    .filter((w) => /^[A-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
const firstName = (p) => p?.name.split(' ')[0] || '—';

export default function AssignedPersonsPage() {
  const screened = useScreened();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [person, setPerson] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  // { kind: 'hospital' | 'person', item?: the one being edited }
  const [editing, setEditing] = useState(null);
  const listTop = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/assigned-persons');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setList(data);
      setError('');
    } catch (e) {
      setError(`Could not load the assigned persons: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(load);
  }, [load]);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const peopleRows = list?.people || [];
  const PEOPLE = Object.fromEntries(peopleRows.map((p) => [p.key, p]));
  const backups = peopleRows.filter((p) => p.backup);
  const routeAward = list ? makeRouter(fromRows(list)) : null;

  // Screened tenders per hospital number, both portals; tenders from agencies not on the list go to the back-ups
  const perHospital = {};
  let unlisted = 0;
  for (const r of (routeAward && screened.rows) || []) {
    const { hospital } = routeAward(r.tender?.hospital || '');
    const counts = hospital ? (perHospital[hospital.no] ||= { philgeps: 0, ps: 0 }) : null;
    if (counts) counts[r.source === 'ps' ? 'ps' : 'philgeps']++;
    else unlisted++;
  }

  const hospitals = (list?.hospitals || []).map((h) => ({ ...h, aliases: h.aliases || [], screened: perHospital[h.no] || { philgeps: 0, ps: 0 } })).sort((a, b) => a.no - b.no);
  const representatives = peopleRows.filter((p) => hospitals.some((h) => h.rep === p.key));
  const query = search.trim().toLowerCase();
  const rows = hospitals.filter(
    (h) => (person === 'all' || h.rep === person) && (!query || `${h.no} ${h.name} ${h.aliases.join(' ')} ${PEOPLE[h.rep]?.name || ''}`.toLowerCase().includes(query)),
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const pick = (next) => {
    setPerson(next);
    setPage(1);
  };
  const open = (kind, item) => {
    setEditing({ kind, item });
    setNotice('');
  };
  const saved = (message) => {
    setEditing(null);
    setNotice(message);
    load();
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
      render: (h) =>
        PEOPLE[h.rep] ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={PEOPLE[h.rep].name} />
            <span className="min-w-0">
              <span className="block truncate text-black">{PEOPLE[h.rep].name}</span>
              <a href={`mailto:${PEOPLE[h.rep].email}`} className="block truncate text-xs text-[#12769F] hover:text-[#0E5C7C]">
                {PEOPLE[h.rep].email}
              </a>
            </span>
          </span>
        ) : (
          <span className="text-xs text-black/46">Back-ups</span>
        ),
    },
    { label: 'Back-ups (Cc)', width: '11rem', optional: 1, render: () => backups.map(firstName).join(' · ') },
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
    {
      label: 'Actions',
      width: '6rem',
      nowrap: true,
      render: (h) => (
        <button
          type="button"
          onClick={() => open('hospital', h)}
          disabled={list?.setupNeeded}
          className="whitespace-nowrap rounded-lg px-3 py-1 text-xs font-semibold text-black/62 transition-all hover:bg-[#1EA0DA]/8 hover:text-[#12769F]"
        >
          <PencilIcon className="mr-1 inline h-3.5 w-3.5 -translate-y-px" />
          Edit
        </button>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader
          title="Assigned Persons"
          subtitle={`The representative for each hospital we serve, on PhilGEPS and PS-PhilGEPS · ${hospitals.length} hospitals. Award notices waiting for our answer are emailed to them.`}
          actions={
            <>
              <button type="button" onClick={() => open('person')} disabled={!list || list.setupNeeded} className={plainAction}>
                + Add Person
              </button>
              <button type="button" onClick={() => open('hospital')} disabled={!list || list.setupNeeded} className={blueAction}>
                + Add Hospital
              </button>
            </>
          }
        />

        {error && <p className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">{error}</p>}
        {list?.setupNeeded && (
          <p className="rounded-[14px] border border-[#E2E8F0] bg-[#1EA0DA]/[0.04] px-4 py-3 text-sm text-black/62">
            Editing is not switched on yet: the database tables for this page still need to be created (schema.sql). The list below is the current one and the award emails follow it.
          </p>
        )}
        {notice && <p className="rounded-[14px] border border-[#61A644]/30 bg-[#61A644]/8 px-4 py-3 text-sm text-[#2F5321]">{notice}</p>}

        {/* One card per person; a representative's card filters the list to their hospitals; ✎ edits the person */}
        <section aria-label="People" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {peopleRows.map((p) => {
            const count = hospitals.filter((h) => h.rep === p.key).length;
            const on = person === p.key;
            const body = (
              <>
                <Avatar name={p.name} large />
                <span className="min-w-0 flex-1 pr-7 text-left">
                  <span className="block truncate text-[13px] font-medium text-black">{p.name}</span>
                  <span className="block truncate text-xs text-black/46">{p.email}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] font-medium">
                    {count > 0 && <span className="rounded-full bg-[#1EA0DA]/8 px-2 py-0.5 text-[#12769F]">{count} hospitals</span>}
                    {p.backup && <span className="rounded-full bg-[#61A644]/10 px-2 py-0.5 text-[#3F6F2C]">Back-up · Cc on all</span>}
                  </span>
                </span>
              </>
            );
            const box = `flex w-full min-w-0 items-start gap-3 rounded-[14px] border bg-white p-3 sm:p-4 transition ${on ? 'border-[#1EA0DA]/40 bg-[#1EA0DA]/6' : 'border-[#E2E8F0]'}`;
            return (
              <div key={p.key} className="relative min-w-0">
                {count ? (
                  <button type="button" aria-pressed={on} onClick={() => pick(on ? 'all' : p.key)} className={`${box} hover:border-[#1EA0DA]/40 hover:bg-[#1EA0DA]/6`}>
                    {body}
                  </button>
                ) : (
                  <div className={box}>{body}</div>
                )}
                <button
                  type="button"
                  onClick={() => open('person', p)}
                  disabled={list?.setupNeeded}
                  title={`Edit ${p.name}`}
                  aria-label={`Edit ${p.name}`}
                  className="absolute right-2 top-2 rounded-lg p-1.5 text-black/46 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F]"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </section>

        {list && (
          <p className="rounded-xl border border-[#E2E8F0] bg-[#1EA0DA]/[0.02] p-3.5 text-xs font-medium text-black/62">
            A hospital not on this list goes to the back-ups ({backups.map(firstName).join(' and ') || 'none set'})
            {unlisted ? ` · ${unlisted} screened tender${unlisted > 1 ? 's are' : ' is'} from such agencies` : ''}.
          </p>
        )}

        <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 lg:flex-row lg:items-center">
          <SegmentedTabs
            label="Assigned person"
            value={person}
            onChange={pick}
            options={[
              { value: 'all', label: 'All', count: hospitals.length },
              ...representatives.map((p) => ({ value: p.key, label: firstName(p), count: hospitals.filter((h) => h.rep === p.key).length })),
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

        {!list ? (
          <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the assigned persons...'}</p>
        ) : rows.length ? (
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

        {editing?.kind === 'hospital' && <HospitalForm hospital={editing.item} hospitals={hospitals} people={peopleRows} onCancel={() => setEditing(null)} onSaved={saved} />}
        {editing?.kind === 'person' && <PersonForm person={editing.item} hospitals={hospitals} onCancel={() => setEditing(null)} onSaved={saved} />}
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

function PencilIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" />
    </svg>
  );
}

const cancelButton = 'rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60';
const saveButton = 'rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60';
const removeButton = 'mr-auto rounded-lg px-3 py-2 text-xs font-semibold text-[#B3312C] transition hover:bg-[#B3312C]/8 disabled:opacity-60';
const inputClass = (invalid) =>
  `mt-1.5 w-full rounded-full border bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:outline-none focus:ring-2 ${
    invalid ? 'border-[#B3312C] focus:ring-[#B3312C]/20' : 'border-[#CBD5E1] focus:border-[#1EA0DA] focus:ring-[#1EA0DA]/25'
  }`;
const labelClass = 'text-xs font-semibold uppercase tracking-wider text-black/62';

// Sends one change to /api/assigned-persons; throws the API's message
async function send(method, body) {
  const res = await authFetch('/api/assigned-persons', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function Field({ label, required, error, children }) {
  return (
    <label className="block">
      <span className={labelClass}>
        {label} {required && <span className="text-[#B3312C]">*</span>}
      </span>
      {children}
      {error && <span className="mt-1 block px-4 text-xs text-[#B3312C]">{error}</span>}
    </label>
  );
}

// Add Hospital / Edit hospital: No., name, other spellings, Assigned Person; Remove sends its tenders to the back-ups
function HospitalForm({ hospital, hospitals, people, onCancel, onSaved }) {
  const editing = Boolean(hospital);
  const nextNo = Math.max(0, ...hospitals.map((h) => h.no)) + 1;
  const [form, setForm] = useState({
    no: String(hospital?.no ?? nextNo),
    name: hospital?.name || '',
    aliases: (hospital?.aliases || []).join(', '),
    rep: hospital?.rep || '',
  });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const no = Number(form.no);
  const sameNo = hospitals.find((h) => h.no === no && h.no !== hospital?.no);
  const problems = {
    no: !Number.isInteger(no) || no < 1 ? 'Enter a whole number.' : sameNo ? `No. ${no} is already ${sameNo.name}.` : '',
    name: form.name.trim() ? '' : 'Hospital name is required.',
    rep: form.rep ? '' : 'Choose who handles this hospital.',
  };

  const run = async (work) => {
    setSaving(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };
  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(problems).some(Boolean)) return;
    run(async () => {
      const body = { kind: 'hospital', ...form, no };
      if (editing) await send('PATCH', { ...body, original_no: hospital.no });
      else await send('POST', body);
      const who = people.find((p) => p.key === form.rep)?.name;
      onSaved(editing ? `#${no} ${form.name.trim()} was saved (assigned to ${who}).` : `#${no} ${form.name.trim()} was added, assigned to ${who}.`);
    });
  };
  const remove = () =>
    run(async () => {
      await send('DELETE', { kind: 'hospital', no: hospital.no });
      onSaved(`#${hospital.no} ${hospital.name} was removed from the list. Its award notices now go to the back-ups.`);
    });

  return (
    <Modal
      title={editing ? 'Edit Hospital' : 'Add Hospital'}
      subtitle={editing ? 'Change the hospital or who handles it. Award notice emails follow from the next Sync on.' : 'Add a hospital to the served list and choose who handles it.'}
      busy={saving}
      onClose={onCancel}
      icon={<PencilIcon className="h-5 w-5" />}
      footer={
        confirmRemove ? (
          <>
            <span className="mr-auto text-xs font-medium text-[#B3312C]">Remove {hospital.name}?</span>
            <button type="button" onClick={() => setConfirmRemove(false)} disabled={saving} className={cancelButton}>
              Keep
            </button>
            <button type="button" onClick={remove} disabled={saving} className="rounded-lg bg-[#B3312C] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#9A2925] disabled:opacity-60">
              {saving ? 'Removing…' : 'Remove'}
            </button>
          </>
        ) : (
          <>
            {editing && (
              <button type="button" onClick={() => setConfirmRemove(true)} disabled={saving} className={removeButton}>
                Remove
              </button>
            )}
            <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
              Cancel
            </button>
            <button type="submit" form="hospital-form" disabled={saving} className={saveButton}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Add Hospital'}
            </button>
          </>
        )
      }
    >
      <form id="hospital-form" onSubmit={save} noValidate className="space-y-3.5">
        <Field label="No. on the served list" required error={tried && problems.no}>
          <input value={form.no} inputMode="numeric" maxLength={4} aria-invalid={tried && !!problems.no} onChange={(e) => setForm({ ...form, no: e.target.value.replace(/\D/g, '') })} className={inputClass(tried && problems.no)} />
        </Field>
        <Field label="Hospital name" required error={tried && problems.name}>
          <input value={form.name} placeholder="e.g. Davao Regional Medical Center" maxLength={200} aria-invalid={tried && !!problems.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass(tried && problems.name)} />
        </Field>
        <Field label="Other spellings (optional)">
          <input value={form.aliases} placeholder="Separate with commas, e.g. DRMC, Davao Regional Hospital" maxLength={600} onChange={(e) => setForm({ ...form, aliases: e.target.value })} className={inputClass(false)} />
          <span className="mt-1 block px-4 text-xs text-black/46">How PhilGEPS or PS-PhilGEPS may write the agency name, so its tenders and awards are matched.</span>
        </Field>
        <div>
          <span className={labelClass}>
            Assigned Person <span className="text-[#B3312C]">*</span>
          </span>
          <div className="mt-1.5">
            <CustomSelect label="Assigned Person" showLabel={false} value={form.rep} onChange={(rep) => setForm({ ...form, rep })} options={[{ value: '', label: 'Choose a person' }, ...people.map((p) => ({ value: p.key, label: `${p.name} · ${p.email}` }))]} className="w-full" />
          </div>
          {tried && problems.rep && <span className="mt-1 block px-4 text-xs text-[#B3312C]">{problems.rep}</span>}
        </div>
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}

// Add Person / Edit person: name, e-mail, back-up; Remove only for someone with no hospitals
function PersonForm({ person, hospitals, onCancel, onSaved }) {
  const editing = Boolean(person);
  const [form, setForm] = useState({ name: person?.name || '', email: person?.email || '', backup: Boolean(person?.backup) });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const count = editing ? hospitals.filter((h) => h.rep === person.key).length : 0;
  const problems = {
    name: form.name.trim() ? '' : 'Name is required.',
    email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(form.email.trim()) ? '' : 'Enter a valid e-mail address.',
  };

  const run = async (work) => {
    setSaving(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };
  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(problems).some(Boolean)) return;
    run(async () => {
      if (editing) await send('PATCH', { kind: 'person', key: person.key, ...form });
      else await send('POST', { kind: 'person', ...form });
      onSaved(editing ? `${form.name.trim()} was saved.` : `${form.name.trim()} was added. Use Add Hospital or Edit to give them hospitals.`);
    });
  };
  const remove = () =>
    run(async () => {
      await send('DELETE', { kind: 'person', key: person.key });
      onSaved(`${person.name} was removed.`);
    });

  return (
    <Modal
      title={editing ? 'Edit Person' : 'Add Person'}
      subtitle={editing ? `${count} hospital${count === 1 ? '' : 's'} assigned. Award notice emails go to this address.` : 'A new assigned person. Give them hospitals with Add Hospital or Edit.'}
      busy={saving}
      onClose={onCancel}
      icon={<PencilIcon className="h-5 w-5" />}
      footer={
        <>
          {editing && count === 0 && (
            <button type="button" onClick={remove} disabled={saving} className={removeButton}>
              Remove
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="person-form" disabled={saving} className={saveButton}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Add Person'}
          </button>
        </>
      }
    >
      <form id="person-form" onSubmit={save} noValidate className="space-y-3.5">
        <Field label="Full name" required error={tried && problems.name}>
          <input value={form.name} placeholder="e.g. Maria Santos" maxLength={120} aria-invalid={tried && !!problems.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass(tried && problems.name)} />
        </Field>
        <Field label="E-mail" required error={tried && problems.email}>
          <input value={form.email} type="email" placeholder="e.g. gov6@getmeds.ph" maxLength={200} aria-invalid={tried && !!problems.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass(tried && problems.email)} />
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-[#E2E8F0] p-3.5">
          <input type="checkbox" checked={form.backup} onChange={(e) => setForm({ ...form, backup: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[#1EA0DA]" />
          <span className="text-sm text-black">
            Back-up
            <span className="block text-xs text-black/62">Copied on every award notice email, and gets the hospitals not on the list.</span>
          </span>
        </label>
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}
