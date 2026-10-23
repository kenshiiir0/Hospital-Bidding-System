// Stored matches (PhilGEPS matched_molecules, PS notice.matched and document readings) are refreshed by the
// hourly update, the Syncs and the keep-alive. Until then a product archived on the Product List would still
// show, so every screen keeps only the molecules on today's list (/api/products: active products' names).

let cached = null;

/** Names of our active molecules; one request per page load. Rejects if the list can't be loaded. */
export function loadActiveNames() {
  cached ??= fetch('/api/products')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Error ${res.status}`))))
    .then((names) => new Set(names))
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}

/** A PhilGEPS tender with only active molecules in matched_molecules (no list known: unchanged). */
export function activeTender(bid, active) {
  if (!active) return bid;
  return { ...bid, matched_molecules: (bid.matched_molecules || []).filter((name) => active.has(name)) };
}

/** PhilGEPS tenders that still ask for one of our active products. */
export function activeTenders(bids, active) {
  return active ? bids.map((bid) => activeTender(bid, active)).filter((bid) => bid.matched_molecules.length) : bids;
}

/** PS data ({ notices, analysis }) with archived molecules taken out of notice matches and document items. */
export function activePsData(data, active) {
  if (!active || !data) return data;
  const notices = Object.fromEntries(Object.entries(data.notices || {}).map(([ref, n]) => [ref, n?.matched ? { ...n, matched: n.matched.filter((name) => active.has(name)) } : n]));
  const analysis = Object.fromEntries(
    Object.entries(data.analysis || {}).map(([ref, r]) => {
      const items = r?.result?.items;
      if (!items) return [ref, r];
      const kept = items.map((i) => ({ ...i, our_products: (i.our_products || []).filter((name) => active.has(name)) })).filter((i) => i.our_products.length);
      return [ref, { ...r, result: { ...r.result, items: kept } }];
    }),
  );
  return { ...data, notices, analysis };
}
