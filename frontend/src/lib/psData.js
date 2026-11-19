'use client';

import { supabase } from '@/lib/supabase';

// PS-PhilGEPS data on the dashboard, kept once per open tab and brought up to date with only what changed
// (user 2026-11-19, Supabase egress over the free plan: "load only what changed"). Shared by the Bid Match,
// the PS-PhilGEPS pages (components/PsPortal.js) and Screened Tenders (lib/screened.js), so moving between them
// loads nothing again.
// - The lists + notices (ps_philgeps_snapshot, ~1 MB): loaded again only when its updated_at moved (a Sync, an
//   award answered), checked with a few bytes.
// - The document readings (ps_tender_analysis, ~1.7 MB): all of them once, then only those read since
//   (analyzed_at), plus the ones arriving live (mergePsReading).
// Before: both whole on every page opened, every Sync finished (twice: the Sync's end and the live message) and
// every 30 minutes, in every open tab.

const READING_COLUMNS = 'ref, status, result, documents_read, error, analyzed_at';

let snapshot = null; // { updated_at, synced_at, lists, notices }
let readings = null; // Map ref -> reading
let readingsSince = null; // the newest analyzed_at seen
let loadingSnapshot = null;
let loadingReadings = null;

const newest = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** { synced_at, lists, notices }, loaded again only when changed. Throws on a failed load. */
export function psSnapshot() {
  loadingSnapshot ||= (async () => {
    const { data: stamp, error } = await supabase.from('ps_philgeps_snapshot').select('updated_at').eq('id', 'latest').maybeSingle();
    if (error) throw new Error(error.message);
    if (!stamp) return null;
    if (snapshot?.updated_at !== stamp.updated_at) {
      const { data, error: loadError } = await supabase.from('ps_philgeps_snapshot').select('updated_at, synced_at, lists, notices').eq('id', 'latest').maybeSingle();
      if (loadError) throw new Error(loadError.message);
      snapshot = data;
    }
    return snapshot;
  })().finally(() => {
    loadingSnapshot = null;
  });
  return loadingSnapshot;
}

/** Every reading by ref: all once, then only the ones read since the last load */
export function psReadings() {
  loadingReadings ||= (async () => {
    let query = supabase.from('ps_tender_analysis').select(READING_COLUMNS);
    if (readings && readingsSince) query = query.gte('analyzed_at', readingsSince);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!readings) readings = new Map();
    for (const r of data || []) {
      readings.set(r.ref, r);
      readingsSince = newest(readingsSince, r.analyzed_at);
    }
    return Object.fromEntries(readings);
  })().finally(() => {
    loadingReadings = null;
  });
  return loadingReadings;
}

/** A reading that arrived live (Supabase Realtime), kept so the next page opened has it */
export function mergePsReading(row) {
  if (!row?.ref || !readings) return;
  readings.set(row.ref, row);
}
