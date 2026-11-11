'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatInstant, instantDay } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';
import { blueAction, plainAction } from '@/components/PageHeader';
import { PsContext } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsConnectModal from '@/components/PsConnectModal';
import { clearSync, failSync, followSync, pressedSync, psRun, useSyncAlert } from '@/lib/syncAlerts';
import { activePsData, loadActiveNames } from '@/lib/activeProducts';
import { registerList, reportUnread, useTenderNews } from '@/lib/newTenders';
import { psRefOf } from '@/lib/opportunityWorkbook';

// PS-PhilGEPS for the pages that show it (the merged Bid Match at /, My Opportunities, Award Notices), on the
// deployed dashboard and on team computers alike. The provider holds the state; each page places the pieces
// (usePsPhilgeps().portal: header status, Reload and Sync buttons, notices, progress ring and bar):
// - data: the last Sync's result (Supabase ps_philgeps_snapshot),
// - sync: Sync status for the whole team (Supabase ps_sync_status; connected_at = a saved session exists),
//   started with POST /api/ps-sync (runs on the server, no browser),
// - one button: when the PhilGEPS log-in has ended, Sync first opens the log-in (Google's captcha needs a
//   real browser) on this laptop: through POST /api/ps-philgeps where the dashboard runs on this computer,
//   else through the "ps-philgeps-connect:" link (set up once per laptop by tools/register-connect-link.js,
//   runs "Connect PS-PhilGEPS.cmd"). Once the session is saved the Sync starts by itself.
// Wait after the last live change before reloading the data (one reload for a burst of changes)
const DATA_RELOAD_WAIT_MS = 2000;

export function PsPortalProvider({ children }) {
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

  // The header's Reload button (as on the PhilGEPS page)
  const [reloading, setReloading] = useState(false);
  const reloadNow = async () => {
    setReloading(true);
    await loadData().catch(() => {});
    setReloading(false);
  };

  const loadSync = useCallback(async () => {
    const { data: row } = await supabase.from('ps_sync_status').select('*').eq('id', 'latest').maybeSingle();
    if (row) setSync(row);
  }, []);

  const loadConnect = useCallback(async () => {
    try {
      const res = await authFetch('/api/ps-philgeps');
      setConnect(res.ok ? (await res.json()).job : false);
    } catch {
      setConnect(false);
    }
  }, []);

  const syncing = sync?.status === 'running';
  // starting: the cloud log-in browser is being started (any device, lib/psCloudConnect.mjs)
  const connecting = connect?.status === 'connecting' || connect?.status === 'starting';

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
  // The ring's Cancel button (DELETE /api/ps-sync): the Sync stops before its next page and saves nothing;
  // PS-PhilGEPS stays connected. cancelFor: the Sync it was pressed for, shown as cancelling until it ends.
  const [cancelFor, setCancelFor] = useState(null);
  const syncJob = syncing
    ? { status: 'running', percent: sync.percent, stage: sync.stage || 'Starting', cancelling: cancelFor === startedAt || /^Cancelling/.test(sync.stage || '') }
    : finishedWatched
      ? sync.status === 'success'
        ? { status: 'success', percent: 100, stage: sync.stage }
        : sync.status === 'cancelled'
          ? { status: 'cancelled', percent: sync.percent, stage: sync.stage }
          : { status: 'failed', percent: sync.percent, stage: sync.stage, error: sync.error }
      : null;
  // The hourly Sync (started by the Supabase schedule) shows as the thin bar along the bottom, as the PhilGEPS
  // hourly update does; a Sync someone pressed keeps the ring
  const scheduled = sync?.started_by === 'schedule';
  // A failed Sync not closed yet, also when it ended while another page was open (lib/syncAlerts.js)
  const savedSync = useSyncAlert('ps');
  const savedFailure = savedSync?.status === 'failed' ? { status: 'failed', percent: savedSync.percent, stage: savedSync.stage, error: savedSync.error } : null;
  const ringJob = (scheduled ? null : syncJob) || savedFailure;
  // The ring's ×: a failure closed here is closed on every page
  const closeRing = () => {
    setDismissed(watched);
    if (savedSync?.status === 'failed') clearSync('ps', savedSync.startedAt);
  };
  // Kept for the other pages: a failure stays on screen there until closed (components/SyncAlertHost.js)
  useEffect(() => {
    if (sync) followSync('ps', psRun(sync));
  }, [sync]);
  const barJob = scheduled ? syncJob : null;
  const ringDone = syncJob?.status === 'success';
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

  // Followed from the press on, so a failure shows on whatever page is open (lib/syncAlerts.js)
  const runSync = useCallback(async () => {
    pressedSync('ps');
    setRequestError('');
    try {
      const res = await authFetch('/api/ps-sync', { method: 'POST' });
      const result = await res.json();
      if (!result.ok) failSync('ps', { error: result.error || `Could not start (${res.status})` });
    } catch (err) {
      failSync('ps', { error: err.message });
    }
    loadSync();
  }, [loadSync]);
  const cancelSync = async () => {
    if (!window.confirm('Cancel the PS-PhilGEPS Sync? Nothing is changed and PS-PhilGEPS stays connected.')) return;
    setCancelFor(startedAt);
    setRequestError('');
    try {
      const res = await authFetch('/api/ps-sync', { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error || `Could not cancel (${res.status})`);
    } catch (err) {
      setCancelFor(null);
      setRequestError(`The Sync could not be cancelled: ${err.message}`);
    }
    loadSync();
  };
  const pressSync = () => {
    if (connected) return runSync();
    setSyncAfterConnect(true);
    // The office log-in laptop, when it is on, serves every device (lib/psCloudConnect.mjs), pop-up choice or not
    if (connect && (connect.hostOnline || !popupHere())) post('/api/ps-philgeps', loadConnect);
    else openPopupLogin().catch((err) => setRequestError(`The log-in could not be opened: ${err.message}`));
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
  // Today's Philippine date, read in the browser after mount and every minute (rolls over at midnight; reading
  // the clock while rendering would differ between the server and the browser), as on the PhilGEPS page
  const [today, setToday] = useState('');
  useEffect(() => {
    const update = () => setToday(instantDay(new Date().toISOString()));
    Promise.resolve().then(update);
    const timer = setInterval(update, 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  // Bid Match tenders for our products published today (Philippine date), as the PhilGEPS header counts them
  const bidMatch = data?.lists?.bidMatch;
  const newToday = bidMatch && today ? bidMatch.rows.filter((row) => ours(row) && psDay(row.cells[bidMatch.headers.indexOf('Publish Date')]) === today).length : 0;
  const unreadBid = news.ready && data?.lists?.bidMatch ? data.lists.bidMatch.rows.filter((row) => ours(row) && news.isNewPs(`ps:${psRefOf(row) || row.cells[0]}`)).length : null;
  const unreadOpp = news.ready && data?.lists?.opportunities ? data.lists.opportunities.rows.filter((row) => news.isNewPs(`psopp:${row.cells[0]}`)).length : null;
  const unreadAward = news.ready && data?.lists?.awards ? data.lists.awards.rows.filter((row) => news.isNewPs(`psaward:${row.cells[0]}`)).length : null;
  useEffect(() => {
    if (unreadBid != null) reportUnread('/ps-philgeps', unreadBid);
    if (unreadOpp != null) reportUnread('/ps-philgeps/opportunities', unreadOpp);
    if (unreadAward != null) reportUnread('/ps-philgeps/awards', unreadAward);
  }, [unreadBid, unreadOpp, unreadAward]);

  const status = !sync
    ? { tone: 'busy', text: 'Checking…' }
    : syncing
      ? { tone: 'busy', text: `Syncing ${sync.percent || 0}%` }
      : connected
        ? { tone: 'ok', text: `Connected${data?.syncedAt ? ` · Sync ${formatInstant(data.syncedAt)}` : ''}` }
        : { tone: 'error', text: 'Not connected' };
  // Reload (from the database) and Sync, as on the PhilGEPS side
  const reloadButton = (
    <button onClick={reloadNow} disabled={reloading} title="Reload the PS-PhilGEPS lists from the database without contacting PhilGEPS" className={plainAction}>
      {reloading ? <>Reloading <WorkingDots /></> : '↻ Reload'}
    </button>
  );
  const syncButton = (
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
  );
  const notices = (
    <>
      {requestError && <Notice tone="error">{requestError}</Notice>}
      <ConnectNotice connect={connect} connected={connected} known={Boolean(sync)} waiting={syncAfterConnect} onCancel={() => setSyncAfterConnect(false)} />
      <SyncNotice sync={sync} ringShowing={Boolean(syncJob || savedFailure)} />
    </>
  );
  const portal = { status, newToday, reloadNow, reloading, reloadButton, syncButton, notices, ringJob, barJob, cancelSync, closeRing, dismissBar: () => setDismissed(watched) };

  return <PsContext.Provider value={{ data, search, setSearch, reload: loadData, connected, syncing, sync, portal }}>{children}</PsContext.Provider>;
}

// Closes the Chrome log-in window and shows the log-in page inside the dashboard instead
// Cancel button of the log-in dialog (stops the cloud log-in, lib/psCloudConnect.mjs)
// A team laptop that chose the pop-up (PsConnectModal "Use the pop-up on this computer"): its log-ins open in a
// Chrome window here (tools/register-connect-link.js), the cloud log-in elsewhere. Kept in this browser only
const POPUP_KEY = 'ps-connect-popup';
const popupHere = () => {
  try {
    return localStorage.getItem(POPUP_KEY) === '1';
  } catch {
    return false;
  }
};
const switchToPopup = () => {
  try {
    localStorage.setItem(POPUP_KEY, '1');
  } catch {}
  cancelConnect().finally(() => openPopupLogin().catch(() => {}));
};

// Opens the pop-up log-in on this laptop: the link carries a one-time code (15 minutes) for the signed-in person,
// with which the laptop gets the log-in from the dashboard and hands the session back (api/ps-philgeps/laptop)
async function openPopupLogin() {
  const res = await authFetch('/api/ps-philgeps/laptop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'code' }),
  });
  const result = await res.json().catch(() => ({}));
  if (!result.ok) throw new Error(result.error || `Could not start (${res.status})`);
  window.location.href = `ps-philgeps-connect:start?code=${encodeURIComponent(result.code)}`;
}

// "Set up this laptop" (log-in dialog): downloads the setup file made for the signed-in person (it can download the
// log-in files for 60 minutes) and remembers that this browser uses the pop-up from now on
export async function downloadLaptopSetup() {
  const res = await authFetch('/api/ps-philgeps/laptop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setup' }),
  });
  const result = await res.json().catch(() => ({}));
  if (!result.ok) throw new Error(result.error || `Could not prepare the setup (${res.status})`);
  const url = URL.createObjectURL(new Blob([result.script], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Set up PS-PhilGEPS log-in.cmd';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  try {
    localStorage.setItem(POPUP_KEY, '1');
  } catch {}
}

const cancelConnect = () =>
  authFetch('/api/ps-philgeps/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel: true }),
  }).catch(() => {});

const switchToLive = () =>
  authFetch('/api/ps-philgeps/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ switch: true }),
  }).catch(() => {});

// known: the Sync status has loaded (until then "not connected" isn't known yet)
function ConnectNotice({ connect, connected, known, waiting, onCancel }) {
  // The log-in shown in a dialog (PsConnectModal): while it starts, then its live picture. hidden: the log-in the
  // person closed the dialog of (it keeps waiting; the notice reopens it)
  const [hidden, setHidden] = useState(null);
  const inDialog = connect?.status === 'starting' || (connect?.status === 'connecting' && connect.view === 'live');
  if (inDialog) {
    const key = connect.id || connect.startedAt || 'live';
    if (hidden !== key) return <PsConnectModal connect={connect} onHide={() => setHidden(key)} onCancel={() => cancelConnect().then(() => setHidden(key))} onPopup={connect.hostOnline ? null : () => { setHidden(key); switchToPopup(); }} onSetup={connect.hostOnline ? null : downloadLaptopSetup} />;
    return (
      <Notice>
        The PS-PhilGEPS log-in is waiting for you to confirm you are not a robot.{' '}
        <button onClick={() => setHidden(null)} className="font-semibold underline underline-offset-2 hover:text-[#0E5C7C]">
          Open it
        </button>
      </Notice>
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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "3-Nov-2026 12:01 AM" -> "2026-11-03" (PS-PhilGEPS writes Philippine times)
export function psDay(text) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(text || '').trim());
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

// "17-Nov-2026 09:30 AM" -> "2026-11-17T09:30" (sorts with PhilGEPS's "2026-11-17T09:30:00")
export function psDateTime(text) {
  const day = psDay(text);
  if (!day) return '';
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(text));
  if (!t) return day;
  const hour = (Number(t[1]) % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${t[2]}`;
}
