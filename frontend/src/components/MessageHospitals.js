'use client';

import { useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import Modal from '@/components/Modal';

// Message Hospitals (Hospital List): one message, with images or files attached, e-mailed to every chosen hospital
// (api/hospitals/message, one e-mail per hospital to its own addresses). Two steps: write, then confirm.
const MAX_BYTES = 4 * 1024 * 1024; // same limit as the server (Vercel takes at most 4.5 MB per request)
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv';
const GROUPS = [
  ['active', 'Active tender'],
  ['rfq', 'RFQ'],
  ['prospect', 'Prospects'],
];

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const cancelButton = 'rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60';
const saveButton = 'rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60';
const label = 'text-xs font-semibold uppercase tracking-wider text-black/62';
const field = 'mt-1.5 w-full border border-[#CBD5E1] bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:border-[#1EA0DA] focus:outline-none focus:ring-2 focus:ring-[#1EA0DA]/25';

export default function MessageHospitals({ hospitals, onClose }) {
  const reachable = hospitals.filter((h) => !h.archived_at && h.emails.length);
  const noEmail = hospitals.filter((h) => !h.archived_at && !h.emails.length).length;
  const [chosen, setChosen] = useState(() => new Set(reachable.filter((h) => h.status !== 'prospect').map((h) => h.agency_key)));
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [step, setStep] = useState('write'); // write | confirm | sending | done
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const total = files.reduce((sum, f) => sum + f.size, 0);
  const picked = reachable.filter((h) => chosen.has(h.agency_key));
  const addresses = picked.reduce((n, h) => n + h.emails.length, 0);
  const ready = picked.length && subject.trim() && message.trim() && total <= MAX_BYTES;

  const toggle = (key) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChosen(next);
  };
  const group = (status) => reachable.filter((h) => h.status === status);
  const groupOn = (status) => group(status).length > 0 && group(status).every((h) => chosen.has(h.agency_key));
  const toggleGroup = (status) => {
    const next = new Set(chosen);
    const on = groupOn(status);
    for (const h of group(status)) {
      if (on) next.delete(h.agency_key);
      else next.add(h.agency_key);
    }
    setChosen(next);
  };

  const send = async () => {
    setStep('sending');
    setError('');
    try {
      const body = new FormData();
      body.append('subject', subject);
      body.append('message', message);
      body.append('keys', JSON.stringify(picked.map((h) => h.agency_key)));
      for (const f of files) body.append('files', f);
      const res = await authFetch('/api/hospitals/message', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.results) throw new Error(data.error || `Error ${res.status}`);
      setResult(data);
      setStep('done');
    } catch (e) {
      setError(e.message);
      setStep('confirm');
    }
  };

  const busy = step === 'sending';
  const failed = result?.results.filter((r) => r.status !== 'sent') || [];

  return (
    <Modal
      title="Message Hospitals"
      subtitle="One message, e-mailed to each chosen hospital at its own address."
      busy={busy}
      onClose={onClose}
      width="sm:max-w-2xl"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3.5 6.5l8.5 6 8.5-6" />
        </svg>
      }
      footer={
        step === 'done' ? (
          <button type="button" onClick={onClose} className={saveButton}>
            Close
          </button>
        ) : step === 'write' ? (
          <>
            <button type="button" onClick={onClose} className={cancelButton}>
              Cancel
            </button>
            <button type="button" onClick={() => setStep('confirm')} disabled={!ready} className={saveButton}>
              Review and send
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setStep('write')} disabled={busy} className={cancelButton}>
              Back
            </button>
            <button type="button" onClick={send} disabled={busy} className={saveButton}>
              {busy ? `Sending to ${picked.length} hospitals…` : `Send to ${picked.length} hospital${picked.length === 1 ? '' : 's'}`}
            </button>
          </>
        )
      }
    >
      {step === 'write' && (
        <div className="space-y-4">
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className={label}>Send to</span>
              <span className="text-xs text-black/62">
                {picked.length} hospital{picked.length === 1 ? '' : 's'} · {addresses} e-mail address{addresses === 1 ? '' : 'es'}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {GROUPS.map(([status, name]) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => toggleGroup(status)}
                  disabled={!group(status).length}
                  aria-pressed={groupOn(status)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
                    groupOn(status) ? 'border-[#1EA0DA] bg-[#1EA0DA]/8 text-[#12769F]' : 'border-[#CBD5E1] text-black/62 hover:bg-[#1EA0DA]/6'
                  }`}
                >
                  {groupOn(status) ? '✓ ' : ''}
                  {name} ({group(status).length})
                </button>
              ))}
            </div>
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-[14px] border border-[#E2E8F0] p-2">
              {reachable.map((h) => (
                <li key={h.agency_key}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1 text-xs hover:bg-[#1EA0DA]/4">
                    <input type="checkbox" checked={chosen.has(h.agency_key)} onChange={() => toggle(h.agency_key)} className="mt-0.5 accent-[#1EA0DA]" />
                    <span>
                      <span className="text-black">{h.name}</span>
                      <span className="block break-all text-black/46">{h.emails.join(', ')}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {noEmail > 0 && <p className="mt-1.5 text-xs text-black/46">{noEmail} hospital{noEmail === 1 ? ' has' : 's have'} no e-mail address yet and cannot be messaged here.</p>}
          </section>

          <label className="block">
            <span className={label}>
              Subject <span className="text-[#B3312C]">*</span>
            </span>
            <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. GetMeds product offer for {hospital}" className={`${field} rounded-full`} />
          </label>
          <label className="block">
            <span className={label}>
              Message <span className="text-[#B3312C]">*</span>
            </span>
            <textarea
              value={message}
              maxLength={10000}
              rows={8}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={'Good day, {hospital}!\n\n…'}
              className={`${field} resize-y rounded-[14px]`}
            />
            <span className="mt-1 block px-1 text-xs text-black/46">Write {'{hospital}'} where each hospital&apos;s own name should go.</span>
          </label>

          <section>
            <span className={label}>Attachments</span>
            <label className="mt-1.5 flex cursor-pointer items-center justify-center rounded-[14px] border border-dashed border-[#CBD5E1] px-4 py-3 text-xs font-medium text-[#12769F] transition hover:bg-[#1EA0DA]/6">
              + Add images or files
              <input
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  setFiles([...files, ...e.target.files]);
                  e.target.value = '';
                }}
              />
            </label>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-[#F8FAFC] px-3 py-1.5 text-xs">
                    <span className="min-w-0 truncate text-black">{f.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-black/46">
                      {size(f.size)}
                      <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="rounded px-1 text-black/62 hover:text-[#B3312C]">
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className={`mt-1.5 text-xs ${total > MAX_BYTES ? 'font-medium text-[#B3312C]' : 'text-black/46'}`}>
              {files.length ? `${size(total)} of 4 MB. ` : ''}Images, PDF, Word, Excel, PowerPoint, text or CSV; up to 4 MB together.
            </p>
          </section>
        </div>
      )}

      {(step === 'confirm' || step === 'sending') && (
        <div className="space-y-3">
          <section className="rounded-[14px] border border-[#E2E8F0] p-4 text-sm">
            <p className="text-black">
              <span className="font-semibold">{picked.length}</span> hospital{picked.length === 1 ? '' : 's'} will each get their own e-mail ({addresses} address{addresses === 1 ? '' : 'es'}). This cannot be undone.
            </p>
            <p className="mt-3 text-xs text-black/46">Subject</p>
            <p className="text-black">{subject.replaceAll('{hospital}', picked[0]?.name || '')}</p>
            <p className="mt-3 text-xs text-black/46">Message (as {picked[0]?.name} will see it)</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-black/85">{message.replaceAll('{hospital}', picked[0]?.name || '')}</p>
            {files.length > 0 && (
              <>
                <p className="mt-3 text-xs text-black/46">Attachments</p>
                <p className="text-black/85">{files.map((f) => f.name).join(', ')}</p>
              </>
            )}
          </section>
          {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
        </div>
      )}

      {step === 'done' && result && (
        <div className="space-y-3">
          <p className={`rounded-[14px] border px-4 py-3 text-sm ${result.sent ? 'border-[#61A644]/30 bg-[#61A644]/8 text-[#2F5321]' : 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]'}`}>
            Sent to {result.sent} of {result.results.length} hospital{result.results.length === 1 ? '' : 's'}.
          </p>
          {failed.length > 0 && (
            <ul className="space-y-1 rounded-[14px] border border-[#E2E8F0] p-3 text-xs">
              {failed.map((r) => (
                <li key={r.name}>
                  <span className="text-black">{r.name}</span>
                  <span className="block text-[#B3312C]">{r.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
