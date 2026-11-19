// "Nothing new to read" for the PS-PhilGEPS document run of the 5-minute keep-alive (app/api/ps-keepalive): every
// 15 minutes it loaded every notice and reading (~2.7 MB with the OCR count) to find, most of the time, nothing
// new. That alone was about 4.5 GB a month of the free plan's 5 GB egress (2026-11-19). Once a run has gone through
// everything, it saves a stamp of what it saw: the last Sync's time, the product list and the month (the reading
// budget starts again each month, lib/usageMeter.mjs). The next run reads only the Sync's time (a few bytes) and
// stops when the stamp is the same. Anything that wants a tender read again outside a Sync (OCR text arriving,
// lib/ocrQueue.mjs rereadTender) clears the stamp with wakeDocs.
// Kept in philgeps_sync_relay (id/job/updated_at rows, not sent live to the dashboards).
const ID = 'ps-docs-idle';
const table = (supabase) => supabase.from('philgeps_sync_relay');
const month = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).slice(0, 7);

/** The stamp for now; null when the Sync's time can't be read (then the run goes ahead) */
export async function docsStamp(supabase, listKey) {
  const { data, error } = await supabase.from('ps_philgeps_snapshot').select('synced_at').eq('id', 'latest').maybeSingle();
  if (error || !data?.synced_at) return null;
  return `${data.synced_at}|${listKey}|${month()}`;
}

export async function docsIdle(supabase, stamp) {
  if (!stamp) return false;
  const { data } = await table(supabase).select('job').eq('id', ID).maybeSingle();
  return data?.job?.stamp === stamp;
}

export async function markDocsIdle(supabase, stamp) {
  if (!stamp) return;
  await table(supabase).upsert({ id: ID, job: { stamp }, updated_at: new Date().toISOString() });
}

/** Has the next document run look at everything again */
export async function wakeDocs(supabase) {
  await table(supabase).delete().eq('id', ID);
}
