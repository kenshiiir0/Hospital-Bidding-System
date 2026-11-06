'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { authFetch } from '@/lib/authFetch';
import { supabase } from '@/lib/supabase';
import ScrapeProgress from '@/components/ScrapeProgress';
import { clearSync, followSync, philgepsRun, psRun, useSyncAlert } from '@/lib/syncAlerts';

// Always on screen (AuthGate): a Sync pressed in this browser (lib/syncAlerts.js) is followed while the person is
// on another page, and a failure shows here in the same card as the portal page's ring, until it is closed with ×.
// On the portal's own page its ring shows it instead. Checks only while such a Sync is still running, every
// CHECK_MS, so an idle dashboard costs nothing.
const CHECK_MS = 20 * 1000;
const PORTALS = {
  philgeps: {
    title: 'PhilGEPS',
    onOwnPage: (path) => path === '/',
    // GET /api/scrape: the current or last PhilGEPS fetch (Sync button or hourly update)
    read: async () => {
      const res = await authFetch('/api/scrape');
      if (!res.ok) return null;
      const job = await res.json();
      return philgepsRun(job);
    },
  },
  ps: {
    title: 'PS-PhilGEPS',
    // Its Bid Match is part of the merged Bid Match at /
    onOwnPage: (path) => path === '/' || path.startsWith('/ps-philgeps'),
    read: async () => {
      const { data: row } = await supabase.from('ps_sync_status').select('status, error, stage, percent, started_at, started_by').eq('id', 'latest').maybeSingle();
      return psRun(row);
    },
  },
};

// One check of a followed Sync (offline or server busy: try again next time)
async function check(portal) {
  try {
    followSync(portal, await PORTALS[portal].read());
  } catch {}
}

export default function SyncAlertHost() {
  const path = usePathname() || '';
  const philgeps = useSyncAlert('philgeps');
  const ps = useSyncAlert('ps');
  const awayPhilgeps = !PORTALS.philgeps.onOwnPage(path);
  const awayPs = !PORTALS.ps.onOwnPage(path);

  // Follow a running Sync only while its own page (which follows it itself) isn't open
  const followPhilgeps = awayPhilgeps && philgeps?.status === 'running';
  const followPs = awayPs && ps?.status === 'running';
  useEffect(() => {
    if (!followPhilgeps && !followPs) return;
    const run = () => {
      if (followPhilgeps) check('philgeps');
      if (followPs) check('ps');
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, CHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [followPhilgeps, followPs]);

  const cards = [
    awayPhilgeps && philgeps?.status === 'failed' && { portal: 'philgeps', alert: philgeps },
    awayPs && ps?.status === 'failed' && { portal: 'ps', alert: ps },
  ].filter(Boolean);
  if (!cards.length) return null;
  // Both portals failed: the two cards stack in the bottom-left corner
  return (
    <div className="fixed bottom-5 left-5 z-40 flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2">
      {cards.map(({ portal, alert }) => (
        <ScrapeProgress
          key={portal}
          inline
          job={{ status: 'failed', percent: alert.percent, stage: alert.stage, error: alert.error }}
          name={PORTALS[portal].title}
          onDismiss={() => clearSync(portal, alert.startedAt)}
        />
      ))}
    </div>
  );
}
