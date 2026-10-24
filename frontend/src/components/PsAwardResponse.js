'use client';

import { useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { PanelSection } from '@/components/PsDetailsPanel';
import WorkingDots from '@/components/WorkingDots';

// PS-PhilGEPS's own rule for the comment (lib/psAward.mjs): required, 200 characters, letters, digits, spaces
const COMMENT_MAX = 200;
const allowed = (text) => text.replace(/[^A-Za-z0-9 ]/g, '').slice(0, COMMENT_MAX);

const ACTIONS = {
  ACCEPT: { verb: 'Accept', comment: 'We accept the award', button: 'bg-[#61A644] hover:bg-[#4F8C36] text-white' },
  REFUSE: { verb: 'Refuse', comment: '', button: 'bg-[#B3312C] hover:bg-[#962824] text-white' },
};

/**
 * Accept / Refuse for an award notice still "Pending for Acceptance", in its View details drawer. Three steps:
 * choose, write the comment PS-PhilGEPS asks for, confirm; then POST /api/ps-award sends it to PS-PhilGEPS and
 * answers once PS-PhilGEPS shows the new status. onDone: reload the award list.
 */
export default function PsAwardResponse({ award, lineItem, connected, syncing, onDone }) {
  const [action, setAction] = useState(null);
  const [comment, setComment] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const choose = (next) => {
    setAction(next);
    setComment(ACTIONS[next].comment);
    setConfirming(false);
    setResult(null);
  };

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const res = await authFetch('/api/ps-award', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ award, action, comment: comment.trim() }),
      });
      const data = await res.json();
      setResult(data.ok ? { ok: true, text: `Done. PS-PhilGEPS now shows award notice ${award} as "${data.acceptance}".` } : { ok: false, text: data.error || `Not sent (${res.status}).` });
      setConfirming(false);
      // Also after a refusal by PhilGEPS: the list was re-read and may show a new status
      onDone?.();
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setSending(false);
    }
  };

  if (result?.ok) {
    return (
      <PanelSection title="Award acceptance">
        <p role="status" className="rounded-xl border border-[#61A644]/30 bg-[#61A644]/10 p-3 text-xs font-medium text-[#3F6F2C]">{result.text}</p>
      </PanelSection>
    );
  }

  const blocked = !connected ? 'PS-PhilGEPS is not connected. Press Sync PS-PhilGEPS above to log in first.' : syncing ? 'A Sync is running. Accept / Refuse is available again when it finishes.' : '';
  const a = action && ACTIONS[action];
  const text = comment.trim();

  return (
    <PanelSection title="Award acceptance" tone="blue">
      <p className="text-xs text-black/62">
        PS-PhilGEPS is waiting for our answer. What you choose here is sent to PS-PhilGEPS, the same as Select → Accept Award / Refuse Award there.
      </p>

      {!action && (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(ACTIONS).map(([key, x]) => (
            <button
              key={key}
              type="button"
              disabled={Boolean(blocked)}
              onClick={() => choose(key)}
              className={`rounded-lg px-4 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${x.button}`}
            >
              {x.verb} award
            </button>
          ))}
        </div>
      )}

      {action && !confirming && (
        <div className="mt-3 space-y-2">
          <label htmlFor="award-comment" className="block text-xs font-semibold text-black">
            Comment for PS-PhilGEPS <span className="text-[#B3312C]">*</span>
          </label>
          <textarea
            id="award-comment"
            value={comment}
            onChange={(e) => setComment(allowed(e.target.value))}
            rows={3}
            placeholder={action === 'REFUSE' ? 'Reason for refusing' : 'Comment'}
            className="w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-sm text-black outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/20"
          />
          <p className="text-[11px] text-black/46">
            Letters, numbers and spaces only (PS-PhilGEPS&rsquo;s rule) · {comment.length}/{COMMENT_MAX}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setAction(null)} className="rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6">
              Back
            </button>
            <button
              type="button"
              disabled={!text || Boolean(blocked)}
              onClick={() => setConfirming(true)}
              className={`rounded-lg px-4 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${a.button}`}
            >
              {a.verb} award…
            </button>
          </div>
        </div>
      )}

      {action && confirming && (
        <div role="alertdialog" aria-label={`${a.verb} award notice ${award}`} className="mt-3 space-y-3 rounded-xl border border-[#E2E8F0] bg-white p-3">
          <p className="text-sm font-semibold text-black">
            {a.verb} award notice {award}{lineItem ? ` (${lineItem})` : ''} on PS-PhilGEPS?
          </p>
          <p className="text-xs text-black/62">
            Comment: &ldquo;{text}&rdquo;. This is sent to PS-PhilGEPS now and can&rsquo;t be undone from here.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={sending} onClick={() => setConfirming(false)} className="rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-50">
              Cancel
            </button>
            <button
              type="button"
              disabled={sending || Boolean(blocked)}
              onClick={send}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-70 ${a.button}`}
            >
              {sending ? (
                <>Sending to PS-PhilGEPS <WorkingDots /></>
              ) : (
                `Yes, ${a.verb.toLowerCase()} on PS-PhilGEPS`
              )}
            </button>
          </div>
        </div>
      )}

      {blocked && <p className="mt-2 text-xs text-[#B3312C]">{blocked}</p>}
      {result && !result.ok && (
        <p role="alert" className="mt-2 rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3 text-xs text-[#B3312C]">
          {result.text}
        </p>
      )}
    </PanelSection>
  );
}
