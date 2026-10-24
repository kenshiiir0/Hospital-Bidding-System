// Safety check for Accept / Refuse award (frontend/src/lib/psAward.mjs), run before every push (tools/safety-gate.sh)
// and by hand:
//   node tools/check-award-action.mjs
// It starts a stand-in PS-PhilGEPS on this computer (My Award Notices list, the Accept / Refuse pop-up, the save
// call) and runs the dashboard's own code against it. The real PS-PhilGEPS account is never used. An answer to an
// award is official and can't be taken back, so: it is sent at most once, and never when the award is no longer
// pending, the pop-up's form isn't the one we know, or the comment breaks PS-PhilGEPS's rule.
import http from 'node:http';
import assert from 'node:assert/strict';

const AWARD = '31453';

const state = {
  acceptance: 'Pending for Acceptance',
  saves: [], // every save call: { award, body, token }
  formAward: AWARD, // the award number the pop-up's form carries
  answer: '1', // what the save call answers; 'drop' = the connection breaks after saving
};

const listPage = () =>
  '<html><body><table><thead><tr><th>Award Notice Number</th><th>Line Item</th><th>Status</th><th>Award Acceptance</th><th>Actions</th></tr></thead><tbody>' +
  `<tr><td><a href="/BidAwards/viewAwardNotice/${AWARD}">${AWARD}</a></td><td>Setastine hydrochloride</td><td>Published</td><td>${state.acceptance}</td><td>Select</td></tr>` +
  '<tr><td><a href="/BidAwards/viewAwardNotice/32233">32233</a></td><td>Amiodarone</td><td>Published</td><td>Accepted</td><td>Select</td></tr>' +
  '</tbody></table></body></html>';

const popup = (type) =>
  `<div id="facebox_div"><form id="frmAddAPP" method="post"><input type="hidden" name="_csrfToken" value="tok123"/>` +
  `<textarea name="comment_action" id="comment_action" maxlength="200"></textarea>` +
  `<input type="hidden" name="awardId" id="awardId" value="${state.formAward}">` +
  `<input type="hidden" name="type" id="type" value="${type}">` +
  `<input type="hidden" name="awardType" id="awardType" value="${state.formAward}"></form></div>`;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/EventManagements/myAwardNotices') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(listPage());
  }
  const pop = /^\/merchantAwards\/awardAction\/(\d+)\/(ACCEPT|REFUSE)\/\d+$/.exec(path);
  if (pop) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(popup(pop[2]));
  }
  const save = /^\/MerchantAwards\/saveAwardAction\/(\d+)$/.exec(path);
  if (save && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      state.saves.push({ award: save[1], body: Object.fromEntries(form), token: req.headers['x-csrf-token'] });
      if (state.answer === '1') state.acceptance = form.get('type') === 'ACCEPT' ? 'Accepted' : 'Refused';
      if (state.answer === 'drop') {
        state.acceptance = 'Accepted';
        return req.socket.destroy();
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(state.answer);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const host = `http://127.0.0.1:${server.address().port}`;
const { submitAwardAction } = await import('../frontend/src/lib/psAward.mjs');
const { Session } = await import('../frontend/src/lib/psSync.mjs');
const run = (input) => submitAwardAction(new Session([{ name: 'CAKEPHP', value: 'x' }]), { award: AWARD, action: 'ACCEPT', comment: 'We accept', ...input }, { host });
const reset = () => Object.assign(state, { acceptance: 'Pending for Acceptance', saves: [], formAward: AWARD, answer: '1' });

const checks = [
  [
    'A pending award is answered with one save call carrying the form token, and shows the new status',
    async () => {
      const result = await run({});
      assert.equal(state.saves.length, 1);
      assert.deepEqual(state.saves[0], { award: AWARD, body: { type: 'ACCEPT', comment: 'We accept', awardType: AWARD }, token: 'tok123' });
      assert.equal(result.after.acceptance, 'Accepted');
    },
  ],
  [
    'Refuse sends REFUSE',
    async () => {
      const result = await run({ action: 'REFUSE', comment: 'Out of stock' });
      assert.equal(state.saves[0]?.body.type, 'REFUSE');
      assert.equal(result.after.acceptance, 'Refused');
    },
  ],
  [
    'An award that is no longer pending is never sent',
    async () => {
      state.acceptance = 'Accepted';
      await assert.rejects(run({}), (e) => e.code === 'ALREADY');
      assert.equal(state.saves.length, 0, 'an answer was sent for an award that was already answered');
    },
  ],
  [
    'A pop-up form for another award is never sent',
    async () => {
      state.formAward = '99999';
      await assert.rejects(run({}), (e) => e.code === 'FORM_CHANGED');
      assert.equal(state.saves.length, 0);
    },
  ],
  [
    'A comment PS-PhilGEPS would refuse (signs, empty, too long) is never sent',
    async () => {
      for (const comment of ['OK!', '   ', 'x'.repeat(201)]) await assert.rejects(run({ comment }), (e) => e.code === 'BAD_INPUT');
      assert.equal(state.saves.length, 0);
    },
  ],
  [
    'A refused save is reported as not saved, and is not sent again',
    async () => {
      state.answer = '0';
      await assert.rejects(run({}), (e) => e.code === 'NOT_SAVED');
      assert.equal(state.saves.length, 1, 'the answer was sent more than once');
    },
  ],
  [
    'A save whose reply is lost counts by what PS-PhilGEPS shows afterwards, and is not sent again',
    async () => {
      state.answer = 'drop';
      const result = await run({});
      assert.equal(state.saves.length, 1, 'the answer was sent more than once');
      assert.equal(result.after.acceptance, 'Accepted');
    },
  ],
  [
    'Dry run reads the list and the pop-up but sends nothing',
    async () => {
      const result = await submitAwardAction(new Session([]), { award: AWARD, action: 'ACCEPT', comment: 'We accept' }, { host, dryRun: true });
      assert.equal(result.sent, false);
      assert.equal(state.saves.length, 0);
    },
  ],
];

let failed = 0;
for (const [name, check] of checks) {
  reset();
  try {
    await check();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}
server.close();
if (failed) {
  console.error(`\nAward action check FAILED (${failed} of ${checks.length}). Nothing may be pushed until it passes.`);
  process.exit(1);
}
console.log(`\nAward action check passed (${checks.length} checks).`);
