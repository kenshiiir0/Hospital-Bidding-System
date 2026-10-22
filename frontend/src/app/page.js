'use client';

import { useState, useEffect, useRef } from 'react';
import AutoFetchBar from '@/components/AutoFetchBar';
import NumberCircle from '@/components/NumberCircle';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ScrapeProgress from '@/components/ScrapeProgress';
import TenderDetails from '@/components/TenderDetails';
import WorkingDots from '@/components/WorkingDots';
import { formatDate, formatDateTime, instantDay } from '@/lib/format';
import { downloadOpportunityWorkbook } from '@/lib/opportunityWorkbook';
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
  { key: 'files', label: '📎 With documents' },
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

// Pieces of a list row, shared by the wide-screen table and the narrow-screen cards

// The list shows the hospital (procuring entity); the full tender title is in the details panel
function BidSummary({ bid }) {
  return (
    <>
      <div className="line-clamp-2 break-words">{bid.procuring_entity || bid.title}</div>
      {bid.abc_amount && (
        <div className="text-xs font-normal text-black/46 mt-0.5">
          ABC ₱{Number(bid.abc_amount).toLocaleString('en-PH')}
        </div>
      )}
      {bid.details?.supplements?.length > 0 && (
        <div className="inline-flex items-center gap-1 text-[11px] font-medium text-[#12769F] bg-white border border-[#1EA0DA]/25 rounded-full px-2 py-0.5 mt-1.5">
          📄 {bid.details.supplements.length} bid supplement{bid.details.supplements.length > 1 ? 's' : ''}
        </div>
      )}
      {bid.details?.documents?.length > 0 && (
        <div className="inline-flex items-center gap-1 text-[11px] font-medium text-[#3F6F2C] bg-[#61A644]/10 border border-[#61A644]/25 rounded-full px-2 py-0.5 mt-1.5 ml-1">
          📎 {bid.details.documents.length} document{bid.details.documents.length > 1 ? 's' : ''}
        </div>
      )}
    </>
  );
}

function ProductPills({ names }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(names || []).map((name) => (
        <span key={name} className="max-w-full truncate px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#61A644]/10 text-[#3F6F2C] border border-[#61A644]/25" title={name}>
          {name}
        </span>
      ))}
    </div>
  );
}

function StatusPill({ status }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#61A644] text-white">
      {status || 'NEW'}
    </span>
  );
}

function DetailsButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs font-semibold text-[#12769F] hover:text-[#0E5C7C] whitespace-nowrap transition"
    >
      View Details <span className="text-[10px]">→</span>
    </button>
  );
}

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
  const [exporting, setExporting] = useState(false);
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

  // Download the listed tenders (after exclusions, search and date filter) as the team's Opportunity sheet,
  // in the same order as the table
  const exportBids = async () => {
    setExporting(true);
    try {
      await downloadOpportunityWorkbook(filteredBids);
    } catch (err) {
      setScrapeError(`Export failed: ${err.message}`);
    }
    setExporting(false);
  };

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
          const job = await (await fetch('/api/scrape')).json();
          if (stopped) break;
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

  // Only the current page is drawn; the page is clamped in case the list shrank (realtime, reload)
  const totalPages = Math.max(1, Math.ceil(filteredBids.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageBids = filteredBids.slice(pageStart, pageStart + pageSize);

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Header Bar */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#61A644]" aria-hidden />
              Hospital Opportunity Radar
            </h1>
            <p className="text-xs text-black/62 mt-1">PhilGEPS Automated Procurement Intelligence</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
          <button
            onClick={exportBids}
            disabled={exporting || loading || filteredBids.length === 0}
            className="inline-flex items-center justify-center gap-2 bg-[#61A644]/10 hover:bg-[#61A644]/20 text-[#3F6F2C] border border-[#61A644]/25 disabled:bg-white disabled:text-black/46 disabled:border-[#E2E8F0] disabled:cursor-not-allowed px-4 py-2 rounded-full text-sm font-medium transition"
          >
            {exporting ? '⏳ Exporting...' : `⬇ Export to Excel (${filteredBids.length})`}
          </button>
          <button
            onClick={fetchBids}
            disabled={reloading}
            title="Reload the list from the database without scraping PhilGEPS"
            className="inline-flex items-center justify-center gap-2 bg-white hover:bg-[#1EA0DA]/6 text-[#12769F] border border-[#1EA0DA]/25 disabled:text-black/46 disabled:border-[#E2E8F0] disabled:cursor-wait px-4 py-2 rounded-full text-sm font-medium transition"
          >
            {reloading ? '⏳ Reloading...' : '↻ Reload'}
          </button>
          <button
            onClick={triggerSync}
            disabled={syncing}
            title="Log in to PhilGEPS and download the documents of the screened tenders. Public data updates by itself every hour, 6 AM to 5 PM."
            className="inline-flex items-center justify-center gap-2 bg-[#4A8033] hover:bg-[#3F6F2C] disabled:bg-[#4A8033]/60 disabled:cursor-wait text-white px-4 py-2 rounded-full text-sm font-medium transition"
          >
            {syncView?.status === 'checking'
              ? <>Checking PhilGEPS <WorkingDots /></>
              : syncView?.status === 'queued'
                ? <>Sync waiting <WorkingDots /></>
                : syncing
                  ? <>Syncing {syncView.percent || 0}% <WorkingDots /></>
                  : '🔄 Sync'}
          </button>
          </div>
        </header>

        {scrapeError && (
          <div className="bg-[#B3312C]/8 border border-[#B3312C]/25 text-[#B3312C] text-sm rounded-[14px] px-4 py-3">
            {scrapeError}
          </div>
        )}

        {/* Number tiles */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-[#E2E8F0] p-5 rounded-[14px]">
            <span className="flex items-center gap-2 text-black/62 text-xs font-semibold uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-[#61A644]" aria-hidden />
              Matching Opportunities
            </span>
            <div className="text-3xl font-bold text-black mt-2">{visibleBids.length}</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] p-5 rounded-[14px]">
            <span className="flex items-center gap-2 text-black/62 text-xs font-semibold uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-[#61A644]" aria-hidden />
              Our Products Requested
            </span>
            <div className="text-3xl font-bold text-[#3F6F2C] mt-2">{productCount}</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] p-5 rounded-[14px]">
            <span className="flex items-center gap-2 text-black/62 text-xs font-semibold uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-[#1EA0DA]" aria-hidden />
              Added Today
            </span>
            <div className="text-3xl font-bold text-[#12769F] mt-2">{addedToday}</div>
            <div className="text-xs text-black/46 mt-1.5">
              {reloading ? 'Updating…' : updatedAt ? `Updated ${formatUpdatedAt(updatedAt)}` : ''}
            </div>
          </div>
        </section>

        {/* Search Input Bar */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search by reference no., tender title, hospital name or molecule..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
          />
          <button
            onClick={() => setShowExclusions(!showExclusions)}
            aria-expanded={showExclusions}
            className={`rounded-[14px] px-4 py-3 text-sm font-medium border transition ${
              excluded.length
                ? 'bg-[#1EA0DA]/8 border-[#1EA0DA]/25 text-[#12769F] hover:bg-[#1EA0DA]/12'
                : 'bg-white border-[#CBD5E1] text-black hover:bg-[#1EA0DA]/6'
            }`}
          >
            Exclude Products{excluded.length ? ` (${excluded.length})` : ''} {showExclusions ? '▴' : '▾'}
          </button>
        </div>

        {/* Documents filter: tenders with files / pick-up only / no documents yet */}
        <div className="flex flex-wrap items-center gap-2 text-sm" role="tablist" aria-label="Documents">
          {DOC_GROUPS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={docFilter === key}
              onClick={() => {
                setDocFilter(key);
                setPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border transition ${
                docFilter === key
                  ? 'bg-[#1EA0DA]/10 border-[#1EA0DA]/40 text-[#12769F] font-medium'
                  : 'bg-white border-[#CBD5E1] text-black hover:bg-[#1EA0DA]/6'
              }`}
            >
              {label}
              <span className="text-xs tabular-nums text-black/46">{docCounts[key]}</span>
            </button>
          ))}
        </div>

        {/* Published-date filter and sort direction */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-black/62">Published</span>
          <label className="flex items-center gap-2 text-black/62">
            from
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="bg-white border border-[#CBD5E1] text-black rounded-full px-3 py-1.5 focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25"
            />
          </label>
          <label className="flex items-center gap-2 text-black/62">
            to
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="bg-white border border-[#CBD5E1] text-black rounded-full px-3 py-1.5 focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25"
            />
          </label>
          <button
            onClick={() => {
              setOldestFirst(!oldestFirst);
              setPage(1);
            }}
            title="Reverse the order of the list"
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 border border-[#CBD5E1] bg-white text-black hover:bg-[#1EA0DA]/6 transition"
          >
            <span aria-hidden>⇅</span> {oldestFirst ? 'Oldest first' : 'Latest first'}
          </button>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setPage(1);
              }}
              className="text-[#12769F] hover:text-[#0E5C7C] px-2 py-1.5 transition"
            >
              Clear dates
            </button>
          )}
        </div>

        {/* Product Exclusion Filter */}
        {showExclusions && (
          <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <input
                type="text"
                placeholder="Search products..."
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-3 py-2.5 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
              />
              <button
                onClick={() => updateExcluded([])}
                disabled={!excluded.length}
                className="text-sm text-[#12769F] hover:text-[#0E5C7C] disabled:text-black/36 disabled:cursor-not-allowed px-3 py-2.5 transition"
              >
                Clear exclusions
              </button>
            </div>
            <p className="text-xs text-black/46">
              Checked products are excluded: any tender that requests one of them is removed from the list.
            </p>
            {listedProducts.length === 0 ? (
              <p className="text-sm text-black/46 py-4 text-center">No products match &quot;{productSearch}&quot;.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 max-h-72 overflow-y-auto pr-1">
                {listedProducts.map((name) => (
                  <label
                    key={name}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-black hover:bg-[#1EA0DA]/6 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={excluded.includes(name)}
                      onChange={() => toggleExcluded(name)}
                      className="h-4 w-4 accent-[#1EA0DA]"
                    />
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
            <span className="text-black/62">
              Excluding ({bids.length - visibleBids.length} tenders hidden):
            </span>
            {excluded.map((name) => (
              <button
                key={name}
                onClick={() => toggleExcluded(name)}
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#1EA0DA]/8 text-[#12769F] border border-[#1EA0DA]/25 hover:bg-[#1EA0DA]/12 transition"
                title={`Stop excluding ${name}`}
              >
                {name} <span aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}

        {/* Opportunity list: one page at a time, sized to fit without sideways scrolling.
            A table on wide screens, stacked cards below xl (the sidebar leaves too little room for 7 columns). */}
        <div ref={listTop} className="scroll-mt-6 space-y-4">
          <div className="bg-white border border-[#E2E8F0] rounded-[14px] overflow-hidden shadow-none">
            {loading ? (
              <p className="py-12 text-center text-sm text-black/46">Fetching live opportunities from database...</p>
            ) : filteredBids.length === 0 ? (
              <p className="py-12 text-center text-sm text-black/46">No matching records found.</p>
            ) : (
              <>
                <table className="hidden xl:table w-full table-fixed text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-[#1EA0DA]/5 border-b border-[#E2E8F0] text-black/62 text-xs font-semibold uppercase tracking-wider">
                      <th className="py-3.5 pl-4 pr-2 w-12 text-center">#</th>
                      <th className="py-3.5 px-3 w-28">Reference No.</th>
                      <th className="py-3.5 px-4">Hospital / Procuring Entity</th>
                      <th className="py-3.5 px-4 w-[22%]">Our Products</th>
                      <th className="py-3.5 px-3 w-40">Published / Closing</th>
                      <th className="py-3.5 px-3 w-24 text-center">Status</th>
                      <th className="py-3.5 pl-3 pr-4 w-28 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageBids.map((bid, index) => (
                      <tr key={bid.id || index} className="bg-white border-b border-[#E2E8F0] last:border-b-0 hover:bg-[#1EA0DA]/6 transition-colors align-top">
                        <td className="py-3 pl-4 pr-2 text-center">
                          <NumberCircle n={pageStart + index + 1} state={circleState(bid)} percent={syncPercent[bid.ref_no]} error={syncErrors[bid.ref_no]} hasDocs={bid.details?.documents?.length > 0} />
                        </td>
                        <td className="py-4 px-3 font-mono text-xs text-black/62 break-all">{bid.ref_no}</td>
                        <td className="py-4 px-4 font-semibold text-black leading-relaxed">
                          <BidSummary bid={bid} />
                        </td>
                        <td className="py-4 px-4">
                          <ProductPills names={bid.matched_molecules} />
                        </td>
                        <td className="py-4 px-3 text-xs">
                          <div className="text-sm font-semibold text-black">{formatDate(bid.publish_date) || '—'}</div>
                          <div className="text-black/46 mt-1">Closes {formatDateTime(bid.closing_date) || '—'}</div>
                        </td>
                        <td className="py-4 px-3 text-center">
                          <StatusPill status={bid.status} />
                        </td>
                        <td className="py-4 pl-3 pr-4 text-right">
                          <DetailsButton onClick={() => setSelectedBid(bid)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <ul className="xl:hidden divide-y divide-[#E2E8F0]">
                  {pageBids.map((bid, index) => (
                    <li key={bid.id || index} className="p-4 space-y-3 hover:bg-[#1EA0DA]/6 transition-colors">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-mono text-black/62 break-all">
                          <NumberCircle n={pageStart + index + 1} state={circleState(bid)} percent={syncPercent[bid.ref_no]} error={syncErrors[bid.ref_no]} hasDocs={bid.details?.documents?.length > 0} /> {bid.ref_no}
                        </span>
                        <StatusPill status={bid.status} />
                      </div>
                      <div className="font-semibold text-sm text-black leading-relaxed">
                        <BidSummary bid={bid} />
                      </div>
                      <ProductPills names={bid.matched_molecules} />
                      <div className="flex flex-wrap items-end justify-between gap-3 text-xs">
                        <div className="space-y-0.5">
                          <div className="text-black/62">
                            Published <span className="text-sm font-semibold text-black">{formatDate(bid.publish_date) || '—'}</span>
                          </div>
                          <div className="text-black/46">Closes {formatDateTime(bid.closing_date) || '—'}</div>
                        </div>
                        <DetailsButton onClick={() => setSelectedBid(bid)} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

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
        </div>

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
