'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import { downloadOpportunityWorkbook, philgepsTender, psRefOf, psTender } from '@/lib/opportunityWorkbook';
import { activePsData, loadActiveNames } from '@/lib/activeProducts';

// Screened Tenders (Supabase screened_tenders, shared by the team): tenders picked with "Add to Screened" in
// View details. The Screened Tenders page lists them and exports them to Excel.
// A plain module store: every Add/Remove button and the page read the same rows.
// A row is { source: 'philgeps' | 'ps', ref, title, tender, added_by, added_at }.

let rows = null;
let error = '';
let loading = null;
const listeners = new Set();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const screenedKey = (source, ref) => `${source}:${ref}`;

export function loadScreened() {
  loading ||= supabase
    .from('screened_tenders')
    .select('*')
    .order('added_at', { ascending: false })
    .then(({ data, error: err }) => {
      if (err) error = `Could not load the screened tenders: ${err.message}`;
      else {
        rows = data;
        error = '';
      }
      loading = null;
      notify();
    });
  return loading;
}

// { rows (null until loaded), error, has(source, ref) }; loads the list when first used
let snapshot = { rows, error };
const getSnapshot = () => {
  if (snapshot.rows !== rows || snapshot.error !== error) snapshot = { rows, error };
  return snapshot;
};
const serverSnapshot = { rows: null, error: '' };
export function useScreened() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
  useEffect(() => {
    if (!rows) loadScreened();
  }, []);
  const keys = new Set((state.rows || []).map((r) => screenedKey(r.source, r.ref)));
  return { ...state, has: (source, ref) => keys.has(screenedKey(source, ref)) };
}

// tender: the tender in export shape (philgepsTender / psTender); products: our products it asks for (kept
// with it for the page's "Our product" filter)
export async function addScreened(source, ref, title, tender, products = []) {
  const { error: err } = await supabase.from('screened_tenders').insert({ source, ref, title, tender: { ...tender, products } });
  // Someone else added it a moment ago: it is screened either way
  if (err && err.code !== '23505') throw new Error(err.message);
  await loadScreened();
}

export async function removeScreened(source, ref) {
  const { error: err } = await supabase.from('screened_tenders').delete().eq('source', source).eq('ref', ref);
  if (err) throw new Error(err.message);
  await loadScreened();
}

// PS-PhilGEPS Bid Match: the last Sync's list, notices and document readings (as app/ps-philgeps/layout.js loads them)
async function loadPsData() {
  const [{ data: snap, error: err }, { data: readings }] = await Promise.all([
    supabase.from('ps_philgeps_snapshot').select('synced_at, lists, notices').eq('id', 'latest').maybeSingle(),
    supabase.from('ps_tender_analysis').select('ref, status, result, documents_read, error, analyzed_at'),
  ]);
  if (err) throw new Error(`Could not load PS-PhilGEPS data: ${err.message}`);
  const active = await loadActiveNames().catch(() => null);
  return activePsData(
    { syncedAt: snap?.synced_at, lists: snap?.lists || {}, notices: snap?.notices || {}, analysis: Object.fromEntries((readings || []).map((r) => [r.ref, r])) },
    active
  );
}

// What View details on the Screened Tenders page opens for a screened row:
// { kind: 'philgeps', bid } (the PhilGEPS Dashboard's drawer), { kind: 'ps', data, row } (Bid Match's drawer),
// or { kind: 'saved' } when the tender is no longer in the latest update / Sync (only the saved copy is left)
export async function loadScreenedDetails(r) {
  if (r.source === 'philgeps') {
    const { data, error: err } = await supabase.from('philgeps_opportunities').select('*').eq('ref_no', r.ref).limit(1);
    if (err) throw new Error(`Could not load the tender: ${err.message}`);
    return data?.[0] ? { kind: 'philgeps', bid: data[0] } : { kind: 'saved' };
  }
  const data = await loadPsData();
  const row = (data.lists?.bidMatch?.rows || []).find((x) => psRefOf(x) === r.ref);
  return row ? { kind: 'ps', data, row } : { kind: 'saved' };
}

// The stored copy's dates come back from JSON as text; the workbook needs Date objects
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;
// Copies saved before 2026-10-24 may start molecule cells with a stock code ("55100000. "); only line numbers
// of up to 4 digits are kept, as in the export (opportunityWorkbook.js itemRow)
const STOCK_CODE = /^(?:\d{5,}|[A-Z]+\d+)\.\s*/;
const revive = (tender) => ({
  ...tender,
  molecules: (tender.molecules || []).map((cells) => cells.map((cell) => (typeof cell === 'string' ? cell.replace(STOCK_CODE, '') : cell))),
  closing: ISO_TIME.test(tender.closing || '') ? new Date(tender.closing) : tender.closing,
  lastUpdated: ISO_TIME.test(tender.lastUpdated || '') ? new Date(tender.lastUpdated) : tender.lastUpdated,
});

// Each screened tender as it is now (the latest PhilGEPS update / PS-PhilGEPS Sync, with what was read in its
// documents since), else as it was when added
async function currentTenders(list) {
  const philgepsRefs = list.filter((r) => r.source === 'philgeps').map((r) => r.ref);
  const [philgeps, ps] = await Promise.all([
    philgepsRefs.length
      ? supabase.from('philgeps_opportunities').select('*').in('ref_no', philgepsRefs).then(({ data }) => data || [])
      : [],
    list.some((r) => r.source === 'ps') ? loadPsData().catch(() => null) : null,
  ]);
  const bids = Object.fromEntries(philgeps.map((bid) => [bid.ref_no, bid]));
  const bidMatch = ps?.lists?.bidMatch;
  const psRows = Object.fromEntries((bidMatch?.rows || []).map((row) => [psRefOf(row), row]));
  return list.map((r) => {
    if (r.source === 'philgeps' && bids[r.ref]) return philgepsTender(bids[r.ref]);
    if (r.source === 'ps' && psRows[r.ref]) return psTender(psRows[r.ref], bidMatch.headers, ps.notices[r.ref], ps.analysis[r.ref]);
    return revive(r.tender);
  });
}

// The team's Opportunity sheet for these screened rows, stacked in the order they were screened: the first
// screened at the top, the latest at the bottom (so each day's additions land under the earlier ones)
export async function exportScreened(list) {
  const inScreenedOrder = [...list].sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)));
  const tenders = await currentTenders(inScreenedOrder);
  await downloadOpportunityWorkbook(tenders);
  return tenders.length;
}
