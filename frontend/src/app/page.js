'use client';

import { useState, useEffect, useRef } from 'react';
import { DateRangePill, DetailsButton, ProductChips as Products, SearchPill, SegmentedTabs } from '@/components/FilterControls';
import AutoFetchBar from '@/components/AutoFetchBar';
import NumberCircle from '@/components/NumberCircle';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ScrapeProgress from '@/components/ScrapeProgress';
import TenderDetails from '@/components/TenderDetails';
import TypeBadge from '@/components/TypeBadge';
import { philgepsType } from '@/lib/tenderType';
import WorkingDots from '@/components/WorkingDots';
import { formatDate, formatDateTime, formatPeso, instantDay } from '@/lib/format';
import { philgepsTender } from '@/lib/opportunityWorkbook';
import { useExportScope } from '@/lib/exportScope';
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
];

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
  if (n) return <span className="text-xs text-[#3F6F2C]">📎 {n} file{n > 1 ? 's' : ''}</span>;
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

const outlineButton =
  'inline-flex items-center justify-center gap-2 rounded-full border border-[#1EA0DA]/25 bg-white px-4 py-2 text-sm font-medium text-[#12769F] hover:bg-[#1EA0DA]/6 disabled:text-black/46 disabled:border-[#E2E8F0] disabled:cursor-not-allowed transition';
const fieldClass =
  'bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-full px-3 py-1.5 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25';

export default function Home() {
  const [bids, setBids] = useState([]);
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
  const [showExclusions, setShowExclusions] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [selectedBid, setSelectedBid] = useState(null);
  // Published-date range filter ("YYYY-MM-DD" from the date inputs; empty = no limit) and sort direction
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  // Documents filter: 'all' | 'files' (downloaded) | 'pickup' (pick-up only) | 'none' (no documents yet)
  const [docFilter, setDocFilter] = useState('all');
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
  // Only tenders that mention our products (matched by the scraper from molecules.json).
  const loadBids = async () => {
    const { data, error } = await supabase
      .from('philgeps_opportunities')
      .select('*')
      .not('matched_molecules', 'eq', '{}')
      .order('id', { ascending: false });

    if (error) {
      console.error('Error fetching bids:', error.message);
      setScrapeError(`Could not load tenders: ${error.message}`);
    } else {
      setBids(data || []);
      setUpdatedAt(Date.now());
    }
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
    fetch('/api/products')
      .then((res) => res.json())
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
          // A Sync saving a tender's documents: swap in the new row so its circle and details update at once
          setBids((prevBids) =>
            prevBids.some((bid) => bid.id === payload.new.id)
              ? prevBids.map((bid) => (bid.id === payload.new.id ? payload.new : bid))
              : prevBids
          );
        }
      )
      .subscribe();

    return () => {
      stopped = true;
      wakePoll.current?.();
      supabase.removeChannel(channel);
    };
  }, []);

  // Drop every tender that requests an excluded product
  const visibleBids = bids.filter(
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
  for (const bid of bids) {
    for (const name of bid.matched_molecules || []) tendersPerProduct[name] = (tendersPerProduct[name] || 0) + 1;
  }
  const productQuery = productSearch.toLowerCase();
  const listedProducts = products.filter((name) => name.toLowerCase().includes(productQuery));

  // Search the reference number, tender title, procuring entity (hospital) and matched products,
  // keep the published-date range, then order by published date (latest first unless reversed)
  const query = search.toLowerCase();
  const searchedBids = visibleBids
    .filter((bid) =>
      `${bid.ref_no || ''} ${bid.title || ''} ${bid.procuring_entity || ''} ${(bid.matched_molecules || []).join(' ')}`
        .toLowerCase()
        .includes(query)
    )
    .filter((bid) => {
      const published = bid.publish_date || '';
      return (!dateFrom || published >= dateFrom) && (!dateTo || (published && published <= dateTo));
    });
  // Counts for the documents filter follow the search and date filter
  const docCounts = { all: searchedBids.length, files: 0, pickup: 0, none: 0 };
  for (const bid of searchedBids) docCounts[docGroupOf(bid)]++;
  const filteredBids = searchedBids
    .filter((bid) => docFilter === 'all' || docGroupOf(bid) === docFilter)
    .sort((a, b) => {
      const byDate = (a.publish_date || '').localeCompare(b.publish_date || '') || (a.ref_no || '').localeCompare(b.ref_no || '');
      return oldestFirst ? byDate : -byDate;
    });

  // The sidebar's Export Excel uses this list (all filters applied) plus the PS-PhilGEPS tenders matching the
  // same search and published dates (lib/exportScope.js, lib/unifiedExport.js)
  useExportScope('philgeps', () => ({
    from: 'philgeps',
    getShown: () => filteredBids.map(philgepsTender),
    search,
    publishedFrom: dateFrom,
    publishedTo: dateTo,
    summary: `${filteredBids.length} PhilGEPS listed here${search ? ` · search "${search}"` : ''}${dateFrom || dateTo ? ` · published ${dateFrom || '…'} to ${dateTo || '…'}` : ''}`,
  }));

  // Only the current page is drawn; the page is clamped in case the list shrank (realtime, reload)
  const totalPages = Math.max(1, Math.ceil(filteredBids.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageBids = filteredBids.slice(pageStart, pageStart + pageSize);

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Header, as on the PS-PhilGEPS pages: title, one status line, actions with Sync last */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#1EA0DA]" aria-hidden />
              PhilGEPS
            </h1>
            <p className="text-xs text-black/62 mt-1">
              notices.philgeps.gov.ph · {reloading ? 'Updating…' : updatedAt ? `Updated ${formatUpdatedAt(updatedAt)}` : 'Loading…'}
              {addedToday > 0 && ` · ${addedToday} new today`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={fetchBids} disabled={reloading} title="Reload the list from the database without contacting PhilGEPS" className={outlineButton}>
              {reloading ? <>Reloading <WorkingDots /></> : '↻ Reload'}
            </button>
            <button
              onClick={triggerSync}
              disabled={syncing}
              title="Log in to PhilGEPS and download the documents of the screened tenders (runs on the team computer). Public data updates by itself every hour, 6 AM to 5 PM."
              className="inline-flex items-center justify-center gap-2 bg-[#1EA0DA] hover:bg-[#1790C5] disabled:opacity-70 disabled:cursor-wait text-white px-4 py-2.5 rounded-lg text-xs font-semibold transition"
            >
              {syncView?.status === 'checking'
                ? <>Checking PhilGEPS <WorkingDots /></>
                : syncView?.status === 'queued'
                  ? <>Sync waiting <WorkingDots /></>
                  : syncing
                    ? <>Syncing {syncView.percent || 0}% <WorkingDots /></>
                    : '🔄 Sync PhilGEPS'}
            </button>
          </div>
        </header>

        {scrapeError && <Notice tone="error">{scrapeError}</Notice>}

        <section ref={listTop} className="scroll-mt-6 space-y-4">
          {/* Section heading with the documents filter, like "Bid Match · n of m mention our products" */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">
              Opportunities{' '}
              <span className="text-sm font-normal text-black/62">
                · {visibleBids.length} mention our products · {productCount} of our products requested
              </span>
            </h2>
            <SegmentedTabs
              label="Documents"
              value={docFilter}
              onChange={(key) => {
                setDocFilter(key);
                setPage(1);
              }}
              options={DOC_GROUPS.map(({ key, label }) => ({ value: key, label, count: docCounts[key] }))}
            />
          </div>

          {/* Search, products to leave out, published dates and order */}
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <SearchPill
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
            <button
              onClick={() => setShowExclusions(!showExclusions)}
              aria-expanded={showExclusions}
              className={`rounded-full px-3.5 py-1.5 border text-xs font-medium transition ${
                excluded.length ? 'bg-[#1EA0DA]/5 border-[#1EA0DA] text-[#12769F] ring-2 ring-[#1EA0DA]/20' : 'bg-white border-[#CBD5E1] text-black hover:border-[#1EA0DA]'
              }`}
            >
              Exclude products{excluded.length ? ` (${excluded.length})` : ''} {showExclusions ? '▴' : '▾'}
            </button>
            <DateRangePill
              label="Published"
              from={dateFrom}
              to={dateTo}
              onFrom={(value) => {
                setDateFrom(value);
                setPage(1);
              }}
              onTo={(value) => {
                setDateTo(value);
                setPage(1);
              }}
            />
            <button
              onClick={() => {
                setOldestFirst(!oldestFirst);
                setPage(1);
              }}
              title="Reverse the order of the list"
              className="rounded-full px-3.5 py-1.5 border border-[#CBD5E1] bg-white text-xs font-medium text-black hover:border-[#1EA0DA] transition"
            >
              ⇅ {oldestFirst ? 'Oldest first' : 'Latest first'}
            </button>
          </div>

          {/* Products to leave out */}
          {showExclusions && (
            <div className="rounded-[14px] border border-[#E2E8F0] p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Search products…"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  className={`${fieldClass} flex-1 min-w-[12rem]`}
                />
                <button
                  onClick={() => updateExcluded([])}
                  disabled={!excluded.length}
                  className="text-sm text-[#12769F] hover:text-[#0E5C7C] disabled:text-black/36 disabled:cursor-not-allowed px-2 py-1.5 transition"
                >
                  Clear exclusions
                </button>
              </div>
              <p className="text-xs text-black/46">Checked products are left out: any tender that requests one of them is removed from the list.</p>
              {listedProducts.length === 0 ? (
                <p className="text-sm text-black/46 py-4 text-center">No products match &quot;{productSearch}&quot;.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 max-h-72 overflow-y-auto pr-1">
                  {listedProducts.map((name) => (
                    <label key={name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-black hover:bg-[#1EA0DA]/6 cursor-pointer select-none">
                      <input type="checkbox" checked={excluded.includes(name)} onChange={() => toggleExcluded(name)} className="h-4 w-4 accent-[#1EA0DA]" />
                      <span className="flex-1 truncate">{name}</span>
                      <span className="text-xs text-black/46 tabular-nums">{tendersPerProduct[name] || 0}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {excluded.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-black/62">Leaving out ({bids.length - visibleBids.length} tenders hidden):</span>
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
            <div className="bg-white rounded-[14px] border border-[#E2E8F0] overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#1EA0DA]/5 text-left text-xs font-semibold uppercase tracking-wide text-black/62">
                  <tr>
                    {['#', 'Reference Number', 'Type', 'Agency name', 'Approved Budget', 'Publish Date', 'Closing Date', 'Our products', 'Remarks'].map((h) => (
                      <th key={h} className="px-3 py-2.5 font-semibold whitespace-nowrap">{h}</th>
                    ))}
                    <th className="px-3 py-2.5" aria-label="Details" />
                  </tr>
                </thead>
                <tbody>
                  {pageBids.map((bid, index) => (
                    <tr key={bid.id || index} className="border-t border-[#E2E8F0] align-top bg-white hover:bg-[#1EA0DA]/6 transition-colors">
                      <td className="px-3 py-2">
                        <NumberCircle n={pageStart + index + 1} state={circleState(bid)} percent={syncPercent[bid.ref_no]} error={syncErrors[bid.ref_no]} hasDocs={bid.details?.documents?.length > 0} />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap"><RefLink bid={bid} /></td>
                      <td className="px-3 py-2.5"><TypeBadge type={philgepsType(bid.details?.notice_type, bid.details?.procurement_mode)} /></td>
                      <td className="px-3 py-2.5 min-w-[11rem]">{bid.procuring_entity || bid.title}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{bid.abc_amount ? formatPeso(bid.abc_amount) : '—'}</td>
                      <td className="px-3 py-2.5">{formatDate(bid.publish_date) || '—'}</td>
                      <td className="px-3 py-2.5">{formatDateTime(bid.closing_date) || '—'}</td>
                      <td className="px-3 py-2.5 min-w-[13rem]"><Products names={bid.matched_molecules} /></td>
                      <td className="px-3 py-2.5 whitespace-nowrap"><DocumentCount bid={bid} /></td>
                      <td className="px-3 py-2.5 text-right"><DetailsButton onClick={() => setSelectedBid(bid)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
        <TenderDetails bid={bids.find((b) => b.id === selectedBid.id) || selectedBid} onClose={() => setSelectedBid(null)} />
      )}
      <ScrapeProgress job={syncView} raised={Boolean(autoView)} onDismiss={() => (localSync ? setLocalSync(null) : dismissFetch())} />
      <AutoFetchBar job={autoView} onDismiss={dismissFetch} />
    </div>
  );
}
