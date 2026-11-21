// Every row of a query, page by page: Supabase answers at most 1,000 rows per request, so a plain select of a
// bigger table is cut short without any error (2026-11-21: ps_tender_analysis had 1,153 readings; 153 tenders
// showed no lines on the dashboard and were read again on every run). build() returns the query with a stable
// order (e.g. .order('ref')); { data, error } like a plain query. Plain .mjs: used by the server, scripts and pages.
const PAGE = 1000;

export async function allRows(build) {
  const data = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await build().range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    data.push(...(page || []));
    if (!page || page.length < PAGE) return { data, error: null };
  }
}
