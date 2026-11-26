// Open Opportunities search check, part of the safety gate (tools/safety-gate.sh), runnable by hand:
//   node tools/check-open-search.mjs
// The PS-PhilGEPS Sync's search for open medicine notices (psSync.mjs openMedicineNotices) keeps what it found from
// Sync to Sync, searches the last days for new notices and takes the older days in turn, never past its time: on
// 2026-11-26 searching all 120 days every Sync left no time for the notice pages (0 to 50 of 672 read per Sync).
// A stand-in for the website answers the searches; nothing is fetched.
import assert from 'node:assert/strict';
import { openMedicineNotices } from '../frontend/src/lib/psSync.mjs';

const HEADERS = ['Notice Reference Number', 'Notice Title', 'Mode of Procurement', 'Classification', 'Publish Date', 'Closing Date', 'Agency name', 'Status'];
const FOUND = ['Bid Notice Reference Number', 'Notice Title', 'Mode of Procurement', 'Classification', 'Agency Name', 'Publish Date', 'Closing Date'];
const NOW = Date.UTC(2026, 10, 26, 2, 0); // 26 Nov 2026, 10:00 AM in Manila
const DAY = 24 * 60 * 60 * 1000;
const today = Math.floor((NOW + 8 * 60 * 60 * 1000) / DAY);
const day = (text) => Math.floor((Date.parse(`${text} GMT+0800`) + 8 * 60 * 60 * 1000) / DAY);
// A row as the last Sync kept it
const kept = (ref, title, published, closing, word) => ({ cells: [ref, title, 'Public Bidding', 'Goods', `${published} 12:00 AM`, `${closing} 09:00 AM`, 'A Hospital', 'Active'], links: [{ text: ref, href: `https://philgeps.gov.ph/tenders/viewBidNotice/${ref}` }], from: 'open-opportunities', ...(word && { word }) });
// A row as the website's search lists it
const listed = (ref, title, published, closing) => ({ cells: [ref, title, 'Public Bidding', 'Goods', 'A Hospital', `${published} 12:00 AM`, `${closing} 09:00 AM`], links: [] });
// The stand-in website: notices by title word and publish day
const site = (notices) => {
  const calls = [];
  const search = async (session, word, from, to) => {
    calls.push({ word, from, to });
    return [{ headers: FOUND, rows: notices.filter((n) => n.title.toLowerCase().includes(word) && day(n.published) >= from && day(n.published) <= to).map((n) => listed(n.ref, n.title, n.published, n.closing)) }];
  };
  return { search, calls };
};
const refs = (out) => out.rows.map((r) => r.cells[0]).sort();
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  ok    ${label}`);
};

// 1. No time left: nothing is searched, the notices kept from the last Sync stay, a closed one goes
{
  const web = site([]);
  const out = await openMedicineNotices(null, HEADERS, new Set(), {
    carried: [kept('100', 'Drugs and Medicines', '10-Nov-2026', '10-Dec-2026'), kept('101', 'Various Medicines', '01-Nov-2026', '20-Nov-2026')],
    until: 0,
    search: web.search,
    now: NOW,
  });
  assert.equal(web.calls.length, 0, 'no search without time');
  assert.deepEqual(refs(out), ['100'], 'the open one stays, the closed one goes');
  ok('out of time: kept notices stay, closed ones go, nothing searched');
}

// 2. Every word is searched for the last 3 days: a new notice is added; one in Bid Match itself is not
{
  const web = site([
    { ref: '200', title: 'Supply of Medicines', published: '25-Nov-2026', closing: '15-Dec-2026' },
    { ref: '201', title: 'Drug Testing Kits', published: '25-Nov-2026', closing: '15-Dec-2026' },
    { ref: '202', title: 'Vaccine for RHU', published: '26-Nov-2026', closing: '15-Dec-2026' },
  ]);
  // (time for the nine recent searches only: the clock passes `until` after them)
  let asked = 0;
  const out = await openMedicineNotices(null, HEADERS, new Set(['202']), {
    carried: [],
    search: (...args) => {
      asked++;
      return web.search(...args);
    },
    until: 1,
    clock: () => (asked >= 9 ? 2 : 0),
    now: NOW,
  });
  assert.equal(web.calls.length, 9, 'nine words');
  assert.ok(web.calls.every((c) => c.from === today - 3 && c.to === today), 'the last three days');
  assert.deepEqual(refs(out), ['200'], 'new medicine notice added; "Drug Testing Kits" and the one already in Bid Match are not');
  assert.equal(out.rows[0].word, 'medicine', 'the word that found it is kept');
  assert.equal(out.rows[0].cells[5], '15-Dec-2026 09:00 AM', 'closing date in Bid Match\'s column');
  ok('new notices of the last 3 days are added (nine searches)');
}

// 3. The older days in turn: a kept notice the site no longer lists in its slice is dropped; the turn moves on
{
  const web = site([{ ref: '300', title: 'Medicine for the Health Office', published: '15-Nov-2026', closing: '20-Dec-2026' }]);
  let asked = 0;
  const out = await openMedicineNotices(null, HEADERS, new Set(), {
    carried: [kept('300', 'Medicine for the Health Office', '15-Nov-2026', '20-Dec-2026', 'medicine'), kept('301', 'Medicine for Jail', '12-Nov-2026', '20-Dec-2026', 'medicine'), kept('302', 'Drugs for RHU', '12-Nov-2026', '20-Dec-2026', 'drug')],
    sweep: { next: 0 },
    search: (...args) => {
      asked++;
      return web.search(...args);
    },
    // nine recent searches, then one slice of the older days
    until: 1,
    clock: () => (asked >= 10 ? 2 : 0),
    now: NOW,
  });
  assert.deepEqual(web.calls[9], { word: 'medicine', from: today - 30, to: today }, 'first slice: medicine, the last 30 days');
  assert.deepEqual(refs(out), ['300', '302'], 'the cancelled medicine notice goes; another word\'s notice waits for its own turn');
  assert.equal(out.sweep.next, 1, 'the next Sync takes the next slice');
  assert.equal(out.swept, 1);
  ok('a slice of the older days drops a notice the site no longer lists');
}

// 4. A slice the site answers with no rows drops nothing (it may be the site failing)
{
  const web = site([]);
  let asked = 0;
  const out = await openMedicineNotices(null, HEADERS, new Set(), {
    carried: [kept('400', 'Medicine for Jail', '12-Nov-2026', '20-Dec-2026', 'medicine')],
    sweep: { next: 0 },
    search: (...args) => {
      asked++;
      return web.search(...args);
    },
    until: 1,
    clock: () => (asked >= 10 ? 2 : 0),
    now: NOW,
  });
  assert.deepEqual(refs(out), ['400'], 'kept');
  ok('an empty answer drops nothing');
}

// 5. A search that fails keeps everything found and kept so far, and says so
{
  let asked = 0;
  const out = await openMedicineNotices(null, HEADERS, new Set(), {
    carried: [kept('500', 'Drugs and Medicines', '10-Nov-2026', '10-Dec-2026')],
    search: async () => {
      if (++asked === 2) throw new Error('fetch failed');
      return [{ headers: FOUND, rows: [listed('501', 'Supply of Medicines', '26-Nov-2026', '15-Dec-2026')] }];
    },
    now: NOW,
  });
  assert.deepEqual(refs(out), ['500', '501'], 'kept and found rows stay');
  assert.equal(out.error, 'fetch failed', 'the error is reported');
  ok('a failed search loses nothing');
}

// 6. A lost connection still stops the Sync (it must log in again), as before
{
  const lost = Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' });
  await assert.rejects(
    () =>
      openMedicineNotices(null, HEADERS, new Set(), {
        search: async () => {
          throw lost;
        },
        now: NOW,
      }),
    /not connected/
  );
  ok('a lost connection is passed on');
}

// 7. With time, every slice is taken once (nine words x four slices of 30 days) and the turn comes back to the start
{
  const web = site([]);
  const out = await openMedicineNotices(null, HEADERS, new Set(), { sweep: { next: 5 }, search: web.search, now: NOW });
  assert.equal(web.calls.length, 9 + 36, 'nine recent searches and 36 slices');
  assert.equal(out.sweep.next, 5, 'back where it started');
  ok('all 120 days are covered in 36 slices');
}

console.log(`Open Opportunities search check passed (${checks} checks).`);
