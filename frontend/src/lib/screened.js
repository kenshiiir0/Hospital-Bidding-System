'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import { downloadOpportunityWorkbook, moleculeText, philgepsTender, PS_SR_NO, psRefOf, psTender } from '@/lib/opportunityWorkbook';
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

// Download documents (user, 2026-10-27), beside Export Excel: the attached documents of the screened tenders
// listed, in one ZIP; extracted, each tender is a folder "<ref>-<hospital>" holding its files.
// onProgress(text) while it works. Returns { tenders, files, none } (none: the screened rows with no files).
export async function downloadScreenedDocuments(list, onProgress = () => {}) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const folders = new Set();
  let files = 0;
  const none = [];
  for (const [i, r] of list.entries()) {
    onProgress(`Tender ${i + 1} of ${list.length}…`);
    const { documents, bucket } = await screenedDocuments(r);
    if (!documents.length) {
      none.push(r);
      continue;
    }
    const folder = zip.folder(uniqueName(folderName(r.ref, r.tender?.hospital), folders));
    const used = new Set();
    for (const doc of documents) folder.file(uniqueName(doc.name, used), await documentBlob(doc, bucket, r));
    files += documents.length;
  }
  if (!files) return { tenders: 0, files, none };
  onProgress('Zipping…');
  const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `SCREENED DOCUMENTS ${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { tenders: list.length - none.length, files, none };
}

// A screened tender's attached documents and their Storage bucket
async function screenedDocuments(r) {
  if (r.source === 'philgeps') {
    const { data, error: err } = await supabase.from('philgeps_opportunities').select('details->documents').eq('ref_no', r.ref).limit(1);
    if (err) throw new Error(err.message);
    return { documents: data?.[0]?.documents || [], bucket: 'philgeps-documents' };
  }
  // The reference in quotes: a bare number would be read as a list position
  const { data, error: err } = await supabase.from('ps_philgeps_snapshot').select(`documents:notices->"${r.ref}"->documents`).eq('id', 'latest').maybeSingle();
  if (err) throw new Error(err.message);
  return { documents: data?.documents || [], bucket: 'ps-documents' };
}

// Characters Windows doesn't allow in a file or folder name are dropped
const safeName = (text) => String(text || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const folderName = (ref, hospital) => [safeName(ref), safeName(hospital)].filter(Boolean).join('-').slice(0, 150) || 'Documents';
// Two files with the same name are kept as "name (2).pdf"
function uniqueName(name, used) {
  const clean = safeName(name) || 'file';
  let candidate = clean;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = clean.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  used.add(candidate.toLowerCase());
  return candidate;
}

// A file in Storage, or an older one kept only on the computer that downloaded it (/api/documents, as View does)
async function documentBlob(doc, bucket, r) {
  if (doc.path) {
    const { data, error: err } = await supabase.storage.from(bucket).download(doc.path);
    if (err || !data) throw new Error(`${doc.name}: ${err?.message || 'not found'}`);
    return data;
  }
  const res = await fetch(`/api/documents?${r.source === 'ps' ? 'source=ps&' : ''}ref=${r.ref}&name=${encodeURIComponent(doc.name)}`);
  if (!res.ok) throw new Error(`${doc.name}: ${res.status}`);
  return res.blob();
}

// The stored copy's dates come back from JSON as text; the workbook needs Date objects
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;
// Copies saved before 2026-10-25 may start cells with a line number or stock code ("3. ", "55100000. ") and hold
// the price as text ("3. 108.00"); the export now writes neither (opportunityWorkbook.js itemRow), so old copies
// are cleaned the same way: the molecule text again through moleculeText, the price back to a number
const LINE_NUMBER = /^(?:\d+|[A-Z]+\d+)\.\s+/;
const priceNumber = (cell) => {
  if (typeof cell !== 'string') return cell;
  const value = Number(cell.replace(LINE_NUMBER, '').replace(/,/g, ''));
  return cell.trim() && Number.isFinite(value) ? value : null;
};
const revive = (tender) => ({
  ...tender,
  molecules: (tender.molecules || []).map(([molecule, qty, unitPrice, total]) => [
    typeof molecule === 'string' ? moleculeText(molecule.replace(LINE_NUMBER, '')) : molecule,
    typeof qty === 'string' ? qty.replace(LINE_NUMBER, '') : qty,
    priceNumber(unitPrice),
    total,
  ]),
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
  // A current reading with no molecule lines (e.g. its documents being read again at that moment) keeps the lines
  // saved when the tender was screened, so an export never comes out empty when they were known
  return list.map((r) => {
    // Copies saved before 2026-10-27 have a blank Sr. NO. for PS-PhilGEPS
    const saved = revive(r.source === 'ps' ? { ...r.tender, solicitationNo: PS_SR_NO } : r.tender || {});
    const current =
      r.source === 'philgeps' && bids[r.ref]
        ? philgepsTender(bids[r.ref])
        : r.source === 'ps' && psRows[r.ref]
          ? psTender(psRows[r.ref], bidMatch.headers, ps.notices[r.ref], ps.analysis[r.ref])
          : null;
    // Removed from the lists (a package or lot tender, or none of our products left): left out of the export
    if (current && !current.molecules?.length) return null;
    if (!current) return saved;
    return hasLines(current.molecules) || !hasLines(saved.molecules) ? current : { ...current, molecules: saved.molecules };
  });
}

// Molecule rows with a real line (a quantity or an amount), not only the products' names
const hasLines = (molecules) => (molecules || []).some(([, qty, unitPrice, total]) => qty || unitPrice != null || total != null);

// The team's Opportunity sheet for these screened rows, stacked in the order they were screened: the first
// screened at the top, the latest at the bottom (so each day's additions land under the earlier ones).
// Tenders removed from the lists are left out rather than exported blank (user, 2026-10-27).
// Returns { exported, left } (left: the screened rows left out)
export async function exportScreened(list) {
  const inScreenedOrder = [...list].sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)));
  const current = await currentTenders(inScreenedOrder);
  const tenders = current.filter(Boolean);
  if (tenders.length) await downloadOpportunityWorkbook(tenders);
  return { exported: tenders.length, left: inScreenedOrder.filter((r, i) => !current[i]) };
}
