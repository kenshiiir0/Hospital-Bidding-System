// The month's bid-document downloads out of Supabase Storage by the readers (psDocs.mjs downloadWithRetry), kept in
// usage_meter (schema.sql). The free plan allows 5 GB of downloads a month for everything (the dashboard, the hourly
// fetch, View/Save); past it Supabase blocks the whole organization, which happened on 2026-11-03 after two weeks of
// re-reads. The readers stop downloading at READ_BUDGET_BYTES, leaving the rest for the team, and go on next month.
// Never stops a reading for its own failure: a meter that can't be reached counts nothing and blocks nothing.

export const READ_BUDGET_BYTES = 2.5 * 1024 ** 3;
export const DOWNLOAD_BUDGET_MESSAGE =
  "This month's document reading budget is used up (to keep the free plan from being blocked); reading continues next month.";

const month = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).slice(0, 7);
// The answer is kept a few minutes per process, not asked before every file
const CHECK_MS = 5 * 60 * 1000;
let checked = { at: 0, over: false };

export async function countDownload(supabase, bytes) {
  if (!bytes) return;
  try {
    const { data, error } = await supabase.rpc('add_read_bytes', { m: month(), b: Math.round(bytes) });
    if (!error && Number(data) >= READ_BUDGET_BYTES) checked = { at: Date.now(), over: true };
  } catch {
    // not counted
  }
}

export async function downloadsOverBudget(supabase) {
  if (Date.now() - checked.at < CHECK_MS) return checked.over;
  try {
    const { data, error } = await supabase.from('usage_meter').select('read_bytes').eq('month', month()).maybeSingle();
    checked = { at: Date.now(), over: !error && Number(data?.read_bytes || 0) >= READ_BUDGET_BYTES };
  } catch {
    checked = { at: Date.now(), over: false };
  }
  return checked.over;
}
