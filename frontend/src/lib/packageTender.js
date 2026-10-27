// Tenders bought as one package or lot, which the team doesn't bid on (user, 2026-10-27: "When the sched of
// requirements were package or lot then do not fetch it anymore", e.g. Taguig's "Supply and Delivery of Medicines -
// Lot B"). Their molecules aren't fetched, so they leave the lists on both portals (PhilGEPS: no matched_molecules,
// PS-PhilGEPS: no products).

// A title naming its lot or package ("... - Lot F", "Lot 10", "(Package 2)"), not "lot bidding" or "per lot"
export const PACKAGE_TITLE = /\b(?:lot|package)\s*(?:no\.?\s*)?[A-Z0-9]{1,3}\b(?!\s*bidding)/i;

// A Schedule of Requirements row asking for the whole as one: "1 Package Drugs and Medicines 1 30 Calendars Days"
export const PACKAGE_ROW = /^\W{0,2}1[.)]?\s+(?:package|lot|lump[\s-]*sum)s?\b.*?\s1(?:\s|$)/i;

/** True when a tender is bought as one package or lot: by its title, or by its documents (psDocs.mjs result.package) */
export function isPackageTender(title, documentsPackage) {
  return Boolean(documentsPackage) || PACKAGE_TITLE.test(title || '');
}
