'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ResponsiveTable from '@/components/ResponsiveTable';
import TenderDetails from '@/components/TenderDetails';
import { formatDate, formatInstant, instantDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { displayName } from '@/lib/username';

// One History page per site (app/history and app/history/ps-philgeps); the runs come from activity_log:
// 'scrape' = public PhilGEPS update (scraper.js), 'documents' = PhilGEPS Sync (philgepsSync.mjs),
// 'ps-sync' = PS-PhilGEPS Sync (psSync.mjs)
const SITES = {
  philgeps: { href: '/history', label: 'PhilGEPS', events: ['scrape', 'documents'], about: 'Every PhilGEPS update and Sync, and every tender the system has screened' },
  'ps-philgeps': { href: '/history/ps-philgeps', label: 'PS-PhilGEPS', events: ['ps-sync'], about: 'Every PS-PhilGEPS Sync' },
};
const EVENT_TITLES = { scrape: 'PhilGEPS update', documents: 'PhilGEPS Sync (documents)', 'ps-sync': 'PS-PhilGEPS Sync' };
const COUNT_LABELS = { downloaded: 'downloaded', 'pick-up': 'pick-up', 'no-documents': 'no documents', 'needs-payment': 'needs payment', failed: 'failed', 'not-reached': 'not reached', 'order-flow-changed': 'stopped (order page changed)' };

// Screened tenders are read in pages of this size (Supabase returns at most 1000 rows per request)
const PAGE_SIZE = 1000;
// Rows drawn at once in the Screened Tenders list; "Show more" adds this many
const SHOW_STEP = 200;
// Only the columns the list needs: items_text and details make the full rows large
const SCREENED_COLUMNS = 'id, ref_no, title, procuring_entity, publish_date, closing_date, matched_molecules, created_at';

const TRIGGER_LABELS = { dashboard: 'by Sync', schedule: 'by the automatic update', manual: 'manually' };

const CHIP_TONES = {
  plain: 'bg-white text-black/62 border-[#CBD5E1]',
  green: 'bg-[#61A644]/10 text-[#3F6F2C] border-[#61A644]/25',
  blue: 'bg-[#1EA0DA]/8 text-[#12769F] border-[#1EA0DA]/25',
};

function Chip({ tone = 'plain', children }) {
  return <span className={`px-2.5 py-0.5 rounded-full border ${CHIP_TONES[tone]}`}>{children}</span>;
}

function formatDuration(ms) {
  if (!ms) return null;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// activity_log does not exist until its part of schema.sql is run in Supabase
const isMissingTable = (error) => error?.code === 'PGRST205' || error?.code === '42P01' || /activity_log/.test(error?.message || '');

function MetricCard({ label, value, note, tone = 'text-black' }) {
  return (
    <div className="bg-white border border-[#E2E8F0] p-5 rounded-[14px] ">
      <span className="text-black/62 text-xs font-semibold uppercase tracking-wider">{label}</span>
      <div className={`text-2xl font-bold mt-2 ${tone}`}>{value}</div>
      {note && <div className="text-xs text-black/46 mt-1.5">{note}</div>}
    </div>
  );
}

function ProductChips({ names }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name) => (
        <span key={name} className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#61A644]/10 text-[#3F6F2C] border border-[#61A644]/25">
          {name}
        </span>
      ))}
    </div>
  );
}

// A tender named in a run's details; opens the full record in the side panel
function TenderLine({ tender, note, onOpen }) {
  return (
    <li>
      <button
        onClick={() => onOpen(tender.ref_no)}
        className="w-full text-left rounded-lg px-3 py-2 hover:bg-[#1EA0DA]/6 transition"
      >
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-black/62">{tender.ref_no}</span>
          <span className="text-sm text-black line-clamp-1">{tender.procuring_entity || tender.title}</span>
          {note && <span className="text-xs text-[#12769F]">{note}</span>}
        </div>
        {tender.matched_molecules?.length > 0 && (
          <div className="mt-1.5">
            <ProductChips names={tender.matched_molecules} />
          </div>
        )}
      </button>
    </li>
  );
}

function ActivityEntry({ entry, onOpen }) {
  const [open, setOpen] = useState(false);
  const failed = entry.status === 'failed';
  const details = entry.details || {};
  const newMatched = details.new_matched || [];
  const newSupplements = details.new_supplements || [];
  const hasMore = newMatched.length > 0 || newSupplements.length > 0;

  return (
    <li className="relative pl-8">
      {/* Timeline dot */}
      <span
        className={`absolute left-0 top-1.5 h-3 w-3 rounded-full ring-4 ring-white ${failed ? 'bg-[#B3312C]' : 'bg-[#61A644]'}`}
        aria-hidden
      />
      <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-black">
              {EVENT_TITLES[entry.event] || entry.event} {failed ? 'failed' : 'completed'}
              <span className="font-normal text-black/46">
                {' '}· started {details.started_by ? `by ${displayName(details.started_by)}` : TRIGGER_LABELS[entry.trigger] || entry.trigger || ''}
              </span>
            </div>
            <p className={`text-sm mt-1 ${failed ? 'text-[#B3312C] break-words' : 'text-black'}`}>{entry.summary}</p>
          </div>
          <div className="text-xs text-black/46 sm:text-right whitespace-nowrap">
            <div>{formatInstant(entry.created_at)}</div>
            {formatDuration(details.duration_ms) && <div>took {formatDuration(details.duration_ms)}</div>}
          </div>
        </div>

        {!failed && details.found != null && (
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <Chip>{details.found} screened</Chip>
            <Chip tone="green">{details.matched} matching</Chip>
            <Chip tone="blue">{details.new_tenders} new</Chip>
          </div>
        )}
        {entry.event === 'documents' && details.tenders > 0 && (
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <Chip>{details.tenders} tenders</Chip>
            <Chip tone="green">{details.files} new documents</Chip>
            {details.found_in_documents > 0 && <Chip tone="green">{details.found_in_documents} found only in the documents</Chip>}
            {Object.entries(details.counts || {}).map(([state, n]) => (
              <Chip key={state} tone="blue">{n} {COUNT_LABELS[state] || state}</Chip>
            ))}
          </div>
        )}
        {entry.event === 'ps-sync' && !failed && details.bid_matches != null && (
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <Chip>{details.bid_matches} bid matches</Chip>
            <Chip tone="green">{details.matching} with our products</Chip>
            {details.only_in_documents > 0 && <Chip tone="green">{details.only_in_documents} found only in the documents</Chip>}
            <Chip tone="blue">{details.files} documents</Chip>
            <Chip>{details.opportunities} opportunities</Chip>
            <Chip>{details.awards} award notices</Chip>
          </div>
        )}

        {hasMore && (
          <>
            <button
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="mt-3 text-xs font-semibold text-[#12769F] hover:text-[#0E5C7C] transition"
            >
              {open ? 'Hide changes ▴' : 'Show changes ▾'}
            </button>
            {open && (
              <div className="mt-3 space-y-4">
                {newMatched.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-black/46 mb-1">
                      New tenders that mention our products ({newMatched.length})
                    </div>
                    <ul className="divide-y divide-[#E2E8F0]">
                      {newMatched.map((t) => <TenderLine key={t.ref_no} tender={t} onOpen={onOpen} />)}
                    </ul>
                  </div>
                )}
                {newSupplements.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-black/46 mb-1">
                      New bid supplements ({newSupplements.length} tenders)
                    </div>
                    <ul className="divide-y divide-[#E2E8F0]">
                      {newSupplements.map((t) => (
                        <TenderLine key={t.ref_no} tender={t} note={`+${t.added} supplement${t.added > 1 ? 's' : ''}`} onOpen={onOpen} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export default function HistoryView({ site = 'philgeps' }) {
  const config = SITES[site];
  const isPhilgeps = site === 'philgeps';
  const [tab, setTab] = useState('activity');
  const [activity, setActivity] = useState([]);
  const [activityMissing, setActivityMissing] = useState(false);
  const [screened, setScreened] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  // 'all' | 'matched' | 'screened-out'
  const [resultFilter, setResultFilter] = useState('all');
  const [shown, setShown] = useState(SHOW_STEP);
  const [selectedBid, setSelectedBid] = useState(null);

  const loadActivity = async () => {
    const { data, error } = await supabase
      .from('activity_log')
      .select('*')
      .in('event', config.events)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      if (isMissingTable(error)) setActivityMissing(true);
      else setError(`Could not load activity: ${error.message}`);
      return;
    }
    setActivityMissing(false);
    setActivity(data || []);
  };

  // Every tender the scraper has stored, matching or not, newest first
  const loadScreened = async () => {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('philgeps_opportunities')
        .select(SCREENED_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        setError(`Could not load screened tenders: ${error.message}`);
        return;
      }
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    setScreened(rows);
  };

  const reload = async () => {
    setLoading(true);
    setError('');
    await Promise.all([loadActivity(), isPhilgeps && loadScreened()]);
    setLoading(false);
  };

  // The side panel needs the full row (item list, contact, supplements)
  const openTender = async (refNo) => {
    const { data, error } = await supabase.from('philgeps_opportunities').select('*').eq('ref_no', refNo).maybeSingle();
    if (error) setError(`Could not open ${refNo}: ${error.message}`);
    else if (data) setSelectedBid(data);
  };

  useEffect(() => {
    Promise.resolve().then(reload);

    // New runs appear without reloading the page
    const channel = supabase
      .channel(`activity_changes_${site}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) => {
        if (!config.events.includes(payload.new.event)) return;
        setActivity((prev) => (prev.some((e) => e.id === payload.new.id) ? prev : [payload.new, ...prev]));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // reload only reads state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const matchedCount = screened.filter((t) => (t.matched_molecules || []).length).length;
  const lastRun = activity[0];
  const lastSuccess = activity.find((e) => e.status === 'success');

  const query = search.toLowerCase();
  const filteredScreened = screened.filter((t) => {
    const isMatch = (t.matched_molecules || []).length > 0;
    if (resultFilter === 'matched' && !isMatch) return false;
    if (resultFilter === 'screened-out' && isMatch) return false;
    return `${t.ref_no || ''} ${t.title || ''} ${t.procuring_entity || ''} ${(t.matched_molecules || []).join(' ')}`
      .toLowerCase()
      .includes(query);
  });
  const visibleScreened = filteredScreened.slice(0, shown);

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#61A644]" aria-hidden />
              {config.label} History
            </h1>
            <p className="text-xs text-black/62 mt-1">{config.about}</p>
          </div>
          <div className="flex rounded-full border border-[#CBD5E1] bg-white p-1 text-sm sm:ml-auto">
            {Object.entries(SITES).map(([key, s]) => (
              <Link
                key={key}
                href={s.href}
                aria-current={key === site ? 'page' : undefined}
                className={`px-3 py-1.5 rounded-full transition ${key === site ? 'bg-[#1EA0DA] text-black' : 'text-black/62 hover:bg-[#1EA0DA]/6'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <button
            onClick={reload}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 bg-white hover:bg-[#1EA0DA]/6 text-[#12769F] border border-[#1EA0DA]/25 disabled:text-black/46 disabled:border-[#E2E8F0] disabled:cursor-wait px-4 py-2 rounded-full text-sm font-medium transition"
          >
            {loading ? '⏳ Loading...' : '↻ Reload'}
          </button>
        </header>

        {error && (
          <div className="bg-[#B3312C]/8 border border-[#B3312C]/25 text-[#B3312C] text-sm rounded-[14px] px-4 py-3">{error}</div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {isPhilgeps ? (
            <>
              <MetricCard label="Tenders Screened" value={screened.length} note="All Drugs & Medicines tenders read" />
              <MetricCard label="Mention Our Products" value={matchedCount} tone="text-[#3F6F2C]" note={`${screened.length - matchedCount} screened out`} />
            </>
          ) : (
            <>
              <MetricCard label="Bid Matches" value={lastSuccess?.details?.bid_matches ?? '—'} note="In the last successful Sync" />
              <MetricCard label="With Our Products" value={lastSuccess?.details?.matching ?? '—'} tone="text-[#3F6F2C]" note={lastSuccess ? `${lastSuccess.details?.files ?? 0} documents` : null} />
            </>
          )}
          <MetricCard
            label="Last Run"
            value={lastRun ? (lastRun.status === 'failed' ? 'Failed' : 'OK') : '—'}
            tone={lastRun?.status === 'failed' ? 'text-[#B3312C]' : 'text-[#12769F]'}
            note={lastRun ? formatInstant(lastRun.created_at) : 'No runs logged yet'}
          />
          <MetricCard
            label="Runs Logged"
            value={activity.length}
            note={lastSuccess ? `Last success ${formatInstant(lastSuccess.created_at)}` : null}
          />
        </section>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-[#E2E8F0]" role="tablist">
          {[
            ['activity', `Activity (${activity.length})`],
            ...(isPhilgeps ? [['screened', `Screened Tenders (${screened.length})`]] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition ${
                tab === key ? 'border-[#1EA0DA] text-[#12769F]' : 'border-transparent text-black/62 hover:text-black'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'activity' || !isPhilgeps ? (
          activityMissing ? (
            <div className="bg-[#1EA0DA]/8 border border-[#1EA0DA]/25 text-[#12769F] text-sm rounded-[14px] px-4 py-3">
              The activity log table is not set up yet. Run the <code className="font-mono">activity_log</code> part of{' '}
              <code className="font-mono">schema.sql</code> in the Supabase SQL editor; runs are recorded from then on.
            </div>
          ) : loading && activity.length === 0 ? (
            <p className="py-12 text-center text-black/46">Loading activity...</p>
          ) : activity.length === 0 ? (
            <p className="py-12 text-center text-black/46">
              No runs logged yet. The next {config.label} Sync or update will appear here.
            </p>
          ) : (
            <ol className="relative space-y-4 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-px before:bg-[#E2E8F0]">
              {activity.map((entry) => <ActivityEntry key={entry.id} entry={entry} onOpen={openTender} />)}
            </ol>
          )
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Search by reference no., tender title, hospital name or molecule..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setShown(SHOW_STEP);
                }}
                className="flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
              />
              <div className="flex rounded-full border border-[#CBD5E1] bg-white p-1 text-sm">
                {[
                  ['all', 'All'],
                  ['matched', 'Matching'],
                  ['screened-out', 'Screened out'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => {
                      setResultFilter(key);
                      setShown(SHOW_STEP);
                    }}
                    aria-pressed={resultFilter === key}
                    className={`px-3 py-1.5 rounded-full transition ${
                      resultFilter === key ? 'bg-[#1EA0DA] text-black' : 'text-black/62 hover:bg-[#1EA0DA]/6'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* One block per screened day; each is a table on wide screens and cards on narrow ones */}
            {loading && screened.length === 0 ? (
              <p className="rounded-[14px] border border-[#E2E8F0] py-12 text-center text-sm text-black/46">Loading screened tenders...</p>
            ) : visibleScreened.length === 0 ? (
              <p className="rounded-[14px] border border-[#E2E8F0] py-12 text-center text-sm text-black/46">No matching records found.</p>
            ) : (
              screenedDays(visibleScreened).map(({ day, tenders }) => (
                <section key={day} className="space-y-2">
                  <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-black/46">{formatDate(day) || 'Unknown date'}</h3>
                  <ResponsiveTable
                    rows={tenders}
                    rowKey={(t) => t.id}
                    onDetails={(t) => openTender(t.ref_no)}
                    columns={[
                      { label: 'Reference No.', title: true, nowrap: true, render: (t) => <span className="font-mono text-xs">{t.ref_no}</span> },
                      { label: 'First Screened', render: (t) => <span className="text-xs text-black/62">{formatInstant(t.created_at) || '—'}</span> },
                      { label: 'Hospital / Procuring Entity', wide: true, render: (t) => t.procuring_entity || t.title },
                      {
                        label: 'Result',
                        wide: true,
                        render: (t) =>
                          (t.matched_molecules || []).length ? (
                            <ProductChips names={t.matched_molecules} />
                          ) : (
                            <span className="text-xs text-black/46">Screened out</span>
                          ),
                      },
                      { label: 'Published', render: (t) => <span className="text-xs text-black/62">{formatDate(t.publish_date) || '—'}</span> },
                    ]}
                  />
                </section>
              ))
            )}

            {filteredScreened.length > shown && (
              <div className="text-center">
                <button
                  onClick={() => setShown(shown + SHOW_STEP)}
                  className="text-sm font-medium text-[#12769F] hover:text-[#0E5C7C] px-4 py-2 transition"
                >
                  Show more ({filteredScreened.length - shown} left)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedBid && <TenderDetails bid={selectedBid} onClose={() => setSelectedBid(null)} />}
    </div>
  );
}

// Screened tenders grouped by the (Philippine) day they were first screened, in list order
function screenedDays(tenders) {
  const days = [];
  for (const t of tenders) {
    const day = instantDay(t.created_at);
    if (days.at(-1)?.day !== day) days.push({ day, tenders: [] });
    days.at(-1).tenders.push(t);
  }
  return days;
}
