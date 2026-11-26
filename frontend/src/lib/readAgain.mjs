// When a tender's documents are read again, both portals (PS-PhilGEPS psDocs.mjs analyzePending, PhilGEPS
// philgepsSync.mjs needsReading). User, 2026-11-26: "make sure we don't read the same tender or documents again when
// the tender is completely confirmed read 100%" — a reading again costs downloads (Supabase egress), database writes
// and time in the Sync. Before, any change of the Product List or of the reading rules read every tender again: the
// Product List change of 2026-11-21 put 112 PS-PhilGEPS tenders back in the queue, most of them read already.
//
// A reading's key is "<rules>|<product list>|<files>" (documentsKey / readKey). A tender is read again when:
// - it has no good reading yet (never read, or its last reading failed: key null), or
// - its files changed (a bid bulletin added, a file replaced), or
// - its scanned pages wait for OCR where OCR runs (ocrPending, the caller's), or
// - only the rules or the Product List changed AND the reading is not complete (below 100%), or its files' text is
//   saved (read again from that text: no download).
// Never once the tender is closed (its bid deadline passed: nothing to bid on), except a first reading.
// Plain .mjs: used by the server, scripts and checks.

const filesOf = (key) => String(key || '').split('|').slice(2).join('|');

/** true when the tender should be read again; see above.
 *  stored / wanted: the reading's key and the key it would get now; accuracy: the reading's percent (null when
 *  unknown); closed: the bid deadline passed; textSaved: every file's text is saved (document_text) */
export function readAgain({ stored, wanted, accuracy = null, closed = false, textSaved = false, ocrWaiting = false }) {
  if (stored == null) return true;
  if (closed) return false;
  if (ocrWaiting) return true;
  if (stored === wanted) return false;
  if (filesOf(stored) !== filesOf(wanted)) return true;
  return accuracy !== 100 || textSaved;
}

// "15-Dec-2026 12:00 PM" (PS-PhilGEPS, Manila time) or an ISO date -> ms; null when not a date
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function deadlineMs(text) {
  if (!text) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i.exec(String(text).trim());
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month == null) return null;
    let hour = Number(m[4] || 23) % 12;
    if (m[6] && /pm/i.test(m[6])) hour += 12;
    if (!m[4]) hour = 23;
    return Date.UTC(Number(m[3]), month, Number(m[1]), hour - 8, Number(m[5] || 59));
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

/** A PS-PhilGEPS notice whose submission deadline (or closing date) has passed */
export const noticeClosed = (notice, now = Date.now()) => {
  const at = deadlineMs(notice?.schedule?.deadline) ?? deadlineMs(notice?.schedule?.closing);
  return at != null && at < now;
};
