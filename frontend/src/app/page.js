'use client';

import { useState, useEffect, useRef } from 'react';
import { CustomSelect, LotPill, NewPill, PublishedTag, DateRangeDropdown, MultiSelectDropdown, ProductChips as Products, SearchPill, SegmentedTabs } from '@/components/FilterControls';
import PageHeader, { KpiRow, blueAction, pesoTotal, pesoValue, plainAction } from '@/components/PageHeader';
import { PsPortalProvider, psDateTime, psDay } from '@/components/PsPortal';
import PsBidMatchDetails from '@/components/PsBidMatchDetails';
import SourceTag, { SOURCES } from '@/components/SourceTag';
import { startedByLabel } from '@/components/FetchedSection';
import { usePsPhilgeps } from '@/lib/psContext';
import { psRefOf } from '@/lib/opportunityWorkbook';
import { psType } from '@/lib/tenderType';
import { setNavCount } from '@/lib/navCounts';
import { reportUnread, useSeenOnOpen, useTenderNews } from '@/lib/newTenders';
import AutoFetchBar from '@/components/AutoFetchBar';
import NumberCircle from '@/components/NumberCircle';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import ResponsiveTable from '@/components/ResponsiveTable';
import ScrapeProgress from '@/components/ScrapeProgress';
import { clearSync, failSync, followSync, philgepsRun, pressedSync, useSyncAlert } from '@/lib/syncAlerts';
import OcrHealthNotice from '@/components/OcrHealthNotice';
import TenderDetails from '@/components/TenderDetails';
import TypeBadge from '@/components/TypeBadge';
import { philgepsType } from '@/lib/tenderType';
import { activeTenders } from '@/lib/activeProducts';
import { useScreened } from '@/lib/screened';
import { stillReading } from '@/lib/documentsReading';
import WorkingDots from '@/components/WorkingDots';
import { formatDate, formatDateTime, formatInstant, formatPeso, instantDay } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { authFetch } from '@/lib/authFetch';

const EXCLUDED_KEY = 'excludedProducts';
// Sort choices, the same as the PS-PhilGEPS lists (PsFilters.js PS_SORTS); the first is the default
const SORTS = [
  { value: 'latest', label: 'Latest published' },
  { value: 'oldest', label: 'Oldest published' },
  { value: 'closing', label: 'Closing soonest' },
  { value: 'budget', label: 'Highest budget' },
];
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

// "Oct 25, 2026 9:15 AM" in Philippine time, the same format as the PS-PhilGEPS header's status
const formatUpdatedAt = (timestamp) => formatInstant(new Date(timestamp).toISOString());

// Saved documents results shown on a row's circle outside a Sync (grey pick-up, red problems)
const SAVED_CIRCLE_STATES = new Set(['pick-up', 'closed', 'needs-payment', 'order-flow-changed', 'no-order-link', 'none-found']);

// Documents filter groups, by what the Sync found for the tender
const DOC_GROUPS = [
  { key: 'all', label: 'All' },
  { key: 'files', label: 'With documents' },
  { key: 'pickup', label: 'Pick-up only' },
  { key: 'none', label: 'No documents yet' },
];

// Scanned documents still being read automatically with OCR (lib/documentsReading.js)
const reading = (bid) => stillReading(bid.details?.documents_read);

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
        {reading(bid) && <span className="block font-medium text-[#12769F]">Reading scans (OCR)</span>}
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

// A PS-PhilGEPS notice number links to the notice on PS-PhilGEPS
function PsRefLink({ row }) {
  const ref = row.cells[0];
  const link = row.links.find((l) => l.text === ref);
  if (!link) return ref;
  return (
    <a href={link.href} target="_blank" rel="noreferrer" className="text-[#12769F] underline-offset-2 hover:text-[#0E5C7C] hover:underline">
      {ref}
    </a>
  );
}

// A PS-PhilGEPS tender's downloaded documents (reading: scanned ones still being read with OCR)
function PsDocumentCount({ notice, reading }) {
  if (!notice) return <span className="text-black/46">—</span>;
  if (notice.error) return <span className="text-xs text-[#B3312C]">Not read</span>;
  const n = notice.documents?.length || 0;
  if (!n) return <span className="text-xs text-[#B3312C]">None yet</span>;
  return (
    <span className="text-xs text-[#3F6F2C]">
      📎 {n} file{n > 1 ? 's' : ''}
      {reading && <span className="block font-medium text-[#12769F]">Reading scans (OCR)</span>}
    </span>
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

// "Oct 24" (the year only when it isn't this year), for the Published column
function shortDay(value, thisYear) {
  const text = formatDate(value);
  return text && thisYear && text.endsWith(`, ${thisYear}`) ? text.slice(0, -6) : text;
}

// Bid Match: both portals' tenders for our products in one list (PhilGEPS is being phased out, user 2026-11-06),
// each tagged with its portal, with each portal's own Sync button, progress and notices. The PS-PhilGEPS state
// (data, Sync, log-in) comes from PsPortalProvider, shared with the PS-PhilGEPS pages.
export default function Home() {
  return (
    <PsPortalProvider>
      <BidMatch />
    </PsPortalProvider>
  );
}

function BidMatch() {
  const [bids, setBids] = useState([]);
  // New, unread tenders (lib/newTenders.js)
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
  const [selectedBid, setSelectedBid] = useState(null);
  // Published and closing date ranges ("YYYY-MM-DD" from the date inputs; empty = no limit) and the sort,
  // with the same choices as the PS-PhilGEPS lists (SORTS)
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [closingFrom, setClosingFrom] = useState('');
  const [closingTo, setClosingTo] = useState('');
  const [sortKey, setSortKey] = useState('latest');
  // Our product filter: '' = all, else one product name
  const [productFilter, setProductFilter] = useState('');
  // Documents filter: 'all' | 'files' (downloaded) | 'pickup' (pick-up only) | 'none' (no documents yet)
  const [docFilter, setDocFilter] = useState('all');
  // Tender type filter: '' = all, else a code from lib/tenderType.js (ITB, RFQ, RFP, Negotiated)
  const [typeFilter, setTypeFilter] = useState('');
  // Portal filter: '' = both, 'philgeps' or 'ps'
  const [portalFilter, setPortalFilter] = useState('');
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
  const loadBids = async () => {
    // Screened tenders too, whatever their molecules (a package or lot tender keeps none), so they stay findable
    const [{ data, error }, { data: screenedRows }] = await Promise.all([
      supabase.from('philgeps_opportunities').select('*').not('matched_molecules', 'eq', '{}').order('id', { ascending: false }),
      supabase.from('screened_tenders').select('ref').eq('source', 'philgeps'),
    ]);
    const listed = new Set((data || []).map((bid) => bid.ref_no));
    const missing = (screenedRows || []).map((r) => r.ref).filter((ref) => !listed.has(ref));
    const { data: screenedBids } = missing.length ? await supabase.from('philgeps_opportunities').select('*').in('ref_no', missing) : { data: [] };

    if (error) {
      console.error('Error fetching bids:', error.message);
      setScrapeError(`Could not load tenders: ${error.message}`);
    } else {
      setBids([...(data || []), ...(screenedBids || [])].sort((a, b) => b.id - a.id));
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
        pressedSync('philgeps');
        // Asked from a dashboard without the scraper: the team computer starts it within a few seconds
        setLocalSync({ status: 'queued', stage: 'Sent to the team computer; starting in a few seconds', requestedAt: Date.now() });
        wakePoll.current?.();
      } else if (!result.ok) {
        setLocalSync({ status: 'failed', percent: 0, error: result.error || `Sync failed (${res.status})` });
        failSync('philgeps', { error: result.error || `Sync failed (${res.status})` });
      } else {
        if (result.job) setFetchJob(result.job);
        pressedSync('philgeps');
        setLocalSync(null);
        wakePoll.current?.();
      }
    } catch (err) {
      setLocalSync({ status: 'failed', percent: 0, error: err.message });
      failSync('philgeps', { error: err.message });
    }
  };

  // The ring's Cancel button: the Sync stops after the tender in progress and logs out of PhilGEPS (DELETE
  // /api/scrape). cancelFor: the Sync it was pressed for, shown as cancelling until the server confirms the end.
  const [cancelFor, setCancelFor] = useState(null);
  const cancelSync = async () => {
    if (!window.confirm('Cancel the Sync? It stops after the tender in progress and logs out of PhilGEPS.')) return;
    setCancelFor(fetchJob?.startedAt ?? null);
    try {
      const res = await authFetch('/api/scrape', { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || `Could not cancel (${res.status})`);
    } catch (err) {
      setCancelFor(null);
      window.alert(`The Sync could not be cancelled: ${err.message}`);
    }
    wakePoll.current?.();
  };

  // What the ring (Sync) and the bottom bar (automatic update) show
  const jobRunning = fetchJob?.status === 'running';
  const jobShown = fetchJob && (jobRunning || (fetchJob.finishedAt && !dismissed.includes(fetchJob.startedAt)));
  const syncQueued = (fetchJob?.queued || []).includes('sync');
  const cancelPressed = jobRunning && cancelFor != null && cancelFor === fetchJob.startedAt && !fetchJob.cancelling;
  // A failed Sync not closed yet, also when it ended while another page was open (lib/syncAlerts.js)
  const savedSync = useSyncAlert('philgeps');
  const savedFailure = savedSync?.status === 'failed' ? { status: 'failed', percent: savedSync.percent, stage: savedSync.stage, error: savedSync.error } : null;
  const syncView =
    localSync ||
    (syncQueued ? { status: 'queued', stage: 'Starts when the automatic update finishes' } : null) ||
    (jobShown && fetchJob.kind === 'sync'
      ? cancelPressed
        ? { ...fetchJob, cancelling: true, stage: 'Cancelling: stops after the tender in progress, then logs out of PhilGEPS' }
        : fetchJob
      : null) ||
    savedFailure;
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
  // The ring's ×: a failure closed here is closed on every page
  const closeRing = () => {
    if (localSync) setLocalSync(null);
    else dismissFetch();
    if (savedSync?.status === 'failed') clearSync('philgeps', savedSync.startedAt);
  };

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
  const screened = useScreened();
  const ourCount = loading ? null : activeTenders(bids, products.length ? new Set(products) : null, screened).length;
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
          // Kept for the other pages: a failure stays on screen there until closed (components/SyncAlertHost.js)
          followSync('philgeps', philgepsRun(job));
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
          console.log('New tender added:', payload.new);
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
          // that newly does (e.g. found in its documents once OCR has read them) joins it.
          const ours = (payload.new.matched_molecules || []).length > 0;
          const place = (keep) => (prev) => {
            const listed = prev.some((bid) => bid.id === payload.new.id);
            if (!keep) return listed ? prev.filter((bid) => bid.id !== payload.new.id) : prev;
            return listed ? prev.map((bid) => (bid.id === payload.new.id ? payload.new : bid)) : [payload.new, ...prev];
          };
          setBids(place(ours));
        }
      )
      .subscribe();

    return () => {
      stopped = true;
      wakePoll.current?.();
      supabase.removeChannel(channel);
    };
  }, []);

  // New, unread tenders (lib/newTenders.js)
  const news = useTenderNews();
  // New, unread tenders (lib/newTenders.js): the NEW label, the sidebar's "N new", Mark all as read
  const unreadBids = loading || !news.ready ? [] : activeTenders(bids, products.length ? new Set(products) : null, screened).filter(news.isNewPhilgeps);
  const unreadCount = loading || !news.ready ? null : unreadBids.length;
  useEffect(() => {
    if (unreadCount != null) reportUnread('/', unreadCount);
  }, [unreadCount]);
  // Opening this page reads them: labelled NEW for this visit, gone from the sidebar count
  const seenNow = useSeenOnOpen(unreadBids.map((bid) => `philgeps:${bid.id}`));
  const isNew = (bid) => news.isNewPhilgeps(bid) || seenNow.has(`philgeps:${bid.id}`);

  // PS-PhilGEPS (components/PsPortal.js): its Bid Match list, notices and what was read in the documents
  const ps = usePsPhilgeps();
  const psData = ps.data;
  const psList = psData?.lists?.bidMatch;
  const psCell = (row, name) => row.cells[psList.headers.indexOf(name)] || '';
  const psNotice = (row) => psData?.notices?.[psRefOf(row)];
  const psReading = (row) => psData?.analysis?.[psRefOf(row)];
  // Our products of a PS-PhilGEPS tender: matched on the notice page or named in its documents (a notice titled
  // only "Drugs and Medicines" lists its items in the documents)
  const psProductsOf = (row) => [...new Set([...(psNotice(row)?.matched || []), ...(psReading(row)?.result?.items || []).flatMap((i) => i.our_products)])];
  const psKey = (row) => `ps:${psRefOf(row) || row.cells[0]}`;
  // Screened tenders always stay in the list (findable by search) even without our products now
  const psOurs = (psList?.rows || []).filter((row) => psProductsOf(row).length || screened.has('ps', psRefOf(row)));
  // Opening this page reads the new ones: labelled NEW for this visit, gone from the sidebar count
  const psSeenNow = useSeenOnOpen(news.ready ? psOurs.filter((row) => news.isNewPs(psKey(row))).map(psKey) : []);
  // Who started the Sync that fetched the current PS-PhilGEPS list (the status row describes the last run)
  const psLastSyncBy =
    ps.sync?.finished_at && psData?.syncedAt && Math.abs(new Date(ps.sync.finished_at) - new Date(psData.syncedAt)) < 10 * 60 * 1000 ? startedByLabel(ps.sync.started_by) : null;

  // Only molecules still on the Product List (an archived one shows nowhere, before the stored matches catch up)
  // Screened tenders always stay (findable by search) even without molecules
  const ourBids = activeTenders(bids, products.length ? new Set(products) : null, screened);
  // Bid documents a Sync downloaded into the system for a tender
  const filesOf = (bid) => (bid.details?.documents || []).filter((doc) => doc.path).length;

  // Both portals' tenders in one shape, for the list, the filters and the counts.
  // published: "YYYY-MM-DD"; closing: "YYYY-MM-DDTHH:MM" (sorts the same on both); text: what the search looks in
  const tenders = [
    ...ourBids.map((bid) => ({
      source: 'philgeps',
      key: `philgeps:${bid.id}`,
      bid,
      ref: bid.ref_no || '',
      agency: bid.procuring_entity || bid.title || '',
      abc: Number(bid.abc_amount) || 0,
      published: bid.publish_date || '',
      closing: String(bid.closing_date || ''),
      products: bid.matched_molecules || [],
      type: philgepsType(bid.details?.notice_type, bid.details?.procurement_mode),
      lot: Boolean(bid.lot),
      docGroup: docGroupOf(bid),
      files: filesOf(bid),
      isNew: isNew(bid),
      text: `${bid.ref_no || ''} ${bid.title || ''} ${bid.procuring_entity || ''}`,
    })),
    ...psOurs.map((row) => ({
      source: 'ps',
      key: psKey(row),
      row,
      ref: psRefOf(row) || row.cells[0],
      agency: psCell(row, 'Agency name'),
      abc: pesoValue(psCell(row, 'Approve Budget Contract')),
      published: psDay(psCell(row, 'Publish Date')),
      closing: psDateTime(psCell(row, 'Closing Date')),
      products: psProductsOf(row),
      type: psType(psCell(row, 'Mode of Procurement')),
      lot: Boolean(psNotice(row)?.lot),
      // PS-PhilGEPS has no pick-up only notices
      docGroup: psNotice(row)?.documents?.length ? 'files' : 'none',
      files: (psNotice(row)?.documents || []).filter((doc) => doc.path).length,
      isNew: news.isNewPs(psKey(row)) || psSeenNow.has(psKey(row)),
      // Every column of the row, including the long title the list doesn't show
      text: row.cells.join(' '),
    })),
  ];
  // Drop every tender that requests an excluded product
  const visible = tenders.filter((t) => !t.products.some((name) => excluded.includes(name)));

  // Distinct products of ours requested across the listed tenders
  const productCount = new Set(visible.flatMap((t) => t.products)).size;

  // New today: PhilGEPS tenders first saved today, PS-PhilGEPS tenders published today (Philippine dates).
  // `today` comes from state set in the browser (see the effect above): reading the clock while
  // rendering would freeze the prerender's date into the page.
  const addedToday = today ? visible.filter((t) => (t.source === 'philgeps' ? instantDay(t.bid.created_at) === today : t.published === today)).length : 0;

  // How many loaded tenders request each product, shown next to it in the filter
  const tendersPerProduct = {};
  for (const t of tenders) for (const name of t.products) tendersPerProduct[name] = (tendersPerProduct[name] || 0) + 1;

  // Search: every word typed must appear in the tender (reference number, title, agency, our products);
  // then the published and closing date ranges, the chosen product and portal, then the chosen sort
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearchAndDates = (t) => {
    const text = `${t.text} ${t.products.join(' ')}`.toLowerCase();
    const closingDay = t.closing.slice(0, 10);
    return (
      words.every((w) => text.includes(w)) &&
      (!dateFrom || t.published >= dateFrom) &&
      (!dateTo || (t.published && t.published <= dateTo)) &&
      (!closingFrom || closingDay >= closingFrom) &&
      (!closingTo || (closingDay && closingDay <= closingTo)) &&
      (!productFilter || t.products.includes(productFilter))
    );
  };
  const ofPortal = (t) => !portalFilter || t.source === portalFilter;
  // Portal filter counts follow the search and dates
  const portalCounts = { philgeps: 0, ps: 0 };
  for (const t of visible) if (matchesSearchAndDates(t)) portalCounts[t.source]++;
  const matching = visible.filter((t) => matchesSearchAndDates(t) && ofPortal(t));
  // Our product filter: the products asked for in the listed tenders, most requested first, with counts
  const productCounts = {};
  for (const t of visible) for (const name of t.products) productCounts[name] = (productCounts[name] || 0) + 1;
  const productOptions = Object.keys(productCounts)
    .sort((a, b) => productCounts[b] - productCounts[a])
    .map((name) => ({ value: name, label: name, count: productCounts[name] }));
  const filtersActive = Boolean(portalFilter || typeFilter || productFilter || dateFrom || dateTo || closingFrom || closingTo);
  const clearFilters = () => {
    setPortalFilter('');
    setTypeFilter('');
    setProductFilter('');
    setDateFrom('');
    setDateTo('');
    setClosingFrom('');
    setClosingTo('');
    setPage(1);
  };
  // Type filter (ITB, RFQ...): options are the types in the searched list, most common first, with counts
  const typeCounts = {};
  for (const t of matching) if (t.type.code) typeCounts[t.type.code] = (typeCounts[t.type.code] || 0) + 1;
  const typeOptions = Object.keys(typeCounts)
    .sort((a, b) => typeCounts[b] - typeCounts[a])
    .map((code) => ({ value: code, label: code, count: typeCounts[code] }));
  const ofType = (t) => !typeFilter || t.type.code === typeFilter;
  const searched = matching.filter(ofType);
  // Counts for the documents filter follow the search, date, portal and type filters
  const docCounts = { all: searched.length, files: 0, pickup: 0, none: 0 };
  for (const t of searched) docCounts[t.docGroup]++;
  const filtered = searched
    .filter((t) => docFilter === 'all' || t.docGroup === docFilter)
    .sort((a, b) => {
      // New, unread tenders first, then the chosen order
      const byNew = Number(b.isNew) - Number(a.isNew);
      const byDate = a.published.localeCompare(b.published) || a.ref.localeCompare(b.ref);
      const byClosing = (a.closing || '9999').localeCompare(b.closing || '9999');
      const byBudget = b.abc - a.abc;
      const chosen = { latest: -byDate, oldest: byDate, closing: byClosing || -byDate, budget: byBudget || -byDate }[sortKey];
      return byNew || chosen;
    });

  // Header and summary cards: what is listed now (after the tabs, search and filters)
  const listedProducts = new Set(filtered.flatMap((t) => t.products)).size;
  const listedAbc = filtered.reduce((sum, t) => sum + t.abc, 0);
  // Bid documents the Syncs downloaded into the system for the listed tenders
  const fetchedFiles = filtered.reduce((sum, t) => sum + t.files, 0);
  const tendersWithFiles = filtered.filter((t) => t.files > 0).length;
  const thisYear = today.slice(0, 4);
  const philgepsStatus = scrapeError
    ? { tone: 'error', text: 'Could not load' }
    : syncing
      ? { tone: 'busy', text: syncView?.status === 'running' ? `Syncing ${syncView.percent || 0}%` : 'Sync starting' }
      : loading || reloading
        ? { tone: 'busy', text: loading ? 'Loading…' : 'Updating…' }
        : { tone: 'ok', text: `Updated ${updatedAt ? formatUpdatedAt(updatedAt) : ''}` };
  const status = [
    { ...philgepsStatus, text: `PhilGEPS · ${philgepsStatus.text}` },
    { ...ps.portal.status, text: `PS-PhilGEPS · ${ps.portal.status.text}` },
  ];
  // The bottom bars (hourly updates) of both portals stack; the progress cards sit above them
  const bars = Number(Boolean(autoView)) + Number(Boolean(ps.portal.barJob));

  // Only the current page is drawn; the page is clamped in case the list shrank (realtime, reload)
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageTenders = filtered.slice(pageStart, pageStart + pageSize);
  const loadingList = loading && !psData;

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Header: title + each portal's live status, actions (the two Syncs last), then the summary cards */}
        <PageHeader
          title="Bid Match"
          status={status}
          subtitle={<>PhilGEPS and PS-PhilGEPS tenders for our products{addedToday > 0 && ` · ${addedToday} new today`}</>}
          actions={
            <>
              <button
                onClick={() => {
                  fetchBids();
                  ps.portal.reloadNow();
                }}
                disabled={reloading || ps.portal.reloading}
                title="Reload both portals' lists from the database without contacting PhilGEPS"
                className={plainAction}
              >
                {reloading || ps.portal.reloading ? <>Reloading <WorkingDots /></> : '↻ Reload'}
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
              {ps.portal.syncButton}
            </>
          }
        />

        {scrapeError && <Notice tone="error">{scrapeError}</Notice>}
        {ps.portal.notices}
        <OcrHealthNotice />

        <KpiRow
          items={[
            { label: 'Total opportunities', value: filtered.length, note: `of ${visible.length} asking for our products` },
            { label: 'Product matches', value: listedProducts, tone: 'green', note: `of our products requested (${productCount} in all)` },
            { label: 'Total ABC value', value: pesoTotal(listedAbc), tone: 'blue', note: 'approved budgets of the listed tenders' },
            { label: 'Documents fetched', value: fetchedFiles, tone: 'docs', note: `files of ${tendersWithFiles} of the ${filtered.length} listed tenders` },
          ]}
        />

        <section ref={listTop} className="scroll-mt-6 space-y-3">
          {/* Tier 1: which tenders, by their documents */}
          <div className="flex flex-wrap items-center justify-between gap-2">
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

          {/* Tier 2: search, then the dropdowns. Phones: an even two-column grid under a full-width search */}
          <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
            <SearchPill
              className="col-span-2"
              label="Search tenders"
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />
            <CustomSelect
              label="Portal"
              className="w-full sm:w-auto"
              value={portalFilter}
              onChange={(value) => {
                setPortalFilter(value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Both' },
                { value: 'philgeps', label: SOURCES.philgeps, count: portalCounts.philgeps },
                { value: 'ps', label: SOURCES.ps, count: portalCounts.ps },
              ]}
            />
            <CustomSelect
              label="Our product"
              className="w-full sm:w-auto sm:max-w-[18rem]"
              value={productFilter}
              onChange={(value) => {
                setProductFilter(value);
                setPage(1);
              }}
              options={[{ value: '', label: 'All' }, ...productOptions]}
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
              value={sortKey}
              defaultValue="latest"
              onChange={(value) => {
                setSortKey(value);
                setPage(1);
              }}
              options={SORTS}
            />
            <DateRangeDropdown
              className="col-span-2 w-full sm:col-auto sm:w-auto"
              fields={[
                { key: 'published', label: 'Published' },
                { key: 'closing', label: 'Closing' },
              ]}
              ranges={{ published: { from: dateFrom, to: dateTo }, closing: { from: closingFrom, to: closingTo } }}
              onChange={(key, { from, to }) => {
                if (key === 'closing') {
                  setClosingFrom(from);
                  setClosingTo(to);
                } else {
                  setDateFrom(from);
                  setDateTo(to);
                }
                setPage(1);
              }}
            />
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="col-span-2 rounded-full px-3 py-1.5 text-xs font-medium text-[#12769F] hover:bg-[#1EA0DA]/6 sm:col-auto"
              >
                Clear filters
              </button>
            )}
          </div>

          {excluded.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-black/62">Leaving out ({tenders.length - visible.length} tenders hidden):</span>
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

          {/* The list: both portals in one table, each row tagged with its portal */}
          {loadingList ? (
            <EmptyState>Loading opportunities…</EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyState>Nothing to show.</EmptyState>
          ) : (
            <ResponsiveTable
              rows={pageTenders}
              rowKey={(t) => t.key}
              onDetails={setSelectedBid}
              columns={[
                {
                  label: '#',
                  lead: true,
                  width: '3rem',
                  render: (t, index) =>
                    t.source === 'philgeps' ? (
                      <NumberCircle n={pageStart + index + 1} state={circleState(t.bid)} percent={syncPercent[t.ref]} error={syncErrors[t.ref]} hasDocs={t.bid.details?.documents?.length > 0} />
                    ) : (
                      // Green once the notice's documents are downloaded
                      <NumberCircle n={pageStart + index + 1} hasDocs={t.docGroup === 'files'} />
                    ),
                },
                {
                  label: 'Ref No. & Type',
                  title: true,
                  width: '9rem',
                  render: (t) => (
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5 font-semibold">
                        {t.source === 'philgeps' ? <RefLink bid={t.bid} /> : <PsRefLink row={t.row} />}
                        {t.lot && <LotPill />}
                        {t.isNew && <NewPill />}
                      </div>
                      {/* Portal and type */}
                      <div className="flex flex-wrap gap-1">
                        <SourceTag source={t.source} />
                        <TypeBadge type={t.type} />
                      </div>
                      <div className="font-normal">
                        {t.source === 'philgeps' ? <DocumentCount bid={t.bid} /> : <PsDocumentCount notice={psNotice(t.row)} reading={stillReading(psReading(t.row)?.documents_read)} />}
                      </div>
                    </div>
                  ),
                },
                {
                  label: 'Procuring Agency',
                  wide: true,
                  render: (t) => (
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug text-black" title={t.agency}>
                      {t.agency}
                    </span>
                  ),
                },
                {
                  label: 'Approved Budget (ABC)',
                  width: '9rem',
                  align: 'right',
                  nowrap: true,
                  render: (t) => <span className="text-[13px] font-medium tabular-nums text-black">{t.abc ? formatPeso(t.abc) : '—'}</span>,
                },
                // Only the published date in the list; the closing date is in View details
                {
                  label: 'Published',
                  width: '8rem',
                  render: (t) => (
                    <div className="text-xs">
                      <PublishedTag text={shortDay(t.published, thisYear) || '—'} />
                    </div>
                  ),
                },
                { label: 'Matched Molecules', wide: true, render: (t) => <Products names={t.products} /> },
              ]}
            />
          )}

          {!loadingList && filtered.length > 0 && (
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={goToPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}
        </section>
      </div>

      {/* The freshest copy of the open tender (the lists reload while a Sync saves each result) */}
      {selectedBid?.source === 'philgeps' && (
        <TenderDetails bid={ourBids.find((b) => b.id === selectedBid.bid.id) || selectedBid.bid} onClose={() => setSelectedBid(null)} />
      )}
      {selectedBid?.source === 'ps' && (
        <PsBidMatchDetails
          data={psData}
          row={psOurs.find((row) => psKey(row) === selectedBid.key) || selectedBid.row}
          lastSyncBy={psLastSyncBy}
          onClose={() => setSelectedBid(null)}
        />
      )}

      {/* Each portal's Sync card, stacked bottom-left above the hourly-update bars */}
      <div className={`fixed left-5 z-40 flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2 ${bars === 2 ? 'bottom-24' : bars === 1 ? 'bottom-14' : 'bottom-5'}`}>
        <ScrapeProgress inline job={syncView} name="PhilGEPS" onCancel={cancelSync} onDismiss={closeRing} />
        <ScrapeProgress inline job={ps.portal.ringJob} name="PS-PhilGEPS" onCancel={ps.portal.cancelSync} onDismiss={ps.portal.closeRing} />
      </div>
      <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col">
        <AutoFetchBar inline job={autoView} onDismiss={dismissFetch} />
        <AutoFetchBar inline job={ps.portal.barJob} running="Hourly PS-PhilGEPS Sync" done="PS-PhilGEPS updated" onDismiss={ps.portal.dismissBar} />
      </div>
    </div>
  );
}
