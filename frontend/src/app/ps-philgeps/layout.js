'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';
import PageHeader, { blueAction } from '@/components/PageHeader';
import { PsContext } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsLiveLogin from '@/components/PsLiveLogin';
import ScrapeProgress from '@/components/ScrapeProgress';
import OcrHealthNotice from '@/components/OcrHealthNotice';
import { activePsData, loadActiveNames } from '@/lib/activeProducts';
import { registerList, reportUnread, useTenderNews } from '@/lib/newTenders';
import { psRefOf } from '@/lib/opportunityWorkbook';

// Shared by the PS-PhilGEPS pages (Bid Match, My Opportunities, Award Notices), on the deployed dashboard
// and on team computers alike:
// - data: the last Sync's result (Supabase ps_philgeps_snapshot),
// - sync: Sync status for the whole team (Supabase ps_sync_status; connected_at = a saved session exists),
//   started with POST /api/ps-sync (runs on the server, no browser),
// - one button: when the PhilGEPS log-in has ended, Sync first opens the log-in (Google's captcha needs a
//   real browser) on this laptop: through POST /api/ps-philgeps where the dashboard runs on this computer,
//   else through the "ps-philgeps-connect:" link (set up once per laptop by tools/register-connect-link.js,
//   runs "Connect PS-PhilGEPS.cmd"). Once the session is saved the Sync starts by itself.
// Wait after the last live change before reloading the data (one reload for a burst of changes)
const DATA_RELOAD_WAIT_MS = 2000;

export default function PsPhilgepsLayout({ children }) {
  const [data, setData] = useState(null);
  const [sync, setSync] = useState(null);
  // null = not checked yet, false = this dashboard can't open a log-in window (deployed copy)
  const [connect, setConnect] = useState(null);
  const [requestError, setRequestError] = useState('');
  // One search box for the three pages (kept when switching between them)
  const [search, setSearch] = useState('');
  // Sync pressed while not connected: start it as soon as the log-in is saved
  const [syncAfterConnect, setSyncAfterConnect] = useState(false);

  const loadData = useCallback(async () => {
    // The lists + notices, and what was read in each tender's documents (ps_tender_analysis, filled by
    // the keep-alive call every 5 minutes, see lib/psDocs.mjs)
    const [{ data: row, error }, { data: readings }, active] = await Promise.all([
      supabase.from('ps_philgeps_snapshot').select('synced_at, lists, notices').eq('id', 'latest').maybeSingle(),
      supabase.from('ps_tender_analysis').select('ref, status, result, documents_read, error, analyzed_at'),
      // Archived products show nowhere, even before the next Sync re-matches the notices
      loadActiveNames().catch(() => null),
    ]);
    if (error) setRequestError(`Could not load PS-PhilGEPS data: ${error.message}`);
    else if (row) {
      const analysis = Object.fromEntries((readings || []).map((r) => [r.ref, r]));
      setData(activePsData({ syncedAt: row.synced_at, lists: row.lists, notices: row.notices, analysis }, active));
    }
  }, []);

  const loadSync = useCallback(async () => {
    const { data: row } = await supabase.from('ps_sync_status').select('*').eq('id', 'latest').maybeSingle();
    if (row) setSync(row);
  }, []);

  const loadConnect = useCallback(async () => {
    try {
      const res = await fetch('/api/ps-philgeps');
      setConnect(res.ok ? (await res.json()).job : false);
    } catch {
      setConnect(false);
    }
  }, []);

  const syncing = sync?.status === 'running';
  const connecting = connect?.status === 'connecting';

  // Bottom-left progress ring, as on the PhilGEPS Dashboard: shown while a Sync runs (anyone's), then its
  // result for the run this page watched; a success hides itself after 6 s, a failure stays until closed
  const [watched, setWatched] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const startedAt = sync?.started_at;
  useEffect(() => {
    if (!syncing || !startedAt) return;
    const t = setTimeout(() => setWatched(startedAt), 0);
    return () => clearTimeout(t);
  }, [syncing, startedAt]);
  const finishedWatched = !syncing && watched && watched === startedAt && sync?.finished_at && dismissed !== watched;
  const ringJob = syncing
    ? { status: 'running', percent: sync.percent, stage: sync.stage || 'Starting' }
    : finishedWatched
      ? sync.status === 'success'
        ? { status: 'success', percent: 100, stage: sync.stage }
        : { status: 'failed', percent: sync.percent, stage: sync.stage, error: sync.error }
      : null;
  const ringDone = ringJob?.status === 'success';
  useEffect(() => {
    if (!ringDone) return;
    const t = setTimeout(() => setDismissed(watched), 6000);
    return () => clearTimeout(t);
  }, [ringDone, watched]);

  // Sync status: every 3 s while something runs, else every 30 s
  useEffect(() => {
    const first = setTimeout(() => {
      loadSync();
      loadConnect();
    }, 0);
    const timer = setInterval(() => {
      loadSync();
      loadConnect();
    }, syncing || connecting || syncAfterConnect ? 3000 : 30000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadSync, loadConnect, syncing, connecting, syncAfterConnect]);

  // Live updates (Supabase Realtime, schema.sql): the page changes the moment the Sync status moves, a Sync saves
  // its lists, or a tender's documents are read (incl. OCR of scanned ones), without a refresh. Bursts (an OCR
  // run saving many tenders) reload the data once, DATA_RELOAD_WAIT_MS after the last change.
  useEffect(() => {
    let reloadTimer;
    const reloadSoon = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadData, DATA_RELOAD_WAIT_MS);
    };
    const channel = supabase
      .channel('ps_philgeps_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ps_sync_status' }, (payload) => payload.new?.id && setSync(payload.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ps_philgeps_snapshot' }, reloadSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ps_tender_analysis' }, reloadSoon)
      .subscribe();
    return () => {
      clearTimeout(reloadTimer);
      supabase.removeChannel(channel);
    };
  }, [loadData]);

  // Data: on open, every 5 minutes (in case a live update was missed), and whenever a Sync finishes
  const finishedAt = sync?.finished_at;
  useEffect(() => {
    const first = setTimeout(loadData, 0);
    const timer = setInterval(loadData, 5 * 60000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadData, finishedAt]);

  const post = async (url, after) => {
    setRequestError('');
    try {
      const res = await authFetch(url, { method: 'POST' });
      const result = await res.json();
      if (!result.ok) setRequestError(result.error || `Could not start (${res.status})`);
      after();
    } catch (err) {
      setRequestError(err.message);
    }
  };
  const connected = Boolean(sync?.connected_at);

  const runSync = useCallback(() => post('/api/ps-sync', loadSync), [loadSync]);
  const pressSync = () => {
    if (connected) return runSync();
    setSyncAfterConnect(true);
    if (connect) post('/api/ps-philgeps', loadConnect);
    else window.location.href = 'ps-philgeps-connect:start';
  };

  // The log-in was saved (on this or another laptop): run the Sync that was asked for
  useEffect(() => {
    if (!syncAfterConnect || !connected) return;
    const start = setTimeout(() => {
      setSyncAfterConnect(false);
      runSync();
    }, 0);
    return () => clearTimeout(start);
  }, [syncAfterConnect, connected, runSync]);
  // A failed log-in window here ends the wait
  const connectFailed = connect?.status === 'failed';
  useEffect(() => {
    if (!connectFailed) return;
    const stop = setTimeout(() => setSyncAfterConnect(false), 0);
    return () => clearTimeout(stop);
  }, [connectFailed]);

  // New tenders (lib/newTenders.js): each Sync's lists are recorded; rows not seen before are new until read.
  // Bid Match counts only the tenders asking for our products.
  const news = useTenderNews();
  useEffect(() => {
    const lists = data?.lists;
    if (!lists) return;
    if (lists.bidMatch) registerList('bidMatch', lists.bidMatch.rows.map((row) => `ps:${psRefOf(row) || row.cells[0]}`));
    if (lists.opportunities) registerList('opportunities', lists.opportunities.rows.map((row) => `psopp:${row.cells[0]}`));
    if (lists.awards) registerList('awards', lists.awards.rows.map((row) => `psaward:${row.cells[0]}`));
  }, [data]);
  const ours = (row) => {
    const ref = psRefOf(row);
    return Boolean(data?.notices?.[ref]?.matched?.length || data?.analysis?.[ref]?.result?.items?.length);
  };
  const unreadBid = news.ready && data?.lists?.bidMatch ? data.lists.bidMatch.rows.filter((row) => ours(row) && news.isNewPs(`ps:${psRefOf(row) || row.cells[0]}`)).length : null;
  const unreadOpp = news.ready && data?.lists?.opportunities ? data.lists.opportunities.rows.filter((row) => news.isNewPs(`psopp:${row.cells[0]}`)).length : null;
  const unreadAward = news.ready && data?.lists?.awards ? data.lists.awards.rows.filter((row) => news.isNewPs(`psaward:${row.cells[0]}`)).length : null;
  useEffect(() => {
    if (unreadBid != null) reportUnread('/ps-philgeps', unreadBid);
    if (unreadOpp != null) reportUnread('/ps-philgeps/opportunities', unreadOpp);
    if (unreadAward != null) reportUnread('/ps-philgeps/awards', unreadAward);
  }, [unreadBid, unreadOpp, unreadAward]);

  return (
    <PsContext.Provider value={{ data, search, setSearch, reload: loadData, connected, syncing, sync }}>
      <div className="min-h-screen bg-white text-black antialiased">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <PageHeader
            title="PS-PhilGEPS Procurement Radar"
            subtitle="philgeps.gov.ph"
            status={
              !sync
                ? { tone: 'busy', text: 'Checking…' }
                : syncing
                  ? { tone: 'busy', text: `Syncing ${sync.percent || 0}%` }
                  : connected
                    ? { tone: 'ok', text: `Connected${data?.syncedAt ? ` · Sync ${formatInstant(data.syncedAt)}` : ''}` }
                    : { tone: 'error', text: 'Not connected' }
            }
            actions={
              <button
                onClick={pressSync}
                disabled={!sync || syncing || connecting || (syncAfterConnect && !connected)}
                title="Reads Bid Match (with notice details and documents), My Opportunities and Award Notices. Opens the PhilGEPS log-in first when it has ended."
                className={blueAction}
              >
                {syncing ? (
                  <>Syncing {sync.percent || 0}% <WorkingDots /></>
                ) : connecting || syncAfterConnect ? (
                  <>Waiting for log-in <WorkingDots /></>
                ) : (
                  '🔄 Sync PS-PhilGEPS'
                )}
              </button>
            }
          />

          {requestError && <Notice tone="error">{requestError}</Notice>}
          <ConnectNotice connect={connect} connected={connected} known={Boolean(sync)} waiting={syncAfterConnect} onCancel={() => setSyncAfterConnect(false)} />
          <SyncNotice sync={sync} ringShowing={Boolean(ringJob)} />
          <OcrHealthNotice />
          {children}
        </div>
      </div>
      <ScrapeProgress job={ringJob} onDismiss={() => setDismissed(watched)} />
    </PsContext.Provider>
  );
}

// Closes the Chrome log-in window and shows the log-in page inside the dashboard instead
const switchToLive = () =>
  authFetch('/api/ps-philgeps/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ switch: true }),
  }).catch(() => {});

// known: the Sync status has loaded (until then "not connected" isn't known yet)
function ConnectNotice({ connect, connected, known, waiting, onCancel }) {
  if (connect?.status === 'connecting' && connect.view === 'live') {
    return (
      <div className="space-y-3">
        <Notice>
          Below is the PS-PhilGEPS log-in page with everything filled in. Click &ldquo;I&rsquo;m not a robot&rdquo; on it
          (and the pictures, if Google asks). The log-in then finishes by itself and the Sync starts.
        </Notice>
        <PsLiveLogin />
      </div>
    );
  }
  if (connect?.status === 'connecting') {
    return (
      <Notice>
        The PhilGEPS log-in ended, so a small Google Chrome window opened with the log-in filled in (find it on the
        taskbar if it is behind this page). Tick &ldquo;I&rsquo;m not a robot&rdquo; there; the window closes and the
        Sync starts by itself.{' '}
        <button onClick={switchToLive} className="underline underline-offset-2 hover:text-[#0E5C7C]">
          Window not showing? Do the captcha here instead.
        </button>
      </Notice>
    );
  }
  if (connect?.status === 'failed' && !connected) return <Notice tone="error">Log-in failed: {connect.error}</Notice>;
  if (waiting && !connected) {
    return (
      <Notice>
        The PhilGEPS log-in ended, so it is opening on this laptop: if the browser asks to open{' '}
        <b>Connect PS-PhilGEPS</b>, allow it, then tick &ldquo;I&rsquo;m not a robot&rdquo; in the Chrome window. The Sync
        starts by itself once you are logged in.
        <span className="block mt-1.5 text-xs text-black/62">
          Nothing opened? This laptop needs a one-time setup: in the project folder run{' '}
          <code>node tools/register-connect-link.js</code> (or double-click <b>Connect PS-PhilGEPS</b> there).{' '}
          <button onClick={onCancel} className="underline underline-offset-2">Cancel</button>
        </span>
      </Notice>
    );
  }
  // PhilGEPS ended the shared log-in (the 5-minute keep-alive noticed): nothing new comes in until someone
  // reconnects, which needs a person for the captcha
  if (known && !connected) {
    return (
      <Notice tone="error">
        <b>Reconnect PS-PhilGEPS:</b> PhilGEPS ended the log-in, so no new PS-PhilGEPS data comes in and the lists below
        are from the last Sync. On a team laptop, press <b>Sync PS-PhilGEPS</b> and tick &ldquo;I&rsquo;m not a
        robot&rdquo;; everything continues by itself after that.
      </Notice>
    );
  }
  return null;
}

// Progress and results show in the bottom-left ring; this banner is only for a failed Sync the ring isn't
// showing (e.g. it failed before this page was opened)
function SyncNotice({ sync, ringShowing }) {
  if (sync?.status !== 'failed' || ringShowing) return null;
  return <Notice tone="error">Sync failed: {sync.error}</Notice>;
}

function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/6 text-[#12769F]',
    success: 'border-[#61A644]/25 bg-[#61A644]/8 text-[#3F6F2C]',
    error: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border p-3.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </div>
  );
}
