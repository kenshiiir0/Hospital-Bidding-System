import { createClient } from '@supabase/supabase-js';

// One entry on the History page (table activity_log), written by the server-side Syncs:
// event 'documents' (PhilGEPS Sync, philgepsSync.mjs) or 'ps-sync' (PS-PhilGEPS Sync, psSync.mjs); the public
// PhilGEPS update (scraper.js) writes 'scrape'. by: who started it (an email, or 'schedule'). Never throws.
export async function logActivity({ event, status, by, summary, details }) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) return;
  const supabase = createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const trigger = by === 'schedule' ? 'schedule' : 'dashboard';
  await supabase
    .from('activity_log')
    .insert({ event, status, trigger, summary, details: { ...(details || {}), started_by: by && by !== 'schedule' ? by : null } })
    .then(
      () => {},
      () => {}
    );
}
