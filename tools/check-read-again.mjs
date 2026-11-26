// Read-again check, part of the safety gate (tools/safety-gate.sh), runnable by hand: node tools/check-read-again.mjs
// A tender's documents are read again only when it can change something (lib/readAgain.mjs; user 2026-11-26: "make
// sure we don't read the same tender or documents again when the tender is completely confirmed read 100%"). Both
// portals use the same rule (psDocs.mjs analyzePending, philgepsSync.mjs needsReading).
import assert from 'node:assert/strict';
import { deadlineMs, noticeClosed, readAgain } from '../frontend/src/lib/readAgain.mjs';

const key = (rules, list, files) => `${rules}|${list}|${files}`;
const now = key('rules-64', 'list-new', 'a.pdf:10');
const cases = [
  [{ stored: null, wanted: now }, true, 'never read (or the last reading failed): read'],
  [{ stored: now, wanted: now, accuracy: 100 }, false, 'nothing changed: not read again'],
  [{ stored: key('rules-64', 'list-new', 'a.pdf:10|bulletin.pdf:5'), wanted: key('rules-64', 'list-new', 'a.pdf:10'), accuracy: 100 }, true, 'its files changed: read again'],
  [{ stored: key('rules-64', 'list-old', 'a.pdf:10'), wanted: now, accuracy: 100 }, false, 'read to 100%, only the Product List changed: not read again'],
  [{ stored: key('rules-63', 'list-new', 'a.pdf:10'), wanted: now, accuracy: 100 }, false, 'read to 100%, only the rules changed: not read again'],
  [{ stored: key('rules-64', 'list-old', 'a.pdf:10'), wanted: now, accuracy: 60 }, true, 'read below 100%, the Product List changed: read again'],
  [{ stored: key('rules-64', 'list-old', 'a.pdf:10'), wanted: now, accuracy: null }, true, 'accuracy unknown: read again'],
  [{ stored: key('rules-64', 'list-old', 'a.pdf:10'), wanted: now, accuracy: 100, textSaved: true }, true, 'read to 100% with its text saved: read again from the text (no download)'],
  [{ stored: key('rules-64', 'list-new', 'b.pdf:1'), wanted: now, accuracy: 100, closed: true }, false, 'closed: never read again, even with new files'],
  [{ stored: key('rules-64', 'list-old', 'a.pdf:10'), wanted: now, accuracy: 40, closed: true }, false, 'closed and incomplete: not read again'],
  [{ stored: null, wanted: now, closed: true }, true, 'closed but never read: its first reading'],
  [{ stored: now, wanted: now, accuracy: 50, ocrWaiting: true }, true, 'scanned pages waiting for OCR where OCR runs: read again'],
  [{ stored: now, wanted: now, accuracy: 50, ocrWaiting: true, closed: true }, false, 'closed: no OCR reading either'],
];
for (const [input, want, label] of cases) {
  assert.equal(readAgain(input), want, label);
  console.log(`  ok    ${label}`);
}

// PS-PhilGEPS deadlines are Manila time (UTC+8)
assert.equal(deadlineMs('15-Dec-2026 12:00 PM'), Date.UTC(2026, 11, 15, 4, 0), 'noon in Manila');
assert.equal(deadlineMs('02-Dec-2026 01:30 PM'), Date.UTC(2026, 11, 2, 5, 30), 'afternoon in Manila');
assert.equal(deadlineMs('02-Dec-2026 12:15 AM'), Date.UTC(2026, 11, 1, 16, 15), 'just after midnight in Manila');
assert.equal(deadlineMs('2026-12-15T04:00:00Z'), Date.UTC(2026, 11, 15, 4, 0), 'an ISO date');
assert.equal(deadlineMs(''), null, 'no date');
const at = Date.UTC(2026, 11, 15, 3, 0);
assert.equal(noticeClosed({ schedule: { deadline: '15-Dec-2026 12:00 PM' } }, at), false, 'an hour before the deadline: open');
assert.equal(noticeClosed({ schedule: { deadline: '15-Dec-2026 12:00 PM' } }, at + 2 * 3600e3), true, 'an hour after the deadline: closed');
assert.equal(noticeClosed({ schedule: { closing: '15-Dec-2026 12:00 PM' } }, at + 2 * 3600e3), true, 'the closing date when there is no deadline');
assert.equal(noticeClosed({ schedule: {} }, at), false, 'no date: treated as open');
console.log(`Read-again check passed (${cases.length + 9} checks).`);
