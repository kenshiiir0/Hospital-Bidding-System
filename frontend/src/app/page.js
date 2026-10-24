'use client';

import { useState, useEffect, useRef } from 'react';
import { CustomSelect, PublishedTag, DateRangeDropdown, MultiSelectDropdown, ProductChips as Products, SearchPill, SegmentedTabs } from '@/components/FilterControls';
import PageHeader, { KpiRow, blueAction, greenAction, pesoTotal, plainAction } from '@/components/PageHeader';
import { setNavCount } from '@/lib/navCounts';
import { downloadOpportunityWorkbook, philgepsTender } from '@/lib/opportunityWorkbook';
import AutoFetchBar from '@/components/AutoFetchBar';
import NumberCircle from '@/components/NumberCircle';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ResponsiveTable from '@/components/ResponsiveTable';
import ScrapeProgress from '@/components/ScrapeProgress';
import TenderDetails from '@/components/TenderDetails';
import TypeBadge from '@/components/TypeBadge';
import { philgepsType } from '@/lib/tenderType';
import { activeTenders } from '@/lib/activeProducts';
import { UNREAD_KINDS, needsManualCheck } from '@/lib/manualCheck';
import WorkingDots from '@/components/WorkingDots';
import { formatDate, formatDateTime, formatPeso, instantDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { authFetch } from '@/lib/authFetch';

const EXCLUDED_KEY = 'excludedProducts';
// Last list loaded from Supabase, shown at once on the next visit while the fresh copy loads
const BIDS_CACHE_KEY = 'bidsCache';
// How often the page asks the server about PhilGEPS fetches: often while one runs, less when idle
// (to notice the hourly automatic update starting), and how long a plain "complete" stays up
const FETCH_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;
const DONE_SHOWN_MS = 6000;
const RELOAD_DURING_SYNC_MS = 10000;

function readCachedBids() {
  try {
    const cached = JSON.parse(localStorage.getItem(BIDS_CACHE_KEY) || 'null');
    return Array.isArray(cached?.bids) ? cached : null;
  } catch {
    return null;
  }
}

// "10:32 AM" today, "Oct 20, 10:32 AM" on other days (browser local time)
function formatUpdatedAt(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}, ${time}`;
}

// Saved documents results shown on a row's circle outside a Sync (grey pick-up, red problems)
const SAVED_CIRCLE_STATES = new Set(['pick-up', 'closed', 'needs-payment', 'order-flow-changed', 'no-order-link', 'none-found']);

// Documents filter groups, by what the Sync found for the tender
const DOC_GROUPS = [
  { key: 'all', label: 'All' },
  { key: 'files', label: 'With documents' },
  { key: 'pickup', label: 'Pick-up only' },
  { key: 'none', label: 'No documents yet' },
  // Downloaded documents that couldn't be read (lib/manualCheck.js), also of tenders with no product found
  { key: 'check', label: 'Need manual check' },
];

const needsCheck = (bid) => needsManualCheck(bid.details?.documents_read);

function docGroupOf(bid) {
  if (bid.details?.documents?.length) return 'files';
  if (bid.details?.documents_status === 'pick-up') return 'pickup';
  return 'none';
}

function readStoredExcluded() {
  try {
    const stored = JSON.parse(localStorage.getItem(EXCLUDED_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

// Pieces of a list row, in the PS-PhilGEPS pages' style (PsListTable): plain table cells, green product
// pills, a documents count and an outlined "View details" button. The long tender title is in View details.



function DocumentCount({ bid }) {
  const d = bid.details || {};
  const n = d.documents?.length || 0;
  if (n)
    return (
      <span className="text-xs text-[#3F6F2C]">
        📎 {n} file{n > 1 ? 's' : ''}
        {needsCheck(bid) && <span className="block font-medium text-[#B3312C]">Check by hand</span>}
      </span>
    );
  if (d.documents_status === 'pick-up') return <span className="text-xs text-black/62">Pick-up only</span>;
  if (d.documents_status === 'closed') return <span className="text-xs text-black/46">Closed</span>;
  if (!d.documents_checked_at) return <span className="text-xs text-black/46">Not checked</span>;
  return <span className="text-xs text-[#B3312C]">None yet</span>;
}

// The reference number opens the notice on PhilGEPS, like the notice numbers on the PS-PhilGEPS pages
const PHILGEPS_LINK = /^https:\/\/notices\.philgeps\.gov\.ph\//;
function RefLink({ bid }) {
  if (!PHILGEPS_LINK.test(bid.detail_link || '')) return bid.ref_no;
  return (
    <a href={bid.detail_link} target="_blank" rel="noreferrer" className="text-[#12769F] hover:text-[#0E5C7C] underline-offset-2 hover:underline">
      {bid.ref_no}
    </a>
  );
}


function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/6 text-[#12769F]',
    error: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-3.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="rounded-[14px] border border-dashed border-[#CBD5E1] px-4 py-10 text-center text-sm text-black/62">
      {children}
    </div>
  );
}

// "Oct 24" (the year only when it isn't this year) and "Oct 27, 12:01 AM", for the stacked Dates column
function shortDay(value, thisYear) {
  const text = formatDate(value);
  return text && thisYear && text.endsWith(`, ${thisYear}`) ? text.slice(0, -6) : text;
}
function shortDayTime(value, thisYear) {
  const text = formatDateTime(value);
  return text && thisYear ? text.replace(`, ${thisYear} `, ', ') : text;
}

export default function Home() {
  const [bids, setBids] = useState([]);
  // Tenders with no product found whose documents couldn't be read: only under "Need manual check"
  const [checkBids, setCheckBids] = useState([]);
  const [loading, setLoading] = useState(true);
  // When the shown list was loaded from Supabase (null until the cache or the first load arrives), and whether a reload is running
  const [updatedAt, setUpdatedAt] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [search, setSearch] = useState('');
  // Latest PhilGEPS fetch from the server: { kind: 'auto' | 'sync', status, percent, stage, error, warning, queued }
  const [fetchJob, setFetchJob] = useState(null);
  // Sync states that exist only in this page: checking PhilGEPS before starting, PhilGEPS down, request failed
  const [localSync, setLocalSync] = useState(null);
  // startedAt of finished fetches that were closed, hid themselves, or had finished before this page opened
  const [dismissed, setDismissed] = useState([]);
  const wakePoll = useRef(null);
  const [scrapeError, setScrapeError] = useState('');
  const [products, setProducts] = useState([]);
  const [excluded, setExcluded] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [selectedBid, setSelectedBid] = useState(null);
  // Published-date range filter ("YYYY-MM-DD" from the date inputs; empty = no limit) and sort direction
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  // Documents filter: 'all' | 'files' (downloaded) | 'pickup' (pick-up only) | 'none' (no documents yet)
  const [docFilter, setDocFilter] = useState('all');
  // Tender type filter: '' = all, else a code from lib/tenderType.js (ITB, RFQ, RFP, Negotiated)
  const [typeFilter, setTypeFilter] = useState('');
  const [today, setToday] = useState(''); // "YYYY-MM-DD" in Philippine time, set after mount
  // Page of the list shown (1-based) and rows per page; any filter or sort change goes back to page 1
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Excluded products are remembered per browser
  const updateExcluded = (next) => {
    setPage(1);
    setExcluded(next);
    try {
      localStorage.setItem(EXCLUDED_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked (private window): the filter still works for this visit
    }
  };

  const toggleExcluded = (name) =>
    updateExcluded(excluded.includes(name) ? excluded.filter((n) => n !== name) : [...excluded, name]);

  // Reload from Supabase in the background: the current list stays on screen until the new one arrives
  const fetchBids = async () => {
    setReloading(true);
    await loadBids();
  };

  // Initial load uses this directly after showing the cached list.
  // Only tenders that ask for our products in our dosages (matched_molecules, lib/products.mjs).
  // Plus, for "Need manual check", the tenders with no product found whose documents couldn't be read.
  const loadBids = async () => {
    const [{ data, error }, unread] = await Promise.all([
      supabase.from('philgeps_opportunities').select('*').not('matched_molecules', 'eq', '{}').order('id', { ascending: false }),
      supabase
        .from('philgeps_opportunities')
        .select('*')
        .eq('matched_molecules', '{}')
        .or(UNREAD_KINDS.map((kind) => `details->documents_read.cs.[{"kind":"${kind}"}]`).join(','))
        .order('id', { ascending: false }),
    ]);

    if (error) {
      console.error('Error fetching bids:', error.message);
      setScrapeError(`Could not load tenders: ${error.message}`);
    } else {
      setBids(data || []);
      setUpdatedAt(Date.now());
    }
    if (unread.error) console.error('Error fetching tenders to check by hand:', unread.error.message);
    else setCheckBids(unread.data || []);
    setLoading(false);
    setReloading(false);
  };


  // Sync: log in to PhilGEPS and download the screened tenders' documents (the server checks PhilGEPS first
  // and starts nothing when it is down). Its progress then comes from the polling below.
  const triggerSync = async () => {
    setLocalSync({ status: 'checking' });
    try {
      const res = await authFetch('/api/scrape', { method: 'POST' });
      const result = await res.json();
      if (result.unavailable) {
        setLocalSync({ status: 'unavailable', error: result.error });
      } else if (result.requested) {
        // Asked from a dashboard without the scraper: the team computer starts it within a few seconds
        setLocalSync({ status: 'queued', stage: 'Sent to the team computer; starting in a few seconds', requestedAt: Date.now() });
        wakePoll.current?.();
      } else if (!result.ok) {
        setLocalSync({ status: 'failed', percent: 0, error: result.error || `Sync failed (${res.status})` });
      } else {
        if (result.job) setFetchJob(result.job);
        setLocalSync(null);
        wakePoll.current?.();
      }
    } catch (err) {
      setLocalSync({ status: 'failed', percent: 0, error: err.message });
    }
  };

  // What the ring (Sync) and the bottom bar (automatic update) show
  const jobRunning = fetchJob?.status === 'running';
  const jobShown = fetchJob && (jobRunning || (fetchJob.finishedAt && !dismissed.includes(fetchJob.startedAt)));
  const syncQueued = (fetchJob?.queued || []).includes('sync');
  const syncView =
    localSync ||
    (syncQueued ? { status: 'queued', stage: 'Starts when the automatic update finishes' } : null) ||
    (jobShown && fetchJob.kind === 'sync' ? fetchJob : null);
  const autoView = jobShown && fetchJob.kind === 'auto' ? fetchJob : null;
  // Each tender's state in the current/last Sync, for the rolling number circles
  const syncTenders = (fetchJob?.kind === 'sync' && fetchJob.tenders) || {};
  // A row's circle: live Sync state while a Sync runs, otherwise the tender's saved result. Tenders that
  // already have their files are not part of a Sync and stay plain green.
  const syncRunning = fetchJob?.kind === 'sync' && fetchJob.status === 'running';
  const circleState = (bid) => {
    if (bid.details?.documents?.length) return undefined;
    if (syncRunning) return syncTenders[bid.ref_no];
    const saved = bid.details?.documents_status;
    return SAVED_CIRCLE_STATES.has(saved) ? saved : undefined;
  };
  const syncPercent = (fetchJob?.kind === 'sync' && fetchJob.tenderPercent) || {};
  const syncErrors = (fetchJob?.kind === 'sync' && fetchJob.tenderErrors) || {};
  const syncing = ['checking', 'queued', 'running'].includes(syncView?.status);

  const dismissFetch = () => setDismissed((list) => [...list, fetchJob?.startedAt]);

  // A plain "complete" hides itself after a few seconds; a failure or warning stays until closed
  const finishedCleanly = fetchJob?.status === 'success' && !fetchJob.warning && fetchJob.kind !== 'sync';
  const finishedStartedAt = fetchJob?.startedAt;
  useEffect(() => {
    if (!finishedCleanly) return;
    const timer = setTimeout(() => setDismissed((list) => [...list, finishedStartedAt]), DONE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [finishedCleanly, finishedStartedAt]);

  // Today's Philippine date for the "added today" count, read in the browser and refreshed every minute
  // so it rolls over at midnight
  useEffect(() => {
    const update = () => setToday(instantDay(new Date().toISOString()));
    Promise.resolve().then(update);
    const timer = setInterval(update, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Sidebar badge: tenders asking for our products (still on the Product List)
  const ourCount = loading ? null : activeTenders(bids, products.length ? new Set(products) : null).length;
  useEffect(() => {
    if (ourCount != null) setNavCount('/', ourCount);
  }, [ourCount]);

  // Keep the cache in step with what is shown (including realtime inserts), once a real list has arrived
  useEffect(() => {
    if (updatedAt == null) return;
    try {
      localStorage.setItem(BIDS_CACHE_KEY, JSON.stringify({ savedAt: updatedAt, bids }));
    } catch {
      // Storage full or blocked: the next visit just waits for Supabase
    }
  }, [bids, updatedAt]);

  useEffect(() => {
    // Show the list saved on the last visit straight away, then load the fresh one
    Promise.resolve()
      .then(readCachedBids)
      .then((cached) => {
        if (cached) {
          setBids(cached.bids);
          setUpdatedAt(cached.savedAt);
          setLoading(false);
          setReloading(true);
        }
        return loadBids();
      });

    // Follow PhilGEPS fetches (automatic and Sync) while the page is open; reload the table when one ends
    let stopped = false;
    let runningSince = null;
    let finishedSeen = 0;
    let lastReload = 0;
    let first = true;
    (async () => {
      while (!stopped) {
        try {
          const res = await authFetch('/api/scrape');
          if (stopped) break;
          if (!res.ok) throw new Error(`status ${res.status}`);
          const job = await res.json();
          // A Sync sent to the team computer has started there (its clock may differ a little)
          if (job.kind === 'sync' && job.startedAt) {
            setLocalSync((prev) => (prev?.requestedAt && job.startedAt >= prev.requestedAt - 60000 ? null : prev));
          }
          // A fetch that had already finished when the page opened isn't news
          if (first && job.status !== 'running' && job.startedAt) setDismissed((list) => [...list, job.startedAt]);
          first = false;
          setFetchJob(job);
          const nowRunning = job.status === 'running' ? job.startedAt : null;
          if (runningSince && nowRunning !== runningSince) fetchBids();
          runningSince = nowRunning;
          // While a Sync runs, reload the list as tenders finish (at most every RELOAD_DURING_SYNC_MS)
          const finished = Object.values(job.tenders || {}).filter((s) => s !== 'waiting' && s !== 'working').length;
          if (nowRunning && finished > finishedSeen && Date.now() - lastReload > RELOAD_DURING_SYNC_MS) {
            finishedSeen = finished;
            lastReload = Date.now();
            fetchBids();
          }
        } catch {
          // Dev server busy or restarting: ask again
        }
        await new Promise((resolve) => {
          wakePoll.current = resolve;
          setTimeout(resolve, runningSince ? FETCH_POLL_MS : IDLE_POLL_MS);
        });
      }
    })();

    // All our products (molecules.json) for the exclusion filter, plus the saved exclusions
    authFetch('/api/products')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Error ${res.status}`))))
      .then((names) => {
        setProducts(names);
        setExcluded(readStoredExcluded());
      })
      .catch((err) => console.error('Error loading products:', err.message));

    // Listen for new inserts in philgeps_opportunities in real-time
    const channel = supabase
      .channel('philgeps_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'philgeps_opportunities' },
        (payload) => {
          // Ignore tenders that don't mention our products
          if (!(payload.new.matched_molecules || []).length) return;
          console.log('New hospital tender added:', payload.new);
          // Skip rows already loaded (e.g. by fetchBids after a manual scrape)
          setBids((prevBids) =>
            prevBids.some((bid) => bid.id === payload.new.id)
              ? prevBids
              : [payload.new, ...prevBids]
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'philgeps_opportunities' },
        (payload) => {
          // A Sync saving a tender's documents: swap in the new row so its circle and details update at once.
          // A tender that no longer asks for our products in our dosages (products.mjs) leaves the list, and one
          // that newly does (e.g. found in its documents) joins it. One with no product found but unreadable
          // documents goes to the "Need manual check" tenders.
          const ours = (payload.new.matched_molecules || []).length > 0;
          const place = (keep) => (prev) => {
            const listed = prev.some((bid) => bid.id === payload.new.id);
            if (!keep) return listed ? prev.filter((bid) => bid.id !== payload.new.id) : prev;
            return listed ? prev.map((bid) => (bid.id === payload.new.id ? payload.new : bid)) : [payload.new, ...prev];
          };
          setBids(place(ours));
          setCheckBids(place(!ours && needsCheck(payload.new)));
        }
      )
      .subscribe();

    return () => {
      stopped = true;
      wakePoll.current?.();
      supabase.removeChannel(channel);
    };
  }, []);

  // Only molecules still on the Product List (an archived one shows nowhere, before the stored matches catch up)
  const ourBids = activeTenders(bids, products.length ? new Set(products) : null);
  // Drop every tender that requests an excluded product
  const visibleBids = ourBids.filter(
    (bid) => !(bid.matched_molecules || []).some((name) => excluded.includes(name))
  );

  // Distinct products of ours requested across the listed tenders
  const productCount = new Set(visibleBids.flatMap((bid) => bid.matched_molecules || [])).size;

  // Listed tenders first saved to the database today (Philippine date of created_at).
  // `today` comes from state set in the browser (see the effect above): reading the clock while
  // rendering would freeze the prerender's date into the page.
  const addedToday = today ? visibleBids.filter((bid) => instantDay(bid.created_at) === today).length : 0;

  // How many loaded tenders request each product, shown next to it in the filter
  const tendersPerProduct = {};
  for (const bid of ourBids) {
    for (const name of bid.matched_molecules || []) tendersPerProduct[name] = (tendersPerProduct[name] || 0) + 1;
  }

  // Search the reference number, tender title, procuring entity (hospital) and matched products,
  // keep the published-date range, then order by published date (latest first unless reversed)
  const query = search.toLowerCase();
  const matchesSearchAndDates = (bid) => {
    const published = bid.publish_date || '';
    return (
      `${bid.ref_no || ''} ${bid.title || ''} ${bid.procuring_entity || ''} ${(bid.matched_molecules || []).join(' ')}`.toLowerCase().includes(query) &&
      (!dateFrom || published >= dateFrom) &&
      (!dateTo || (published && published <= dateTo))
    );
  };
  // "Need manual check" also lists the tenders with no product found (checkBids)
  const matchingBids = (docFilter === 'check' ? [...visibleBids, ...checkBids] : visibleBids).filter(matchesSearchAndDates);
  // Type filter (ITB, RFQ...): options are the types in the searched list, most common first, with counts
  const typeOf = (bid) => philgepsType(bid.details?.notice_type).code;
  const typeCounts = {};
  for (const bid of matchingBids) if (typeOf(bid)) typeCounts[typeOf(bid)] = (typeCounts[typeOf(bid)] || 0) + 1;
  const typeOptions = Object.keys(typeCounts)
    .sort((a, b) => typeCounts[b] - typeCounts[a])
    .map((code) => ({ value: code, label: code, count: typeCounts[code] }));
  const ofType = (bid) => !typeFilter || typeOf(bid) === typeFilter;
  const searchedBids = matchingBids.filter(ofType);
  // Counts for the documents filter follow the search, date and type filters
  const ourSearched = visibleBids.filter((bid) => matchesSearchAndDates(bid) && ofType(bid));
  const docCounts = { all: ourSearched.length, files: 0, pickup: 0, none: 0 };
  for (const bid of ourSearched) docCounts[docGroupOf(bid)]++;
  docCounts.check = [...ourSearched, ...checkBids.filter((bid) => matchesSearchAndDates(bid) && ofType(bid))].filter(needsCheck).length;
  const filteredBids = searchedBids
    .filter((bid) => docFilter === 'all' || (docFilter === 'check' ? needsCheck(bid) : docGroupOf(bid) === docFilter))
    .sort((a, b) => {
      const byDate = (a.publish_date || '').localeCompare(b.publish_date || '') || (a.ref_no || '').localeCompare(b.ref_no || '');
      return oldestFirst ? byDate : -byDate;
    });


  // Header and summary cards: what is listed now (after the tabs, search and filters)
  const listedProducts = new Set(filteredBids.flatMap((bid) => bid.matched_molecules || [])).size;
  const listedAbc = filteredBids.reduce((sum, bid) => sum + (Number(bid.abc_amount) || 0), 0);
  const thisYear = today.slice(0, 4);
  const status = scrapeError
    ? { tone: 'error', text: 'Could not load' }
    : syncing
      ? { tone: 'busy', text: syncView?.status === 'running' ? `Syncing ${syncView.percent || 0}%` : 'Sync starting' }
      : loading || reloading
        ? { tone: 'busy', text: loading ? 'Loading…' : 'Updating…' }
        : { tone: 'ok', text: `Connected · Updated ${updatedAt ? formatUpdatedAt(updatedAt) : ''}` };

  // Download the listed tenders (after tabs, search and filters) as the team's Opportunity sheet
  const exportListed = async () => {
    setExporting(true);
    try {
      await downloadOpportunityWorkbook(filteredBids.map(philgepsTender));
    } catch (err) {
      setScrapeError(`Export failed: ${err.message}`);
    }
    setExporting(false);
  };

  // Only the current page is drawn; the page is clamped in case the list shrank (realtime, reload)
  const totalPages = Math.max(1, Math.ceil(filteredBids.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageBids = filteredBids.slice(pageStart, pageStart + pageSize);

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Header: title + live status, actions (Sync last), then the summary cards */}
        <PageHeader
          title="PhilGEPS Procurement Radar"
          status={status}
          subtitle={<>notices.philgeps.gov.ph{addedToday > 0 && ` · ${addedToday} new today`}</>}
          actions={
            <>
              <button onClick={fetchBids} disabled={reloading} title="Reload the list from the database without contacting PhilGEPS" className={plainAction}>
                {reloading ? <>Reloading <WorkingDots /></> : '↻ Reload'}
              </button>
              <button onClick={exportListed} disabled={exporting || loading || !filteredBids.length} title="The listed tenders as the team's Opportunity sheet" className={greenAction}>
                {exporting ? <>Exporting <WorkingDots /></> : '↓ Export Excel'}
              </button>
              <button
                onClick={triggerSync}
                disabled={syncing}
                title="Log in to PhilGEPS and download the documents of the screened tenders (runs on the team computer). Public data updates by itself every hour, 6 AM to 5 PM."
                className={blueAction}
              >
                {syncView?.status === 'checking'
                  ? <>Checking PhilGEPS <WorkingDots /></>
                  : syncView?.status === 'queued'
                    ? <>Sync waiting <WorkingDots /></>
                    : syncing
                      ? <>Syncing {syncView.percent || 0}% <WorkingDots /></>
                      : '🔄 Sync PhilGEPS'}
              </button>
            </>
          }
        />

        {scrapeError && <Notice tone="error">{scrapeError}</Notice>}

        <KpiRow
          items={[
            { label: 'Total opportunities', value: filteredBids.length, note: `of ${visibleBids.length} asking for our products` },
            { label: 'Product matches', value: listedProducts, tone: 'green', note: `of our products requested (${productCount} in all)` },
            { label: 'Total ABC value', value: pesoTotal(listedAbc), tone: 'blue', note: 'approved budgets of the listed tenders' },
          ]}
        />

        <section ref={listTop} className="scroll-mt-6 space-y-3">
          {/* Tier 1: which tenders, by their documents */}
          <SegmentedTabs
            label="Documents"
            value={docFilter}
            onChange={(key) => {
              setDocFilter(key);
              setPage(1);
            }}
            options={DOC_GROUPS.map(({ key, label }) => ({ value: key, label, count: docCounts[key] }))}
          />

          {/* Tier 2: search, then the dropdowns. Phones: an even two-column grid under a full-width search */}
          <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
            <SearchPill
              className="col-span-2"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
            <CustomSelect
              label="Type"
              className="w-full sm:w-auto"
              value={typeFilter}
              onChange={(value) => {
                setTypeFilter(value);
                setPage(1);
              }}
              options={[{ value: '', label: 'All' }, ...typeOptions]}
            />
            <MultiSelectDropdown
              label="Exclude products"
              className="w-full sm:w-auto"
              value={excluded}
              onChange={updateExcluded}
              hint="Checked products are left out: any tender asking for one of them is hidden."
              options={products.map((name) => ({ value: name, count: tendersPerProduct[name] || 0 }))}
            />
            <CustomSelect
              label="Sort"
              className="w-full sm:w-auto"
              value={oldestFirst ? 'oldest' : 'latest'}
              defaultValue="latest"
              onChange={(value) => {
                setOldestFirst(value === 'oldest');
                setPage(1);
              }}
              options={[
                { value: 'latest', label: 'Latest first' },
                { value: 'oldest', label: 'Oldest first' },
              ]}
            />
            <DateRangeDropdown
              className="w-full sm:w-auto"
              fields={[{ key: 'published', label: 'Published' }]}
              ranges={{ published: { from: dateFrom, to: dateTo } }}
              onChange={(_, { from, to }) => {
                setDateFrom(from);
                setDateTo(to);
                setPage(1);
              }}
            />
          </div>

          {excluded.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-black/62">Leaving out ({ourBids.length - visibleBids.length} tenders hidden):</span>
              {excluded.map((name) => (
                <button
                  key={name}
                  onClick={() => toggleExcluded(name)}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#1EA0DA]/8 text-[#12769F] border border-[#1EA0DA]/25 hover:bg-[#1EA0DA]/12 transition"
                  title={`Stop leaving out ${name}`}
                >
                  {name} <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          )}

          {/* The list: same table as the PS-PhilGEPS pages (PsListTable) */}
          {loading ? (
            <EmptyState>Loading opportunities…</EmptyState>
          ) : filteredBids.length === 0 ? (
            <EmptyState>Nothing to show.</EmptyState>
          ) : (
            <ResponsiveTable
              rows={pageBids}
              rowKey={(bid, index) => bid.id || index}
              onDetails={setSelectedBid}
              columns={[
                {
                  label: '#',
                  lead: true,
                  width: '3rem',
                  render: (bid, index) => (
                    <NumberCircle n={pageStart + index + 1} state={circleState(bid)} percent={syncPercent[bid.ref_no]} error={syncErrors[bid.ref_no]} hasDocs={bid.details?.documents?.length > 0} />
                  ),
                },
                {
                  label: 'Ref No. & Type',
                  title: true,
                  width: '8.5rem',
                  render: (bid) => (
                    <div className="space-y-1">
                      <div className="font-semibold"><RefLink bid={bid} /></div>
                      <TypeBadge type={philgepsType(bid.details?.notice_type, bid.details?.procurement_mode)} />
                      <div className="font-normal"><DocumentCount bid={bid} /></div>
                    </div>
                  ),
                },
                {
                  label: 'Procuring Agency',
                  wide: true,
                  render: (bid) => (
                    <span className="line-clamp-2 text-xs font-bold leading-tight text-black" title={bid.procuring_entity || bid.title}>
                      {bid.procuring_entity || bid.title}
                    </span>
                  ),
                },
                {
                  label: 'Approved Budget (ABC)',
                  width: '9rem',
                  align: 'right',
                  nowrap: true,
                  render: (bid) => <span className="font-mono text-xs font-bold text-black">{bid.abc_amount ? formatPeso(bid.abc_amount) : '—'}</span>,
                },
                {
                  label: 'Dates',
                  width: '10rem',
                  render: (bid) => (
                    <div className="space-y-1 text-xs">
                      <PublishedTag text={shortDay(bid.publish_date, thisYear)} />
                      <div><span className="text-black/46">Close:</span> <span className="font-medium">{shortDayTime(bid.closing_date, thisYear) || '—'}</span></div>
                    </div>
                  ),
                },
                { label: 'Matched Molecules', wide: true, render: (bid) => <Products names={bid.matched_molecules} /> },
              ]}
            />
          )}

          {!loading && filteredBids.length > 0 && (
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              total={filteredBids.length}
              onPageChange={goToPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}
        </section>
      </div>

      {selectedBid && (
        // The freshest copy of the open tender (the list reloads while a Sync saves each result)
        <TenderDetails bid={[...ourBids, ...checkBids].find((b) => b.id === selectedBid.id) || selectedBid} onClose={() => setSelectedBid(null)} />
      )}
      <ScrapeProgress job={syncView} raised={Boolean(autoView)} onDismiss={() => (localSync ? setLocalSync(null) : dismissFetch())} />
      <AutoFetchBar job={autoView} onDismiss={dismissFetch} />
    </div>
  );
}
