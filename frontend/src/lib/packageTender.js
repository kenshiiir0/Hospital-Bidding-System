// Tenders bought as one package or lot, which the team doesn't bid on: hidden on both portals and in the Screened
// export (user, 2026-10-27, and again 2026-10-30: "if it is a lot then exclude them"). A lot is found in the
// documents (psDocs.mjs lotSchedule): the Bid Data Sheet's "The number of lot(s): One (1)" (checked first, "that is
// mostly where the Lot is indicated"; PS 107468, itemised but one lot), a Schedule of Requirements quantity of 1 lot /
// package, or a price list headed by the whole as one lot; or in the description (PACKAGE_ROW, BDS_ONE_LOT).

// Never by the tender's name or a file name: Adela Serra Ty "PACKAGE 1 - ..." and Taguig "Medicines - Lot F" both
// list their items one by one (user, 2026-10-27: only what the description or the documents say counts, for both
// "Lot" and "Package").

// A Schedule of Requirements row asking for the whole as one: "1 Package Drugs and Medicines 1 30 Calendars Days"
export const PACKAGE_ROW = /^\W{0,2}1[.)]?\s+(?:package|lot|lump[\s-]*sum)s?\b.*?\s1(?:\s|$)/i;

// The Bid Data Sheet's clause 1.2 saying the whole is one lot: "The number of lot(s): One (1)", "number of lots: 1",
// "No. of Lot/s: one lot" (not two or more, not "Not applicable"; PS 107468)
export const BDS_ONE_LOT = /\b(?:number|no\.?)\s+of\s+lots?\s*(?:\(s\)|\/s)?\s*[:.-]?\s*(?:one\b|1\b|\(1\)|single\b)/i;

/** True when a tender is bought as one package or lot: its documents say so (psDocs.mjs result.package), or a line
 * of its description does ("1 Package Drugs and Medicines 1", "The number of lot(s): One (1)"; PhilGEPS items_text,
 * PS-PhilGEPS keeps none) */
export function isPackageTender(description, documentsPackage) {
  return Boolean(documentsPackage) || String(description || '').split('\n').some((line) => PACKAGE_ROW.test(line.trim()) || BDS_ONE_LOT.test(line));
}
