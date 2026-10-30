// Stored matches (PhilGEPS matched_molecules, PS notice.matched and document readings) are refreshed by the
// hourly update, the Syncs and the keep-alive. Until then a product archived on the Product List would still
// show, so every screen keeps only the molecules on today's list (/api/products: active products' names).

import { authFetch } from '@/lib/authFetch';
import { isPackageTender } from '@/lib/packageTender';

let cached = null;

/** Names of our active molecules; one request per page load. Rejects if the list can't be loaded. */
export function loadActiveNames() {
  cached ??= authFetch('/api/products')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Error ${res.status}`))))
    .then((names) => new Set(names))
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}

/** A PhilGEPS tender with only active molecules in matched_molecules (no list known: unchanged); none for a tender
 * bought as one package or lot (lib/packageTender.js) */
export function activeTender(bid, active) {
  // (lot: a screened lot still shows, with the LOT pill)
  if (isPackageTender(bid.items_text, bid.details?.package)) return { ...bid, lot: true, matched_molecules: [] };
  if (!active) return bid;
  return { ...bid, matched_molecules: (bid.matched_molecules || []).filter((name) => active.has(name)) };
}

/** PhilGEPS tenders that still ask for one of our active products (not package or lot tenders). A screened tender
 * (screened: has('philgeps', ref)) always stays, so the team can still find and search it (user, 2026-10-27). */
export function activeTenders(bids, active, screened) {
  return bids.map((bid) => activeTender(bid, active)).filter((bid) => bid.matched_molecules?.length || screened?.has('philgeps', bid.ref_no));
}

/** PS data ({ notices, analysis }) with archived molecules taken out of notice matches and document items, and
 * package or lot tenders left with none. */
export function activePsData(data, active) {
  if (!data) return data;
  // Tenders bought as one package or lot, by their documents (lib/packageTender.js); no products
  const packaged = new Set(Object.entries(data.analysis || {}).filter(([, r]) => isPackageTender('', r?.result?.package)).map(([ref]) => ref));
  const keep = (ref, name) => !packaged.has(ref) && (!active || active.has(name));
  const notices = Object.fromEntries(
    Object.entries(data.notices || {}).map(([ref, n]) => [ref, n ? { ...n, ...(n.matched && { matched: n.matched.filter((name) => keep(ref, name)) }), ...(packaged.has(ref) && { lot: true }) } : n])
  );
  const analysis = Object.fromEntries(
    Object.entries(data.analysis || {}).map(([ref, r]) => {
      const items = r?.result?.items;
      if (!items) return [ref, r];
      const kept = items.map((i) => ({ ...i, our_products: (i.our_products || []).filter((name) => keep(ref, name)) })).filter((i) => i.our_products.length);
      return [ref, { ...r, result: { ...r.result, items: kept } }];
    }),
  );
  return { ...data, notices, analysis };
}
