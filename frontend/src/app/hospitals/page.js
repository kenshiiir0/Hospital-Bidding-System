'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { agencyKey } from '@/lib/agencyKey';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';
import MessageHospitals from '@/components/MessageHospitals';
import ImportExcel from '@/components/ImportExcel';
import { HOSPITAL_SHEET, readHospitalSheet } from '@/lib/sheetImport.mjs';
import { CustomSelect, SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import PageHeader, { KpiRow, plainAction } from '@/components/PageHeader';

// The hospitals we bid for (table hospitals, /api/hospitals): the "Active Hospital" sheet of the WINNING BID TRACKER
// (tools/import-hospitals.mjs) plus Add Hospital. The same hospitals post tenders on PhilGEPS and PS-PhilGEPS.
const STATUS = {
  active: { label: 'Active tender', tab: 'Active', pill: 'bg-[#61A644]/10 text-[#3F6F2C]' },
  rfq: { label: 'RFQ', tab: 'RFQ', pill: 'bg-[#1EA0DA]/8 text-[#12769F]' },
  prospect: { label: 'Prospect', tab: 'Prospects', pill: 'bg-[#E2E8F0]/70 text-black/62' },
};

// Role / Department filter: matched on the contact's role and name (positions are often written in the name,
// e.g. "Ma'am Lou (BAC Sec)").
const ROLES = [
  { value: 'procurement', label: 'Procurement', test: /procure|\bbac\b|purchas|supply|bidding|canvass/i },
  { value: 'pharmacy', label: 'Pharmacy', test: /pharm/i },
  { value: 'mms', label: 'MMS', test: /\bmms\b|materials?\s+management/i },
];
const roleOf = (c) => `${c.role || ''} ${c.name || ''}`;
const matchesRole = (c, role) => {
  if (role === 'all') return true;
  if (role === 'other') return !ROLES.some((r) => r.test.test(roleOf(c)));
  return ROLES.find((r) => r.value === role)?.test.test(roleOf(c)) || false;
};

// Philippine mobile numbers (09xx xxx xxxx) are the WhatsApp numbers; landlines and local lines stay plain text.
const MOBILE = /(?<!\d)(?:\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
const whatsappLink = (mobile) => `https://wa.me/63${mobile.replace(/\D/g, '').replace(/^(63|0)/, '')}`;

function PhoneNumber({ value }) {
  const parts = [];
  let last = 0;
  for (const m of value.matchAll(MOBILE)) {
    if (m.index > last) parts.push(<span key={`t${m.index}`} className="text-black/62">{value.slice(last, m.index)}</span>);
    parts.push(
      <a key={m.index} href={whatsappLink(m[0])} target="_blank" rel="noreferrer" title="Chat on WhatsApp" className="font-medium text-[#3F6F2C] hover:text-[#2F5321] hover:underline">
        <WhatsAppIcon className="mr-1 inline h-3.5 w-3.5 -translate-y-px" />
        {m[0]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(<span key="rest" className="text-black/62">{value.slice(last)}</span>);
  return <>{parts}</>;
}

// A number or address with a Copy button that shows on hover (always on touch screens), and "Copied" for a moment
function Copyable({ value, label, children, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  return (
    <span className={`group/copy inline-flex max-w-full items-center gap-1 ${className}`}>
      <span className="min-w-0 truncate" title={value}>
        {children}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className={`relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-black/46 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30 [@media(hover:none)]:opacity-100 ${
          copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'
        }`}
      >
        {copied ? (
          <svg viewBox="0 0 20 20" fill="none" stroke="#61A644" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
            <path d="m4.5 10.5 3.5 3.5 7.5-8" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
            <rect x="7" y="7" width="10" height="10" rx="2" />
            <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          </svg>
        )}
        {copied && (
          <span role="status" className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-2 py-0.5 text-[11px] font-medium text-white">
            Copied
          </span>
        )}
      </button>
    </span>
  );
}

// The ••• menu of a row. Drawn fixed (not inside the table box, which clips), opens upward near the bottom of the screen.
function RowMenu({ label, items }) {
  const [pos, setPos] = useState(null);
  const button = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (menu.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setPos(null);
      if (e.type === 'keydown') button.current?.focus();
    };
    const closeNow = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', closeNow, true);
    window.addEventListener('resize', closeNow);
    menu.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', closeNow, true);
      window.removeEventListener('resize', closeNow);
    };
  }, [pos]);
  const toggle = () => {
    if (pos) return setPos(null);
    const r = button.current.getBoundingClientRect();
    const up = r.bottom + 150 > window.innerHeight;
    setPos({ right: window.innerWidth - r.right, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30 ${pos ? 'bg-[#1EA0DA]/8 text-[#12769F]' : ''}`}
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {pos && (
        <div ref={menu} role="menu" aria-label={`Actions for ${label}`} style={pos} className="fixed z-40 w-44 overflow-hidden rounded-xl border border-[#E2E8F0] bg-white py-1 text-left shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setPos(null);
                item.onClick();
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-black/85 transition hover:bg-[#1EA0DA]/6 hover:text-[#12769F] focus:bg-[#1EA0DA]/6 focus:outline-none"
            >
              <span className="text-black/46">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// "+N contacts": opens the View window with every contact and e-mail
function MorePill({ count, noun, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="View all"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#1EA0DA]/30 bg-[#1EA0DA]/6 px-2 py-0.5 text-[11px] font-medium text-[#12769F] transition hover:bg-[#1EA0DA]/12"
    >
      +{count} {noun}
      {count === 1 ? '' : 's'}
    </button>
  );
}

export default function HospitalsPage() {
  const [hospitals, setHospitals] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [messaging, setMessaging] = useState(null); // null | { only?: agency_key }
  const [editing, setEditing] = useState(null); // null | { hospital, focus?: 'email' }
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('all');
  const [added, setAdded] = useState('');
  const [view, setView] = useState('active'); // active | rfq | prospect | noemail | archived
  const [archiving, setArchiving] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [viewing, setViewing] = useState(null); // the hospital shown in the View window
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

  const changeView = (next) => {
    setView(next);
    setPage(1);
  };

  const all = hospitals || [];
  const listed = all.filter((h) => !h.archived_at);
  const archived = all.filter((h) => h.archived_at);
  const byStatus = (s) => listed.filter((h) => h.status === s);
  const noEmailList = listed.filter((h) => h.status !== 'prospect' && !h.emails.length);
  const shown = view === 'archived' ? archived : view === 'noemail' ? noEmailList : byStatus(view);
  const query = search.trim().toLowerCase();
  const text = (h) => `${h.name} ${h.list_note || ''} ${h.emails.join(' ')} ${h.contacts.map((c) => `${c.name || ''} ${c.role || ''} ${c.phone || ''}`).join(' ')}`.toLowerCase();
  const rows = shown.filter((h) => (!query || text(h).includes(query)) && (role === 'all' || h.contacts.some((c) => matchesRole(c, role))));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  // With a role picked, that role's contacts come first (the first one is shown in the row)
  const contactsOf = (h) => (role === 'all' ? h.contacts : [...h.contacts.filter((c) => matchesRole(c, role)), ...h.contacts.filter((c) => !matchesRole(c, role))]);

  const columns = [
    {
      label: 'Hospital',
      title: true,
      render: (h) => (
        <span className="block min-w-0">
          {/* Capitals as on the sheet; names saved from View details are in mixed case */}
          <span className="block truncate" title={h.name.toUpperCase()}>
            {h.name.toUpperCase()}
          </span>
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
      width: '9.5rem',
      render: (h) => (
        <span className="block min-w-0">
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS[h.status].pill}`}>{STATUS[h.status].label}</span>
          {h.list_note && (
            <span className="mt-1 block truncate text-xs text-black/62" title={h.list_note}>
              {h.list_note}
            </span>
          )}
        </span>
      ),
    },
    {
      label: 'Contact Person',
      render: (h) => {
        const [first] = contactsOf(h);
        if (!first) return <span className="text-black/46">—</span>;
        const more = h.contacts.length - 1;
        return (
          <span className="block min-w-0">
            <span className="block truncate text-[13px] font-semibold text-black" title={first.name || ''}>
              {first.name || '—'}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-2">
              {first.role && (
                <span className="min-w-0 truncate text-xs text-black/62" title={first.role}>
                  {first.role}
                </span>
              )}
              {more > 0 && <MorePill count={more} noun="contact" onClick={() => setViewing(h)} />}
            </span>
          </span>
        );
      },
    },
    {
      label: 'WhatsApp / Phone',
      width: '12rem',
      render: (h) => {
        const [first] = contactsOf(h);
        return first?.phone ? (
          <Copyable value={first.phone} label="number" className="text-xs tabular-nums">
            <PhoneNumber value={first.phone} />
          </Copyable>
        ) : (
          <span className="text-black/46">—</span>
        );
      },
    },
    {
      label: 'Email',
      render: (h) => {
        if (!h.emails.length) {
          return h.archived_at ? (
            <span className="text-black/46">—</span>
          ) : (
            <button type="button" onClick={() => setEditing({ hospital: h, focus: 'email' })} className="text-xs font-medium text-[#1EA0DA] hover:text-[#12769F] hover:underline">
              + Add email
            </button>
          );
        }
        const more = h.emails.length - 1;
        return (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <Copyable value={h.emails[0]} label="e-mail address" className="text-xs">
              <a href={`mailto:${h.emails[0]}`} className="text-[#12769F] hover:text-[#0E5C7C] hover:underline">
                {h.emails[0]}
              </a>
            </Copyable>
            {more > 0 && <MorePill count={more} noun="e-mail" onClick={() => setViewing(h)} />}
          </span>
        );
      },
    },
    ...(view === 'archived'
      ? [
          {
            label: 'Archived',
            width: '8rem',
            render: (h) => (
              <span className="text-xs text-black/62">
                {new Date(h.archived_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                {h.archived_by && <span className="block text-black/46">by {h.archived_by.split('@')[0]}</span>}
              </span>
            ),
          },
        ]
      : []),
    {
      label: view === 'archived' ? 'Actions' : '',
      width: view === 'archived' ? '7rem' : '3.75rem',
      nowrap: true,
      align: 'right',
      render: (h) => (
        <span className="inline-flex items-center justify-end gap-1">
          {h.archived_at ? (
            <button
              type="button"
              onClick={() => restore(h)}
              disabled={restoring === h.agency_key}
              className="whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold text-[#3F6F2C] transition hover:bg-[#61A644]/10 disabled:opacity-60"
            >
              {restoring === h.agency_key ? 'Restoring…' : '↺ Restore'}
            </button>
          ) : (
            <RowMenu
              label={h.name}
              items={[
                { label: 'View details', icon: <EyeIcon className="h-3.5 w-3.5" />, onClick: () => setViewing(h) },
                { label: 'Edit', icon: <PencilIcon className="h-3.5 w-3.5" />, onClick: () => setEditing({ hospital: h }) },
                { label: 'Message', icon: <MailIcon className="h-3.5 w-3.5" />, onClick: () => setMessaging({ only: h.agency_key }) },
                { label: 'Archive', icon: <ArchiveIcon className="h-3.5 w-3.5" />, onClick: () => setArchiving(h) },
              ]}
            />
          )}
        </span>
      ),
    },
  ];

  const kpi = (value, label, tone, note) => ({
    label,
    tone,
    note,
    value: hospitals ? (value === 'noemail' ? noEmailList.length : byStatus(value).length) : '—',
    active: view === value,
    onClick: () => changeView(view === value && value === 'noemail' ? 'active' : value),
  });

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader
          title="Hospital List"
          subtitle="The hospitals we bid for on PhilGEPS and PS-PhilGEPS, with their contact persons, WhatsApp numbers and e-mail addresses"
          actions={
            <>
              <ImportExcel
                sheet={HOSPITAL_SHEET}
                columns="HOSPITAL, STATUS, CONTACT NUMBER, CONTACT PERSON, HOSPITAL EMAIL ADDRESS"
                read={(wb) => {
                  const { sheet, hospitals: rows } = readHospitalSheet(wb);
                  return { sheet, rows };
                }}
                describe={(rows) => describeHospitalImport(rows, all)}
                endpoint="/api/hospitals"
                field="hospitals"
                disabled={!hospitals}
                onDone={(message) => {
                  setAdded(message);
                  load();
                }}
              />
              <button onClick={() => setMessaging({})} disabled={!hospitals} className={plainAction}>
                ✉ Message Hospitals
              </button>
              <button
                onClick={() => {
                  setAdding(true);
                  setAdded('');
                }}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#61A644] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#4F8F35] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#61A644]/40"
              >
                + Add Hospital
              </button>
            </>
          }
        />
        <KpiRow
          items={[
            kpi('active', 'Active tender', 'green', 'hospitals we bid for'),
            kpi('rfq', 'RFQ', 'blue', 'requests for quotation'),
            kpi('prospect', 'Prospects', undefined, 'not bidding yet'),
            kpi('noemail', 'No e-mail yet', 'docs', 'active or RFQ, no address'),
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
              changeView(hospital.status);
              load();
            }}
          />
        )}
        {editing && (
          <EditHospital
            hospital={editing.hospital}
            focus={editing.focus}
            onCancel={() => setEditing(null)}
            onSaved={(hospital) => {
              setEditing(null);
              setAdded(`${hospital.name} was saved.`);
              load();
            }}
          />
        )}
        {viewing && (
          <HospitalDetails
            hospital={viewing}
            onClose={() => setViewing(null)}
            onEdit={
              viewing.archived_at
                ? null
                : () => {
                    setEditing({ hospital: viewing });
                    setViewing(null);
                  }
            }
            onMessage={
              viewing.archived_at
                ? null
                : () => {
                    setMessaging({ only: viewing.agency_key });
                    setViewing(null);
                  }
            }
          />
        )}
        {messaging && <MessageHospitals hospitals={all} only={messaging.only} onClose={() => setMessaging(null)} />}
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

        <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 lg:flex-row lg:items-center">
          <SegmentedTabs
            label="Show"
            value={view}
            onChange={changeView}
            options={[
              ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.tab, count: byStatus(value).length })),
              { value: 'archived', label: 'Archived', count: archived.length },
            ]}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <CustomSelect
              label="Role"
              value={role}
              defaultValue="all"
              onChange={(next) => {
                setRole(next);
                setPage(1);
              }}
              options={[{ value: 'all', label: 'All roles' }, ...ROLES.map(({ value, label }) => ({ value, label })), { value: 'other', label: 'Other roles' }]}
              className="shrink-0"
            />
            <input
              type="text"
              placeholder="Search by hospital, contact person, number or e-mail..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full min-w-0 flex-1 rounded-full border border-[#CBD5E1] bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:border-[#1EA0DA] focus:outline-none focus:ring-2 focus:ring-[#1EA0DA]/25"
            />
          </div>
        </div>
        {view === 'noemail' && (
          <p className="-mt-2 text-xs text-black/62">
            Showing active and RFQ hospitals with no e-mail address ({noEmailList.length}).{' '}
            <button type="button" onClick={() => changeView('active')} className="font-medium text-[#1EA0DA] hover:text-[#12769F] hover:underline">
              Show all active
            </button>
          </p>
        )}

        {!hospitals ? (
          <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the hospital list...'}</p>
        ) : rows.length ? (
          <>
            <ResponsiveTable
              columns={columns}
              rows={pageRows}
              rowKey={(h) => h.agency_key}
              onRowClick={(h) => setViewing(h)}
            />
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
            {query || role !== 'all'
              ? 'No hospital matches the search or role.'
              : view === 'archived'
                ? 'Nothing is archived.'
                : view === 'noemail'
                  ? 'Every active and RFQ hospital has an e-mail address.'
                  : 'No hospitals here yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

function WhatsAppIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4l-4.5 1.1z" />
      <path d="M9 8.5c0 3.5 2.6 6.5 6.5 6.5l1-1.5-2-1-1 .8c-1.2-.5-2.3-1.6-2.8-2.8l.8-1-1-2L9 8.5z" />
    </svg>
  );
}

function EyeIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}


const shortDate = (v) => (v ? new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const SOURCES = { 'winning-bid-tracker': 'WINNING BID TRACKER sheet', 'excel-import': 'Import Excel', added: 'Add Hospital' };

// View: the whole record of one hospital — status, note, website, every e-mail and contact (name, role, number)
function HospitalDetails({ hospital: h, onClose, onEdit, onMessage }) {
  const heading = 'mb-2 text-[11px] font-semibold uppercase tracking-wider text-black/50';
  const from = [h.source && (SOURCES[h.source] || h.source), h.added_by && `by ${h.added_by.split('@')[0]}`, shortDate(h.created_at)].filter(Boolean).join(' · ');
  return (
    <Modal
      title={h.name.toUpperCase()}
      subtitle="Hospital details"
      onClose={onClose}
      width="sm:max-w-3xl"
      icon={<EyeIcon className="h-5 w-5" />}
      footer={
        <>
          <button type="button" onClick={onClose} className={cancelButton}>
            Close
          </button>
          {onMessage && (
            <button type="button" onClick={onMessage} className={cancelButton}>
              ✉ Message
            </button>
          )}
          {onEdit && (
            <button type="button" onClick={onEdit} className={saveButton}>
              Edit
            </button>
          )}
        </>
      }
    >
      <section className="grid grid-cols-1 gap-4 rounded-[14px] border border-[#E2E8F0] p-4 text-xs sm:grid-cols-2">
        <div>
          <p className={heading}>Status</p>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${STATUS[h.status].pill}`}>{STATUS[h.status].label}</span>
          {h.archived_at && (
            <span className="ml-2 text-black/62">
              Archived {shortDate(h.archived_at)}
              {h.archived_by && ` by ${h.archived_by.split('@')[0]}`}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className={heading}>Website</p>
          {h.website ? (
            <a href={h.website} target="_blank" rel="noreferrer" className="break-all text-[#12769F] hover:text-[#0E5C7C] hover:underline">
              {h.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
            </a>
          ) : (
            <span className="text-black/46">—</span>
          )}
        </div>
        <div className="sm:col-span-2">
          <p className={heading}>Note</p>
          <p className="whitespace-pre-wrap break-words text-black/85">{h.list_note || <span className="text-black/46">—</span>}</p>
        </div>
        {from && (
          <div className="sm:col-span-2">
            <p className={heading}>Added from</p>
            <p className="text-black/62">{from}</p>
          </div>
        )}
      </section>

      <section>
        <p className={heading}>E-mails ({h.emails.length})</p>
        {h.emails.length ? (
          <ul className="space-y-1.5 text-xs">
            {h.emails.map((e) => (
              <li key={e} className="min-w-0">
                <Copyable value={e} label="e-mail address">
                  <a href={`mailto:${e}`} className="text-[#12769F] hover:text-[#0E5C7C] hover:underline">
                    {e}
                  </a>
                </Copyable>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-black/46">No e-mail address yet.</p>
        )}
      </section>

      <section>
        <p className={heading}>Contacts ({h.contacts.length})</p>
        {h.contacts.length ? (
          <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white">
            <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b border-[#EEF1F5] bg-[#F8FAFC] px-3.5 py-2 text-[11px] font-medium text-black/50 sm:grid">
              <span>Name</span>
              <span>Role / Department</span>
              <span>WhatsApp / Phone</span>
            </div>
            <ul className="divide-y divide-[#EEF1F5]">
              {h.contacts.map((c, i) => (
                <li key={i} className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-3.5 py-2.5 text-xs sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                  <span className="break-words font-semibold text-black">{c.name || '—'}</span>
                  <span className="break-words text-black/62">{c.role || <span className="text-black/46">—</span>}</span>
                  <span className="min-w-0 tabular-nums">
                    {c.phone ? (
                      <Copyable value={c.phone} label="number">
                        <PhoneNumber value={c.phone} />
                      </Copyable>
                    ) : (
                      <span className="text-black/46">—</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-black/46">No contacts yet.</p>
        )}
      </section>
    </Modal>
  );
}

function PencilIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}

function MailIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5l8.5 6 8.5-6" />
    </svg>
  );
}

// ••• → Edit, or "+ Add email": status, note, e-mail addresses and contacts (PATCH /api/hospitals { agency_key, edit })
function EditHospital({ hospital, focus, onCancel, onSaved }) {
  const [status, setStatus] = useState(hospital.status);
  const [note, setNote] = useState(hospital.list_note || '');
  const [emails, setEmails] = useState(() => (hospital.emails.length ? [...hospital.emails] : ['']));
  const [contacts, setContacts] = useState(() => hospital.contacts.map((c) => ({ ...c })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstEmail = useRef(null);
  useEffect(() => {
    if (focus === 'email') firstEmail.current?.focus();
  }, [focus]);

  const field =
    'w-full min-w-0 rounded-full border border-[#CBD5E1] bg-white px-4 py-2 text-sm text-black placeholder:text-black/46 transition focus:border-[#1EA0DA] focus:outline-none focus:ring-2 focus:ring-[#1EA0DA]/25';
  const label = 'text-xs font-semibold uppercase tracking-wider text-black/62';
  const removeButton = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-black/46 transition hover:bg-[#B3312C]/8 hover:text-[#B3312C]';
  const addLink = 'mt-2 text-xs font-medium text-[#1EA0DA] hover:text-[#12769F] hover:underline';
  const setContact = (i, key, value) => setContacts(contacts.map((c, j) => (j === i ? { ...c, [key]: value } : c)));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const edit = {
        status,
        list_note: note,
        emails: emails.map((x) => x.trim()).filter(Boolean),
        contacts: contacts.filter((c) => (c.name || '').trim() || (c.phone || '').trim()),
      };
      const res = await authFetch('/api/hospitals', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agency_key: hospital.agency_key, edit }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onSaved(data.hospital);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={focus === 'email' ? 'Add e-mail' : 'Edit hospital'}
      subtitle={hospital.name.toUpperCase()}
      busy={saving}
      onClose={onCancel}
      width="sm:max-w-2xl"
      icon={<PencilIcon className="h-5 w-5" />}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="edit-hospital" disabled={saving} className={saveButton}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="edit-hospital" onSubmit={save} noValidate className="space-y-4">
        <div>
          <span className={`mb-1.5 block ${label}`}>Status</span>
          <SegmentedTabs label="Status" value={status} onChange={setStatus} options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        </div>
        <label className="block">
          <span className={label}>Note</span>
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Needs a product presentation first" className={`mt-1.5 ${field}`} />
        </label>
        <section>
          <span className={label}>Hospital e-mails</span>
          <ul className="mt-1.5 space-y-2">
            {emails.map((value, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  ref={i === 0 ? firstEmail : undefined}
                  type="email"
                  value={value}
                  maxLength={200}
                  onChange={(e) => setEmails(emails.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder="e.g. bac@hospital.doh.gov.ph"
                  aria-label={`E-mail ${i + 1}`}
                  className={field}
                />
                <button type="button" onClick={() => setEmails(emails.length > 1 ? emails.filter((_, j) => j !== i) : [''])} aria-label={`Remove e-mail ${i + 1}`} className={removeButton}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {emails.length < 10 && (
            <button type="button" onClick={() => setEmails([...emails, ''])} className={addLink}>
              + Add another e-mail
            </button>
          )}
        </section>
        <section>
          <span className={label}>Contacts</span>
          {contacts.length ? (
            <ul className="mt-1.5 space-y-2">
              {contacts.map((c, i) => (
                <li key={i} className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                    <input value={c.name || ''} maxLength={200} onChange={(e) => setContact(i, 'name', e.target.value)} placeholder="Name" aria-label={`Contact ${i + 1} name`} className={field} />
                    <input value={c.role || ''} maxLength={200} onChange={(e) => setContact(i, 'role', e.target.value)} placeholder="Role / Department" aria-label={`Contact ${i + 1} role`} className={field} />
                    <input value={c.phone || ''} maxLength={80} onChange={(e) => setContact(i, 'phone', e.target.value)} placeholder="WhatsApp / Phone" aria-label={`Contact ${i + 1} number`} className={field} />
                  </div>
                  <button type="button" onClick={() => setContacts(contacts.filter((_, j) => j !== i))} aria-label={`Remove contact ${i + 1}`} className={`${removeButton} mt-0.5`}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-xs text-black/46">No contacts yet.</p>
          )}
          <button type="button" onClick={() => setContacts([...contacts, { name: '', role: '', phone: '', source: 'added' }])} className={addLink}>
            + Add contact
          </button>
        </section>
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}

// What the Import Excel window says about the sheet: new hospitals, updated ones, and the status counts
function describeHospitalImport(rows, listed) {
  const have = new Set(listed.map((h) => h.agency_key));
  const fresh = rows.filter((h) => !have.has(agencyKey(h.name)));
  const count = (s) => rows.filter((h) => h.status === s).length;
  const names = (list) => list.slice(0, 6).map((h) => h.name).join(' · ') + (list.length > 6 ? ` · and ${list.length - 6} more` : '');
  return {
    headline: `${rows.length} hospitals: ${count('active')} active tender, ${count('rfq')} RFQ, ${count('prospect')} prospects`,
    lines: [
      fresh.length ? `New on the list (${fresh.length}): ${names(fresh)}` : 'No new hospitals.',
      `Already on the list (${rows.length - fresh.length}): status, note, contacts and e-mails updated from the sheet.`,
      `${rows.reduce((n, h) => n + h.contacts.length, 0)} contacts, ${rows.reduce((n, h) => n + h.emails.length, 0)} e-mail addresses.`,
      'Kept as they are: websites, contacts added on the dashboard, archived hospitals, and hospitals not on the sheet.',
    ],
  };
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
    ['contact_phone', 'WhatsApp / Contact Number', 'e.g. 0942 971 9227'],
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
