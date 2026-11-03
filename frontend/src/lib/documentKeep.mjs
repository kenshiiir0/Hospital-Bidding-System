// Only the files of our tenders are kept (user, 2026-11-03: "Do not store them"): the Syncs download every open
// tender's documents to look for our products in them, and once read, the files of a tender with none of our
// products that isn't Screened are deleted from Storage. Each file stays listed, marked removed, so no reader opens
// it and no Sync downloads it again (its reading stays). The free plan holds 1 GB; these were most of it.

export const REMOVED = 'not ours';

// The tender's documents with the stored files deleted and marked removed; unchanged when the delete fails
export async function dropFiles(supabase, bucket, documents) {
  const stored = (documents || []).filter((d) => d.path && !d.removed);
  if (!stored.length) return documents;
  const { error } = await supabase.storage.from(bucket).remove(stored.map((d) => d.path));
  if (error) return documents;
  return documents.map((d) => (d.path && !d.removed ? { ...d, removed: REMOVED } : d));
}

// Read to the end: no scanned page left for OCR (the GitHub job still needs those files, psDocs.mjs ocr_waiting)
export const fullyRead = (status, read) => status === 'done' && !(read || []).some((d) => d.kind === 'scanned' || d.ocr_waiting);

// Screened tenders' refs on one portal ('ps' or 'philgeps')
export async function screenedRefs(supabase, source) {
  const { data } = await supabase.from('screened_tenders').select('source, ref');
  return new Set((data || []).filter((s) => (source === 'ps' ? s.source === 'ps' : s.source !== 'ps')).map((s) => String(s.ref)));
}
