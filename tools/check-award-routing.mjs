// Check for the award notice emails (frontend/src/lib/awardRouting.mjs, awardNotify.mjs), run before every push
// (tools/safety-gate.sh) and by hand:
//   node tools/check-award-routing.mjs          (routing + email rules, no network, nothing sent)
//   node tools/check-award-routing.mjs --live   (also: the awards pending now on PS-PhilGEPS, read with the saved
//                                                session, and who each would be emailed to; nothing is sent)
// The wrong person told means an award can lapse unanswered, so every hospital on the served list must reach
// its own representative, under the spellings PhilGEPS uses, and the back-ups must be on every email.
import assert from 'node:assert/strict';
import { BACKUPS, HOSPITALS, PEOPLE, routeAward } from '../frontend/src/lib/awardRouting.mjs';
import { composeEmail, notifyPendingAwards, readAwardPage } from '../frontend/src/lib/awardNotify.mjs';

let checks = 0;
const ok = (fn, what) => {
  fn();
  checks++;
  if (process.argv.includes('--verbose')) console.log(`ok - ${what}`);
};
const rep = (agency) => routeAward(agency).to.map((p) => p.email).join(',');
const backups = BACKUPS.map((p) => PEOPLE[p].email);

// Every hospital on the list, as written and as PhilGEPS writes agency names
for (const [no, name, who] of HOSPITALS) {
  ok(() => assert.equal(rep(name), PEOPLE[who].email, `#${no} ${name}`), `#${no} as on the sheet`);
  ok(() => assert.equal(rep(`DOH - ${name.toUpperCase().replace(/\./g, '')}`), PEOPLE[who].email, `#${no} DOH - upper case`), `#${no} PhilGEPS style`);
  ok(() => assert.deepEqual(routeAward(name).cc.map((p) => p.email), backups), `#${no} back-ups copied`);
}
assert.equal(new Set(HOSPITALS.map((h) => h[0])).size, 47, 'sheet numbers 1-47, each once');
assert.equal(HOSPITALS.filter((h) => h[2] === 'hazel').length, 25);
assert.equal(HOSPITALS.filter((h) => h[2] === 'angel').length, 22);

// The changes the user gave on 2026-10-24
ok(() => assert.equal(rep('CORAZON LOCSIN MONTELIBANO MEMORIAL REGIONAL HOSPITAL'), 'gov4@getmeds.ph'), '#15 Corazon Locsin -> Hazel');
ok(() => assert.equal(rep("NATIONAL CHILDREN'S HOSPITAL"), 'gov3@getmeds.ph'), "#23 National Children's -> Angel");
// Look-alike names go to their own hospital, never to the shorter one inside them
const cases = [
  ['BICOL REGIONAL HOSPITAL AND MEDICAL CENTER', 22],
  ['BICOL MEDICAL CENTER', 2],
  ['BICOL REGION GENERAL HOSPITAL AND GERIATRIC MEDICAL CENTER', 36],
  ['WESTERN VISAYAS MEDICAL CENTER', 14],
  ['WEST VISAYAS STATE UNIVERSITY MEDICAL CENTER', 34],
  ['WESTERN VISAYAS SANITARIUM AND GENERAL HOSPITAL', 38],
  ['COTABATO REGIONAL AND MEDICAL CENTER', 33],
  ['COTABATO SANITARIUM AND GENERAL HOSPITAL', 25],
  ['PHILIPPINE CHILDRENS MEDICAL CENTER', 47],
  ['DR. JOSE RIZAL MEMORIAL HOSPITAL', 41],
  ['RIZAL MEDICAL CENTER', 21],
  ['LAS PINAS GENERAL HOSPITAL AND SATELLITE TRAUMA CENTER', 26],
  ['REGION 2 TRAUMA AND MEDICAL CENTER', 18],
  ['DR. JOSE N. RODRIGUEZ MEMORIAL HOSPITAL AND SANITARIUM', 8],
  ['JOSE B. LINGAD MEMORIAL REGIONAL HOSPITAL', 4],
  ['EASTERN VISAYAS REGIONAL MEDICAL CENTER', 30],
];
for (const [agency, no] of cases) ok(() => assert.equal(routeAward(agency).hospital?.no, no, agency), `${agency} -> #${no}`);

// Not on the list: the back-ups get it
for (const agency of ['VETERANS MEMORIAL MEDICAL CENTER DND', 'QUIRINO MEMORIAL MEDICAL CENTER', '']) {
  ok(() => {
    const r = routeAward(agency);
    assert.equal(r.hospital, null, agency);
    assert.deepEqual(r.to.map((p) => p.email), backups);
  }, `${agency || '(no name)'} -> back-ups`);
}

// The award page as PS-PhilGEPS shows it (fields of award 32233, 2026-10-24)
const page =
  '<label>Notice Reference Number:</label><br/>72469 <br/><br/>' +
  '<label class="tamoha_bold_twelvepx">Approved Budget for the Contract:</label><br/><div class="tamoha_twelvepx">PHP 315,000.00</div><br/>' +
  '<label>Brand Name :</label><br/>AMIOGET<br/><br/>' +
  '<b><center class="verdhana_bold_twelvepx">TONDO MEDICAL CENTER </center></b><center class="verdhana_twelvepx"> Tondo, Manila </center>' +
  '<label>Contract Amount:</label><br/>PHP 79,250.00<br/><br/><label>Award Date:</label><br/>26-Sep-2026<br/><br/>';
const details = readAwardPage(page);
ok(() => assert.deepEqual(
  { agency: details.agency, ref: details.noticeRef, amount: details.contractAmount, budget: details.budget, date: details.awardDate },
  { agency: 'TONDO MEDICAL CENTER', ref: '72469', amount: 'PHP 79,250.00', budget: 'PHP 315,000.00', date: '26-Sep-2026' }
), 'award page fields');
const mail = composeEmail({ award: '31453', lineItem: 'AMIODARONE', details, route: routeAward(details.agency) });
ok(() => assert.match(mail.subject, /TONDO|Tondo/), 'subject names the hospital');
ok(() => assert.match(mail.text, /31453/) && assert.match(mail.text, /PHP 79,250\.00/) && assert.match(mail.text, /^Hi Angelica,/), 'email body');

// Only pending awards, each once (dry run: reads, sends and records nothing)
const list = {
  headers: ['Award Notice Number', 'Line Item', 'Award Acceptance'],
  rows: [
    { cells: ['31453', 'AMIODARONE', 'Pending for Acceptance'] },
    { cells: ['32233', 'PARACETAMOL', 'Accepted'] },
    { cells: ['31456', 'CEFUROXIME', 'Pending for Acceptance'] },
  ],
};
const stub = { from: () => ({ select: () => ({ in: async () => ({ data: [{ award_no: '31456', status: 'sent', attempts: 1 }] }) }) }) };
const read = [];
const results = await notifyPendingAwards(stub, list, async (url) => (read.push(url), page), { dryRun: true });
ok(() => assert.deepEqual(results.map((r) => r.award), ['31453']), 'pending and not yet emailed only');
ok(() => assert.equal(read.length, 1), 'one award page read');

console.log(`Award email routing check passed (${checks} checks).`);

if (process.argv.includes('--live')) {
  const { config } = await import('dotenv');
  config({ path: new URL('../.env', import.meta.url), quiet: true });
  const { admin, Session, getPage, STALE_RUN_MS } = await import('../frontend/src/lib/psSync.mjs');
  const supabase = admin();
  const { data: status } = await supabase.from('ps_sync_status').select('status, started_at').eq('id', 'latest').single();
  if (status?.status === 'running' && Date.now() - new Date(status.started_at).getTime() < STALE_RUN_MS) throw new Error('A Sync is running; try again in a minute.');
  const { data: saved } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
  if (!saved?.cookies?.length) throw new Error('PS-PhilGEPS is not connected.');
  const { data: snap } = await supabase.from('ps_philgeps_snapshot').select('lists').eq('id', 'latest').single();
  const session = new Session(saved.cookies);
  const print = session.fingerprint();
  const live = await notifyPendingAwards(supabase, snap.lists.awards, (url) => getPage(session, url), { dryRun: true });
  if (session.fingerprint() !== print) await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current');
  for (const r of live) {
    console.log(`${r.award} ${r.line_item} | ${r.agency || '?'} | to ${(r.to || []).map((p) => p.name).join(', ')} | cc ${(r.cc || []).map((p) => p.name).join(', ') || '-'}${r.error ? ` | ${r.error}` : ''}`);
  }
  if (!live.length) console.log('No award pending (or all already emailed).');
}
