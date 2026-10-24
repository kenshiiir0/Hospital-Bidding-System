import { parse } from 'node-html-parser';
import { logActivity } from './activityLog.mjs';
import { LISTS, PsSyncError, STALE_RUN_MS, Session, USER_AGENT, admin, getPage, isLoginPage, readList } from './psSync.mjs';

// Accept or Refuse one award on PS-PhilGEPS (My Award Notices → Select → Accept Award / Refuse Award), started
// by a team member from the dashboard's Award Notices page, with the saved PS-PhilGEPS session (psSync.mjs).
// It does what the pop-up does, step by step, and sends nothing unless every step checks out:
// 1. the award list, read now: the award must still be "Pending for Acceptance",
// 2. the pop-up (/merchantAwards/awardAction/<award>/<ACCEPT|REFUSE>/<award>): the form must be for this award
//    and this action; it carries the form's security token,
// 3. one POST to /MerchantAwards/saveAwardAction/<award> {type, comment, awardType} (PhilGEPS answers 1 when
//    saved); never sent twice,
// 4. the award list again: the dashboard shows Accepted / Refused only when PhilGEPS shows it.
// Plain .mjs (no Next imports) so tools/check-award-action.mjs can run it against a stand-in PhilGEPS.

export const ACTIONS = { ACCEPT: 'Accept', REFUSE: 'Refuse' };
// The pop-up's own rule for the Comment box (required, 200 characters, letters, digits and spaces)
export const COMMENT_MAX = 200;
export const COMMENT_PATTERN = /^[A-Za-z0-9 ]+$/;

const PENDING = /pending/i;
const awardsList = (host) => ({ ...LISTS.find((l) => l.key === 'awards'), url: `${host}/EventManagements/myAwardNotices` });

// The award's row and its acceptance ("Pending for Acceptance", "Accepted", "Refused") in a list read with readList
function findAward(list, award) {
  const row = list.rows.find((r) => r.cells[0] === award);
  const at = list.headers.findIndex((h) => /acceptance/i.test(h));
  return row && { row, acceptance: row.cells[at] || '', lineItem: row.cells[list.headers.findIndex((h) => /line item/i.test(h))] || '' };
}

export function checkInput({ award, action, comment }) {
  if (!/^\d+$/.test(String(award || ''))) throw new PsSyncError('BAD_INPUT', 'Unknown award notice number.');
  if (!ACTIONS[action]) throw new PsSyncError('BAD_INPUT', 'Choose Accept or Refuse.');
  const text = String(comment || '').trim();
  if (!text) throw new PsSyncError('BAD_INPUT', 'PS-PhilGEPS needs a comment.');
  if (text.length > COMMENT_MAX) throw new PsSyncError('BAD_INPUT', `The comment can be at most ${COMMENT_MAX} characters.`);
  if (!COMMENT_PATTERN.test(text)) throw new PsSyncError('BAD_INPUT', 'PS-PhilGEPS accepts only letters, numbers and spaces in the comment.');
  return { award: String(award), action, comment: text };
}

/**
 * Steps 1-4 with an open session. dryRun stops before step 3 and returns what would be sent.
 * Returns { sent, answer, before, after: { acceptance, list } }.
 */
export async function submitAwardAction(session, input, { host = 'https://philgeps.gov.ph', dryRun = false } = {}) {
  const { award, action, comment } = checkInput(input);
  const list = awardsList(host);

  // 1. Still waiting for our answer?
  const beforeList = await readList(session, list);
  const before = findAward(beforeList, award);
  if (!before) throw new PsSyncError('NOT_FOUND', `Award notice ${award} is not in My Award Notices on PS-PhilGEPS.`);
  if (!PENDING.test(before.acceptance)) {
    throw Object.assign(new PsSyncError('ALREADY', `Award notice ${award} is already "${before.acceptance}" on PS-PhilGEPS. Nothing was sent.`), { list: beforeList });
  }

  // 2. The pop-up's form, as the browser loads it when Accept Award / Refuse Award is clicked
  const popup = parse(await getPage(session, `${host}/merchantAwards/awardAction/${award}/${action}/${award}`, { ajax: true }));
  const field = (name) => popup.querySelector(`[name="${name}"]`)?.getAttribute('value') ?? null;
  const token = field('_csrfToken');
  const awardType = field('awardType');
  if (!token || field('awardId') !== award || field('type') !== action || !awardType || !popup.querySelector('textarea[name="comment_action"]')) {
    throw new PsSyncError('FORM_CHANGED', `PS-PhilGEPS's ${ACTIONS[action]} Award form is not what the system knows. Nothing was sent; do it on PS-PhilGEPS by hand.`);
  }
  const body = new URLSearchParams({ type: action, comment, awardType });
  if (dryRun) return { sent: false, wouldSend: { url: `${host}/MerchantAwards/saveAwardAction/${award}`, body: body.toString() }, before };

  // 3. Send once (no retry: a second send could act twice)
  let answer = null;
  let sendError = null;
  try {
    const res = await fetch(`${host}/MerchantAwards/saveAwardAction/${award}`, {
      method: 'POST',
      headers: {
        cookie: session.header(),
        'user-agent': USER_AGENT,
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': token,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: host,
        referer: `${host}/EventManagements/myAwardNotices`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
    session.update(res);
    const text = await res.text();
    if (isLoginPage(res, text)) throw new PsSyncError('NOT_CONNECTED', 'The PS-PhilGEPS session has ended. A person must connect again (captcha).');
    answer = text.trim().slice(0, 200);
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') throw e;
    sendError = e.message;
  }

  // 4. What PhilGEPS shows now decides the result (also when the answer was lost on the way)
  const afterList = await readList(session, list);
  const after = findAward(afterList, award);
  const done = after && !PENDING.test(after.acceptance);
  if (!done) {
    const why = sendError ? `no answer (${sendError})` : `answered "${answer || 'nothing'}"`;
    throw Object.assign(new PsSyncError('NOT_SAVED', `PS-PhilGEPS ${why} and still shows award notice ${award} as "${after?.acceptance || 'not listed'}". Check it on PS-PhilGEPS.`), { list: afterList });
  }
  return { sent: true, answer, before, after: { acceptance: after.acceptance, list: afterList } };
}

/**
 * The dashboard's Accept / Refuse: the saved session, the steps above, the refreshed award list saved to the
 * snapshot (every dashboard sees the new status), and an entry on the PS-PhilGEPS History page.
 */
export async function actOnAward(input, by, { dryRun = false } = {}) {
  const { award, action, comment } = checkInput(input);
  const supabase = admin();
  const { data: status } = await supabase.from('ps_sync_status').select('status, started_at').eq('id', 'latest').single();
  // The Sync uses the same session; two users of one session at once can end it (2026-10-22)
  if (status?.status === 'running' && Date.now() - new Date(status.started_at).getTime() < STALE_RUN_MS) {
    throw new PsSyncError('BUSY', 'A PS-PhilGEPS Sync is running. Try again when it finishes (about a minute).');
  }
  const { data: saved } = await supabase.from('ps_philgeps_session').select('cookies').eq('id', 'current').maybeSingle();
  if (!saved?.cookies?.length) throw new PsSyncError('NOT_CONNECTED', 'PS-PhilGEPS is not connected. Press Sync PS-PhilGEPS to log in first.');
  const session = new Session(saved.cookies);
  const savedPrint = session.fingerprint();

  // The award list as PhilGEPS shows it now, so every dashboard shows the new status at once
  const saveList = async (list) => {
    if (!list) return;
    const { data: snap } = await supabase.from('ps_philgeps_snapshot').select('lists').eq('id', 'latest').maybeSingle();
    if (snap?.lists) await supabase.from('ps_philgeps_snapshot').update({ lists: { ...snap.lists, awards: list }, updated_at: new Date().toISOString() }).eq('id', 'latest');
  };
  const verb = action === 'ACCEPT' ? 'Accepted' : 'Refused';
  try {
    const result = await submitAwardAction(session, { award, action, comment }, { dryRun });
    if (dryRun) return result;
    await saveList(result.after.list);
    const summary = `${verb} award notice ${award} (${result.before.lineItem}) on PS-PhilGEPS. PS-PhilGEPS now shows "${result.after.acceptance}".`;
    await logActivity({ event: 'ps-award', status: 'success', by, summary, details: { award, action, comment, line_item: result.before.lineItem, acceptance: result.after.acceptance } });
    return { award, action, acceptance: result.after.acceptance, summary };
  } catch (e) {
    await saveList(e.list);
    if (e.code === 'NOT_CONNECTED') {
      // Same as the Sync: forget the ended session so every dashboard shows "not connected"
      await supabase.from('ps_philgeps_session').delete().eq('id', 'current');
      await supabase.from('ps_sync_status').update({ connected_at: null }).eq('id', 'latest');
    }
    if (!dryRun && !['BAD_INPUT', 'ALREADY', 'BUSY'].includes(e.code)) {
      await logActivity({ event: 'ps-award', status: 'failed', by, summary: `${ACTIONS[action]} award notice ${award}: ${e.message}`, details: { award, action, comment } });
    }
    throw e;
  } finally {
    // PhilGEPS refreshes the session's cookies as pages are read; keep the shared copy current
    if (session.fingerprint() !== savedPrint) {
      await supabase.from('ps_philgeps_session').update({ cookies: session.cookies() }).eq('id', 'current').then(() => {}, () => {});
    }
  }
}
