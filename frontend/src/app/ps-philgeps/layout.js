'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';
import { PsContext } from '@/lib/psContext';
import { supabase } from '@/lib/supabase';
import PsLiveLogin from '@/components/PsLiveLogin';

// Shared by the PS-PhilGEPS pages (Bid Match, My Opportunities, Award Notices), on the deployed dashboard
// and on team computers alike:
// - data: the last Sync's result (Supabase ps_philgeps_snapshot),
// - sync: Sync status for the whole team (Supabase ps_sync_status; connected_at = a saved session exists),
//   started with POST /api/ps-sync (runs on the server, no browser),
// - connect: only where the dashboard runs on a team computer (GET/POST /api/ps-philgeps opens the Chrome
//   log-in window there). On the deployed dashboard that route refuses, and the page says how to connect.
export default function PsPhilgepsLayout({ children }) {
  const [data, setData] = useState(null);
  const [sync, setSync] = useState(null);
  // null = not checked yet, false = this dashboard can't open a log-in window (deployed copy)
  const [connect, setConnect] = useState(null);
  const [requestError, setRequestError] = useState('');

  const loadData = useCallback(async () => {
    const { data: row, error } = await supabase.from('ps_philgeps_snapshot').select('synced_at, lists, notices').eq('id', 'latest').maybeSingle();
    if (error) setRequestError(`Could not load PS-PhilGEPS data: ${error.message}`);
    else if (row) setData({ syncedAt: row.synced_at, lists: row.lists, notices: row.notices });
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

  // Sync status: every 3 s while something runs, else every 30 s
  useEffect(() => {
    const first = setTimeout(() => {
      loadSync();
      loadConnect();
    }, 0);
    const timer = setInterval(() => {
      loadSync();
      loadConnect();
    }, syncing || connecting ? 3000 : 30000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadSync, loadConnect, syncing, connecting]);

  // Data: on open, every 5 minutes, and whenever a Sync finishes
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
  const startSync = () => post('/api/ps-sync', loadSync);
  const startConnect = () => post('/api/ps-philgeps', loadConnect);

  const connected = Boolean(sync?.connected_at);

  return (
    <PsContext.Provider value={{ data }}>
      <div className="min-h-screen bg-white text-black antialiased">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#1EA0DA]" aria-hidden />
                PS-PhilGEPS
              </h1>
              <p className="text-xs text-black/62 mt-1">
                philgeps.gov.ph · {!sync ? 'Checking…' : connected ? `Connected since ${formatInstant(sync.connected_at)}` : 'Not connected'}
                {data?.syncedAt && ` · Last sync ${formatInstant(data.syncedAt)}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {!connected && connect && (
                <button
                  onClick={startConnect}
                  disabled={connecting}
                  className="inline-flex items-center justify-center gap-2 bg-white hover:bg-[#1EA0DA]/6 text-[#12769F] border border-[#1EA0DA]/25 disabled:cursor-wait px-4 py-2 rounded-full text-sm font-medium transition"
                >
                  {connecting ? <>Waiting for captcha <WorkingDots /></> : '🔑 Connect PS-PhilGEPS'}
                </button>
              )}
              <button
                onClick={startSync}
                disabled={!connected || syncing}
                title={connected ? 'Reads Bid Match (with notice details and documents), My Opportunities and Award Notices.' : 'Connect PS-PhilGEPS first.'}
                className={`inline-flex items-center justify-center gap-2 bg-[#1EA0DA] hover:bg-[#12769F] disabled:opacity-70 ${syncing ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'} text-white px-4 py-2 rounded-full text-sm font-medium transition`}
              >
                {syncing ? <>Syncing {sync.percent || 0}% <WorkingDots /></> : '🔄 Sync PS-PhilGEPS'}
              </button>
            </div>
          </header>

          {requestError && <Notice tone="error">{requestError}</Notice>}
          <ConnectNotice sync={sync} connect={connect} connected={connected} />
          <SyncNotice sync={sync} />
          {children}
        </div>
      </div>
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

function ConnectNotice({ sync, connect, connected }) {
  if (connect?.status === 'connecting' && connect.view === 'live') {
    return (
      <div className="space-y-3">
        <Notice>
          Below is the PS-PhilGEPS log-in page with everything filled in. Click &ldquo;I&rsquo;m not a robot&rdquo; on it
          (and the pictures, if Google asks). The log-in then finishes by itself.
        </Notice>
        <PsLiveLogin />
      </div>
    );
  }
  if (connect?.status === 'connecting') {
    return (
      <Notice>
        A small Google Chrome window opened with the PS-PhilGEPS log-in filled in (find it on the taskbar if it is
        behind this page). Tick &ldquo;I&rsquo;m not a robot&rdquo; there; the log-in finishes by itself and the window
        closes.{' '}
        <button onClick={switchToLive} className="underline underline-offset-2 hover:text-[#0E5C7C]">
          Window not showing? Do the captcha here instead.
        </button>
      </Notice>
    );
  }
  if (connect?.status === 'failed' && !connected) return <Notice tone="error">Connect failed: {connect.error}</Notice>;
  if (!sync || connected) return null;
  if (connect) return <Notice>PS-PhilGEPS is not connected. Press Connect PS-PhilGEPS and tick the captcha; then Sync.</Notice>;
  return (
    <Notice>
      PS-PhilGEPS is not connected (PhilGEPS ends the log-in after a while). The log-in needs Google&rsquo;s captcha in a
      real browser, so it is done on a team laptop: double-click <b>Connect PS-PhilGEPS</b> in the project folder and
      tick &ldquo;I&rsquo;m not a robot&rdquo;. After that, Sync works here.
    </Notice>
  );
}

function SyncNotice({ sync }) {
  if (!sync || sync.status === 'idle') return null;
  if (sync.status === 'running') return <Notice>{sync.stage || 'Starting'}</Notice>;
  if (sync.status === 'failed') return <Notice tone="error">Sync failed: {sync.error}</Notice>;
  return <Notice tone="success">{sync.stage}</Notice>;
}

function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/6 text-[#12769F]',
    success: 'border-[#61A644]/25 bg-[#61A644]/10 text-[#3F6F2C]',
    error: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-[14px] border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}
