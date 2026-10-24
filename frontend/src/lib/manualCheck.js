// Tenders whose downloaded bid documents couldn't be read for our products (lib/psDocs.mjs documents_read):
// a scan OCR couldn't make out, an old Word .doc or another file type that isn't read, or a damaged file.
// Our products may be in them, so the PhilGEPS and PS-PhilGEPS pages list them under "Need manual check",
// also when no product was found anywhere (those are left out of the usual "our products" list).

export const MANUAL_CHECK = 'Documents need a manual check';

// Why one file wasn't read. A scan read before OCR (no doc.ocr) is read again with OCR by the next Sync.
export function unreadReason(doc) {
  if (doc.kind === 'scanned') return doc.ocr ? 'scanned, OCR found no readable text' : 'scanned, OCR not done yet';
  if (doc.kind === 'unreadable') return 'damaged or could not be opened';
  return /\.doc$/i.test(doc.name || '') ? 'old Word format (.doc)' : 'file type not read';
}

/** The files of a documents_read list that weren't read as text, e.g. [{ name, kind }] */
export const unreadDocuments = (read) => (read || []).filter((doc) => doc.kind !== 'text');

export const needsManualCheck = (read) => unreadDocuments(read).length > 0;

// documents_read entries with these kinds, for a Supabase filter on philgeps_opportunities
export const UNREAD_KINDS = ['scanned', 'unreadable', 'unsupported'];
