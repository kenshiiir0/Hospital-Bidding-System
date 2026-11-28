import { supabase } from '@/lib/supabase';
import { createAsker } from '@/lib/liveAsk.mjs';

// Live updates for the pages: a table's changes reach the page without a refresh.
// Today (Supabase): Supabase Realtime, as before. With the private database (NEXT_PUBLIC_DATA_VIA_SERVER=1) there is
// no Realtime, so the page asks our server every few seconds for what changed since it last asked, through the same
// supabase.from() (/api/data), and hands each changed row to the same handler as a Realtime message ({ new: row }).
// The asking stops while the tab is hidden and starts again at once when it is shown.
//
// watchTables(name, [{ table, event, onChange, since, select, filter, everyMs }]) -> stop()
// - event: 'INSERT' | 'UPDATE' | '*' (Realtime only; asking can't tell an insert from an update)
// - since: the column that grows with every change (updated_at, analyzed_at, id); only rows past the last one seen
//   come back. Without it (one-row tables: ps_sync_status, ocr_status) the row(s) are asked for whole and handed on
//   when they differ from last time.
// - select: the columns the handler needs (default all), filter: (query) => query.eq(...), everyMs: how often.

export const LIVE_BY_ASKING = process.env.NEXT_PUBLIC_DATA_VIA_SERVER === '1';

export function watchTables(name, watches) {
  if (!LIVE_BY_ASKING) {
    let channel = supabase.channel(name);
    for (const w of watches) channel = channel.on('postgres_changes', { event: w.event || '*', schema: 'public', table: w.table }, w.onChange);
    channel.subscribe();
    return () => supabase.removeChannel(channel);
  }
  const askers = watches.map((w) => createAsker(supabase, w));
  const shown = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  const tick = () => {
    if (shown()) for (const a of askers) a.ask();
  };
  const onVisible = () => {
    if (shown()) for (const a of askers) a.ask(true);
  };
  tick();
  const timer = setInterval(tick, Math.min(...askers.map((a) => a.everyMs)));
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
