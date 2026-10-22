'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';
import { PsContext } from '@/lib/psContext';
import PsLiveLogin from '@/components/PsLiveLogin';

// Shared by the PS-PhilGEPS pages (Bid Match, My Opportunities, Award Notices): connection + Sync status
// and the last Sync's data from GET /api/ps-philgeps?data=1, polled once here for all three pages.

export default function PsPhilgepsLayout({ children }) {
  const [status, setStatus] = useState(null);
  const [requestError, setRequestError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ps-philgeps?data=1');
      if (res.ok) setStatus(await res.json());
    } catch {}
  }, []);

  const running = ['connecting', 'syncing'].includes(status?.job?.status);

  // Every 2 s while a Sync runs, else every minute
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, running ? 2000 : 60000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, running]);

  const sync = async () => {
    setRequestError('');
    try {
      const res = await authFetch('/api/ps-philgeps', { method: 'POST' });
      const result = await res.json();
      if (!result.ok) setRequestError(result.error || `Could not start (${res.status})`);
      else setStatus((prev) => ({ ...prev, ...result }));
    } catch (err) {
      setRequestError(err.message);
    }
  };

  return (
    <PsContext.Provider value={{ status, data: status?.data }}>
      <div className="min-h-screen bg-white text-black antialiased">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-black flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#1EA0DA]" aria-hidden />
                PS-PhilGEPS
              </h1>
              <p className="text-xs text-black/62 mt-1">
                philgeps.gov.ph ·{' '}
                {status?.connected ? `Connected since ${formatInstant(status.connectedAt)}` : 'Not connected'}
                {status?.data?.syncedAt && ` · Last sync ${formatInstant(status.data.syncedAt)}`}
              </p>
            </div>
            <button
              onClick={sync}
              disabled={!status || running}
              title="Reads Bid Match (with notice details and documents), My Opportunities and Award Notices. Asks for the captcha first when not connected."
              className="inline-flex items-center justify-center gap-2 bg-[#1EA0DA] hover:bg-[#12769F] disabled:opacity-70 disabled:cursor-wait text-white px-4 py-2 rounded-full text-sm font-medium transition"
            >
              {status?.job?.status === 'connecting' ? (
                <>Waiting for captcha <WorkingDots /></>
              ) : status?.job?.status === 'syncing' ? (
                <>Syncing {status.job.percent || 0}% <WorkingDots /></>
              ) : status?.connected ? (
                '🔄 Sync PS-PhilGEPS'
              ) : (
                '🔄 Connect & Sync PS-PhilGEPS'
              )}
            </button>
          </header>

          <SyncNotice job={status?.job} requestError={requestError} />
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

function SyncNotice({ job, requestError }) {
  if (requestError) return <Notice tone="error">{requestError}</Notice>;
  if (!job || job.status === 'idle') return null;
  if (job.status === 'connecting' && job.view === 'live') {
    return (
      <div className="space-y-3">
        <Notice>
          Below is the PS-PhilGEPS log-in page with everything filled in. Click &ldquo;I&rsquo;m not a robot&rdquo; on
          it (and the pictures, if Google asks). The log-in then finishes by itself and the Sync continues.
        </Notice>
        <PsLiveLogin />
      </div>
    );
  }
  if (job.status === 'connecting') {
    return (
      <Notice>
        A small Google Chrome window opened with the PS-PhilGEPS log-in filled in (find it on the taskbar if it
        is behind this page). Tick &ldquo;I&rsquo;m not a robot&rdquo; there; the log-in finishes by itself, the
        window closes and the Sync continues.{' '}
        <button onClick={switchToLive} className="underline underline-offset-2 hover:text-[#0E5C7C]">
          Window not showing? Do the captcha here instead.
        </button>
      </Notice>
    );
  }
  if (job.status === 'syncing') return <Notice>{job.stage}</Notice>;
  if (job.status === 'failed') return <Notice tone="error">Sync failed: {job.error}</Notice>;
  return <Notice tone="success">{job.stage}</Notice>;
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
