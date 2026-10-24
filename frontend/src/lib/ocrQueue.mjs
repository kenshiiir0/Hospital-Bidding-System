import { createClient } from '@supabase/supabase-js';

// Scanned documents still waiting to be read with OCR, on both sides, and the ocr_status row the dashboard
// reads (schema.sql). A document "waits" when the last reading listed it as scanned without OCR text
// (documents_read: { kind: 'scanned' } and no `ocr` mark). Used by the GitHub OCR job (scripts/ocr-job.mjs,
// layer 1) and the Google Vision backup (ocrVision.mjs, layer 2).
// Plain .mjs (no Next imports) so it can also be run directly with node.

export function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Scanned documents of a reading: tried = OCR (tesseract) already ran and found no readable text
const scannedIn = (read) => (read || []).filter((d) => d.kind === 'scanned').map((d) => ({ name: d.name, tried: Boolean(d.ocr) }));

// [{ side: 'ps' | 'philgeps', ref, bucket, doc: { name, path, size }, since, tried }] oldest first.
// Without includeTried only the documents OCR hasn't run on yet (what the dashboard counts as waiting).
export async function scannedWaiting(supabase, { includeTried = false } = {}) {
  const out = [];

  // PS-PhilGEPS: ps_tender_analysis (what was read) + the snapshot's notices (where the files are)
  const [{ data: readings }, { data: snap }] = await Promise.all([
    supabase.from('ps_tender_analysis').select('ref, documents_read, analyzed_at'),
    supabase.from('ps_philgeps_snapshot').select('notices').eq('id', 'latest').maybeSingle(),
  ]);
  for (const r of readings || []) {
    const docs = snap?.notices?.[r.ref]?.documents || [];
    for (const { name, tried } of scannedIn(r.documents_read)) {
      if (tried && !includeTried) continue;
      const doc = docs.find((d) => d.name === name && d.path);
      if (doc) out.push({ side: 'ps', ref: r.ref, bucket: 'ps-documents', doc, since: r.analyzed_at, tried });
    }
  }

  // PhilGEPS: philgeps_opportunities.details (documents and what was read from them)
  const { data: rows } = await supabase
    .from('philgeps_opportunities')
    .select('ref_no, details->documents, details->documents_read, details->documents_checked_at')
    .contains('details', { documents_read: [{ kind: 'scanned' }] });
  for (const o of rows || []) {
    for (const { name, tried } of scannedIn(o.documents_read)) {
      if (tried && !includeTried) continue;
      const doc = (o.documents || []).find((d) => d.name === name && d.path);
      if (doc) out.push({ side: 'philgeps', ref: o.ref_no, bucket: 'philgeps-documents', doc, since: o.documents_checked_at || null, tried });
    }
  }
  return out.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
}

// Updates ocr_status: how many scanned documents wait, since when, plus the given fields
export async function saveOcrStatus(supabase, fields = {}) {
  const waiting = await scannedWaiting(supabase);
  const oldest = waiting.find((w) => w.since)?.since || null;
  await supabase
    .from('ocr_status')
    .update({ ...fields, waiting: waiting.length, oldest_waiting_since: oldest, updated_at: new Date().toISOString() })
    .eq('id', 'latest');
  return waiting;
}

// After new OCR text is cached for a document, make its tender be read again with it:
// PS-PhilGEPS by forgetting the reading's key, PhilGEPS by forgetting documents_read_key
export async function rereadTender(supabase, side, ref) {
  if (side === 'ps') {
    await supabase.from('ps_tender_analysis').update({ documents_key: null }).eq('ref', ref);
    return;
  }
  const { data } = await supabase.from('philgeps_opportunities').select('details').eq('ref_no', ref).maybeSingle();
  if (!data?.details) return;
  await supabase.from('philgeps_opportunities').update({ details: { ...data.details, documents_read_key: null } }).eq('ref_no', ref);
}
