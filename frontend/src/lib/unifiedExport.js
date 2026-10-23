import { supabase } from '@/lib/supabase';
import { matchesSearch } from '@/lib/psContext';
import { downloadOpportunityWorkbook, oldestFirst, philgepsTender, psRefOf, psTender } from '@/lib/opportunityWorkbook';
import { activePsData, activeTenders, loadActiveNames } from '@/lib/activeProducts';

// One Excel export for both portals (PhilGEPS and PS-PhilGEPS), in the team's Opportunity sheet layout,
// oldest published at the top and latest at the bottom.
// The page the button is on passes its own list exactly as shown (all its filters applied); the other
// portal's list is loaded here and narrowed by the same search box text (and published dates, when given),
// using that portal's own search rule.

// PhilGEPS page search: the typed text anywhere in reference no., title, hospital or our products
export function philgepsMatchesSearch(search, bid) {
  return `${bid.ref_no || ''} ${bid.title || ''} ${bid.procuring_entity || ''} ${(bid.matched_molecules || []).join(' ')}`
    .toLowerCase()
    .includes(search.toLowerCase());
}

const inRange = (published, from, to) => (!from || published >= from) && (!to || (published && published <= to));

async function loadPhilgepsTenders(search, from, to) {
  const { data, error } = await supabase.from('philgeps_opportunities').select('*').not('matched_molecules', 'eq', '{}');
  if (error) throw new Error(`Could not load PhilGEPS tenders: ${error.message}`);
  const active = await loadActiveNames().catch(() => null);
  return activeTenders(data, active).filter((bid) => philgepsMatchesSearch(search, bid)).map(philgepsTender).filter((t) => inRange(t.published, from, to));
}

// PS-PhilGEPS Bid Match: the last Sync's list, notices and document readings (as app/ps-philgeps/layout.js loads them)
export async function loadPsData() {
  const [{ data: snap, error }, { data: readings }] = await Promise.all([
    supabase.from('ps_philgeps_snapshot').select('lists, notices').eq('id', 'latest').maybeSingle(),
    supabase.from('ps_tender_analysis').select('ref, status, result'),
  ]);
  if (error) throw new Error(`Could not load PS-PhilGEPS data: ${error.message}`);
  const active = await loadActiveNames().catch(() => null);
  return activePsData({ lists: snap?.lists || {}, notices: snap?.notices || {}, analysis: Object.fromEntries((readings || []).map((r) => [r.ref, r])) }, active);
}

// Bid Match rows as export tenders; `rows` defaults to the rows that mention our products
export function psTenders(data, rows) {
  const list = data.lists?.bidMatch;
  if (!list) return [];
  return (rows || list.rows).map((row) => {
    const ref = psRefOf(row);
    return psTender(row, list.headers, data.notices[ref], data.analysis[ref]);
  });
}

// Our products of a Bid Match row: matched on the notice page or named in its documents (same rule as the
// Bid Match page)
function psProducts(data, row) {
  const ref = psRefOf(row);
  return [...new Set([...(data.notices[ref]?.matched || []), ...(data.analysis[ref]?.result?.items || []).flatMap((i) => i.our_products)])];
}

async function loadPsTenders(search, from, to) {
  const data = await loadPsData();
  const rows = (data.lists?.bidMatch?.rows || []).filter((row) => {
    const products = psProducts(data, row);
    // Only tenders that mention our products (the Bid Match "Our products" view), then the search
    return products.length && matchesSearch(search, row, products.join(' '));
  });
  return psTenders(data, rows).filter((t) => inRange(t.published, from, to));
}

// from: 'philgeps' | 'ps' (the page on screen, whose filtered list is `shown`, already in export shape),
// or nothing: both portals in full. type: the page's Type filter (ITB, RFQ...), applied to the other portal too.
export async function exportBothPortals({ from, shown = [], search = '', publishedFrom = '', publishedTo = '', type = '' } = {}) {
  const ofType = (tenders) => (type ? tenders.filter((t) => t.type === type) : tenders);
  const [philgeps, ps] = await Promise.all([
    from === 'philgeps' ? shown : loadPhilgepsTenders(search, publishedFrom, publishedTo).then(ofType),
    from === 'ps' ? shown : loadPsTenders(search, publishedFrom, publishedTo).then(ofType),
  ]);
  const tenders = oldestFirst([...philgeps, ...ps]);
  await downloadOpportunityWorkbook(tenders);
  return tenders.length;
}
