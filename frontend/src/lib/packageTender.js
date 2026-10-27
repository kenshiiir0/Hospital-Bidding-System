// Tenders bought as one package or lot, which the team doesn't bid on (user, 2026-10-27: "When the sched of
// requirements were package or lot then do not fetch it anymore"). Their molecules aren't fetched, so they leave
// the lists and the Screened export on both portals (PhilGEPS: no matched_molecules, PS-PhilGEPS: no products).

// Never by the tender's name or a file name: Adela Serra Ty "PACKAGE 1 - ..." and Taguig "Medicines - Lot F" both
// list their items one by one (user, 2026-10-27: only what the description or the documents say counts, for both
// "Lot" and "Package").

// A Schedule of Requirements row asking for the whole as one: "1 Package Drugs and Medicines 1 30 Calendars Days"
export const PACKAGE_ROW = /^\W{0,2}1[.)]?\s+(?:package|lot|lump[\s-]*sum)s?\b.*?\s1(?:\s|$)/i;

/** True when a tender is bought as one package or lot: its documents say so (psDocs.mjs result.package), or a line
 * of its description does ("1 Package Drugs and Medicines 1"; PhilGEPS items_text, PS-PhilGEPS keeps none) */
export function isPackageTender(description, documentsPackage) {
  return Boolean(documentsPackage) || String(description || '').split('\n').some((line) => PACKAGE_ROW.test(line.trim()));
}
