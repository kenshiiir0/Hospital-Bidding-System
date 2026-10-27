// Stored matches (PhilGEPS matched_molecules, PS notice.matched and document readings) are refreshed by the
// hourly update, the Syncs and the keep-alive. Until then a product archived on the Product List would still
// show, so every screen keeps only the molecules on today's list (/api/products: active products' names).

import { authFetch } from '@/lib/authFetch';
import { isPackageTender } from '@/lib/packageTender';
import { psRefOf } from '@/lib/opportunityWorkbook';

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
  if (isPackageTender(bid.title, bid.details?.package)) return { ...bid, matched_molecules: [] };
  if (!active) return bid;
  return { ...bid, matched_molecules: (bid.matched_molecules || []).filter((name) => active.has(name)) };
}

/** PhilGEPS tenders that still ask for one of our active products (not package or lot tenders). A screened tender
 * (screened: has('philgeps', ref)) always stays, so the team can still find and search it (user, 2026-10-27). */
export function activeTenders(bids, active, screened) {
  return bids.map((bid) => activeTender(bid, active)).filter((bid) => bid.matched_molecules?.length || screened?.has('philgeps', bid.ref_no));
}

/** PS data ({ notices, analysis }) with archived molecules taken out of notice matches and document items, and
 * package or lot tenders left with none. keepPackages: leave package or lot tenders as read (Screened Tenders: the
 * team picked them, so their lines are exported and shown, user 2026-10-27) */
export function activePsData(data, active, { keepPackages = false } = {}) {
  if (!data) return data;
  // Tenders bought as one package or lot: by their title or their documents (lib/packageTender.js); no products
  const list = data.lists?.bidMatch;
  const titleAt = list?.headers?.indexOf('Notice Title') ?? -1;
  const packaged = new Set(keepPackages ? [] : [
    ...(list?.rows || []).filter((row) => titleAt >= 0 && isPackageTender(row.cells[titleAt])).map((row) => psRefOf(row)),
    ...Object.entries(data.analysis || {}).filter(([, r]) => r?.result?.package).map(([ref]) => ref),
  ]);
  const keep = (ref, name) => !packaged.has(ref) && (!active || active.has(name));
  const notices = Object.fromEntries(Object.entries(data.notices || {}).map(([ref, n]) => [ref, n?.matched ? { ...n, matched: n.matched.filter((name) => keep(ref, name)) } : n]));
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
