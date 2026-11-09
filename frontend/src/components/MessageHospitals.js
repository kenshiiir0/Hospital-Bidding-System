'use client';

import { useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import Modal from '@/components/Modal';
import { MESSAGE_TEST_TO } from '@/lib/messageTestMode';
import { buildHospitalEmail, SEASONS, THEMES, themeFor, titleCase } from '@/lib/hospitalEmail.mjs';

// Message Hospitals (Hospital List): one message, with images or files attached, e-mailed to every chosen hospital
// (api/hospitals/message, one e-mail per hospital to its own addresses). Two steps: write, then confirm.
// A season card (Diwali, Christmas, New Year) picks the e-mail's design; beside the form, the preview shows the
// e-mail exactly as the chosen hospital will receive it (lib/hospitalEmail.mjs builds both).
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

// Test mode: the hospitals are deactivated (none ticked, none can be ticked); one test e-mail goes to MESSAGE_TEST_TO
const TEST = !!MESSAGE_TEST_TO;

export default function MessageHospitals({ hospitals, onClose }) {
  const reachable = hospitals.filter((h) => !h.archived_at && h.emails.length);
  const noEmail = hospitals.filter((h) => !h.archived_at && !h.emails.length).length;
  const [chosen, setChosen] = useState(() => (TEST ? new Set() : new Set(reachable.filter((h) => h.status !== 'prospect').map((h) => h.agency_key))));
  // Opens with this month's season and its greeting (the standard design, empty, outside the season months)
  const [subject, setSubject] = useState(() => THEMES[themeFor()].sample?.subject || '');
  const [message, setMessage] = useState(() => THEMES[themeFor()].sample?.message || '');
  const [files, setFiles] = useState([]);
  const [theme, setTheme] = useState(() => themeFor());
  const [previewKey, setPreviewKey] = useState('');
  const [step, setStep] = useState('write'); // write | confirm | sending | done
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const total = files.reduce((sum, f) => sum + f.size, 0);
  const picked = reachable.filter((h) => chosen.has(h.agency_key));
  const addresses = picked.reduce((n, h) => n + h.emails.length, 0);
  const ready = (TEST || picked.length) && subject.trim() && message.trim() && total <= MAX_BYTES;
  const thisMonth = themeFor();
  // Preview "All selected hospitals" (the default), with (Hospital Name) where each hospital's own name goes, or one of
  // them. In test mode it is the one test e-mail, with {hospital} as "Sample Hospital" like the server sends it.
  const previewHospital = TEST ? null : picked.length === 1 ? picked[0] : picked.find((h) => h.agency_key === previewKey) || null;
  const placeholderName = '(Hospital Name)';
  const previewName = TEST ? 'Sample Hospital' : previewHospital?.name || placeholderName;
  const fill = (s) => s.replaceAll('{hospital}', titleCase(previewName));
  const preview = buildHospitalEmail({
    subject: fill(subject),
    message: fill(message),
    hospital: previewName,
    files,
    theme,
    src: (file) => `/email/${file}`,
    includeFont: false, // Gmail shows Arial, so the preview does too
  });

  // A season card picks its design (again: back to the standard design). The subject and message follow the season's
  // greeting while they are empty or still another season's untouched greeting; anything typed is kept.
  const pickSeason = (key) => {
    const next = theme === key ? 'standard' : key;
    setTheme(next);
    const greeting = THEMES[next].sample || { subject: '', message: '' };
    const untouched = (value, part) => !value.trim() || SEASONS.some((k) => value === THEMES[k].sample[part]);
    if (untouched(subject, 'subject')) setSubject(greeting.subject);
    if (untouched(message, 'message')) setMessage(greeting.message);
  };

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
      body.append('theme', theme);
      body.append('keys', JSON.stringify(TEST ? [] : picked.map((h) => h.agency_key)));
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
      subtitle={
        TEST
          ? `Test mode: messages go only to ${MESSAGE_TEST_TO}, not to the hospitals.`
          : 'One message, e-mailed to each chosen hospital at its own address.'
      }
      busy={busy}
      onClose={onClose}
      width="sm:max-w-6xl"
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
              {TEST
                ? busy
                  ? `Sending test to ${MESSAGE_TEST_TO}…`
                  : `Send test to ${MESSAGE_TEST_TO}`
                : busy
                  ? `Sending to ${picked.length} hospitals…`
                  : `Send to ${picked.length} hospital${picked.length === 1 ? '' : 's'}`}
            </button>
          </>
        )
      }
    >
      <div className={step === 'done' ? '' : 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}>
      <div className="min-w-0">
      {step === 'write' && (
        <div className="space-y-4">
          {TEST && (
            <p role="status" className="rounded-[14px] border border-[#F0D58C] bg-[#FFF4DB] px-4 py-3 text-xs leading-relaxed text-[#7A4B00]">
              <span className="font-semibold">Testing only.</span> Messaging is routed only to <span className="font-semibold">{MESSAGE_TEST_TO}</span>. The hospitals below are
              deactivated for now: no hospital will receive this message. {'{hospital}'} is shown as &ldquo;Sample Hospital&rdquo; in the test e-mail.
            </p>
          )}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className={label}>Send to</span>
              <span className="text-xs text-black/62">
                {TEST ? `${MESSAGE_TEST_TO} only` : `${picked.length} hospital${picked.length === 1 ? '' : 's'} · ${addresses} e-mail address${addresses === 1 ? '' : 'es'}`}
              </span>
            </div>
            <fieldset disabled={TEST} className={TEST ? 'opacity-50' : ''}>
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
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setChosen(new Set(reachable.map((h) => h.agency_key)))}
                  disabled={picked.length === reachable.length}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-[#12769F] transition hover:bg-[#1EA0DA]/6 disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setChosen(new Set())}
                  disabled={!picked.length}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-[#12769F] transition hover:bg-[#1EA0DA]/6 disabled:opacity-40"
                >
                  Clear all
                </button>
              </span>
            </div>
            <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-[14px] border border-[#E2E8F0] p-2">
              {reachable.map((h) => (
                <li key={h.agency_key}>
                  <label className={`flex items-start gap-2 rounded-lg px-2 py-1 text-xs ${TEST ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[#1EA0DA]/4'}`}>
                    <input type="checkbox" checked={chosen.has(h.agency_key)} onChange={() => toggle(h.agency_key)} className="mt-0.5 accent-[#1EA0DA]" />
                    <span>
                      <span className="text-black">{h.name}</span>
                      <span className="block break-all text-black/46">{h.emails.join(', ')}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            </fieldset>
            {!TEST && noEmail > 0 && <p className="mt-1.5 text-xs text-black/46">{noEmail} hospital{noEmail === 1 ? ' has' : 's have'} no e-mail address yet and cannot be messaged here.</p>}
          </section>

          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className={label}>Season design</span>
              <span className="text-xs text-black/46">{theme === 'standard' ? 'Standard Getmeds design' : `${THEMES[theme].name} border and greeting`}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {SEASONS.map((key) => {
                const t = THEMES[key];
                const on = theme === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => pickSeason(key)}
                    aria-pressed={on}
                    className={`overflow-hidden rounded-[14px] border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30 ${
                      on ? 'shadow-md' : 'border-[#E2E8F0] hover:border-[#CBD5E1] hover:shadow-sm'
                    }`}
                    style={on ? { borderColor: t.frame, boxShadow: `0 0 0 1px ${t.frame}` } : undefined}
                  >
                    <span className="relative block h-16 overflow-hidden" style={{ backgroundColor: t.backdrop }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/email/${t.images.corner}`} alt="" className="absolute -top-2 right-0 h-24 w-auto" />
                      {key === thisMonth && (
                        <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm" style={{ color: t.accent }}>
                          This month
                        </span>
                      )}
                    </span>
                    <span className="block px-3 py-2" style={on ? { backgroundImage: t.headerGradient, color: '#fff' } : undefined}>
                      <span className={`block text-sm font-semibold ${on ? '' : 'text-black'}`}>
                        {on ? '✓ ' : ''}
                        {t.name}
                      </span>
                      <span className={`block text-xs ${on ? 'text-white/85' : 'text-black/46'}`}>{t.month}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 px-1 text-xs text-black/46">Click the chosen card again for the standard design. The subject and message follow the chosen season&apos;s greeting until you change them.</p>
          </section>

          <label className="block">
            <span className={label}>
              Subject <span className="text-[#B3312C]">*</span>
            </span>
            <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Getmeds product offer for {hospital}" className={`${field} rounded-full`} />
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
              placeholder={'We would like to share our latest offer with {hospital}…'}
              className={`${field} resize-y rounded-[14px]`}
            />
            <span className="mt-1 block px-1 text-xs text-black/46">
              The e-mail already opens with &ldquo;Dear (hospital),&rdquo;. Write {'{hospital}'} where each hospital&apos;s own name should go.
            </span>
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
              {TEST ? (
                <>
                  One test e-mail goes to <span className="font-semibold">{MESSAGE_TEST_TO}</span> only. No hospital will receive it.
                </>
              ) : (
                <>
                  <span className="font-semibold">{picked.length}</span> hospital{picked.length === 1 ? '' : 's'} will each get their own e-mail ({addresses} address{addresses === 1 ? '' : 'es'}). This cannot be undone.
                </>
              )}
            </p>
            <p className="mt-3 text-xs text-black/46">Subject</p>
            <p className="text-black">{subject.replaceAll('{hospital}', previewName)}</p>
            <p className="mt-3 text-xs text-black/46">Message (as {previewName} will see it)</p>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-black/85">{message.replaceAll('{hospital}', previewName)}</p>
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

      </div>

      {step !== 'done' && (
        <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className={label}>Preview</span>
            {picked.length > 1 ? (
              <label className="flex min-w-0 items-center gap-1.5 text-xs text-black/62">
                As
                <select
                  value={previewHospital?.agency_key || ''}
                  onChange={(e) => setPreviewKey(e.target.value)}
                  className="min-w-0 max-w-[16rem] truncate rounded-full border border-[#CBD5E1] bg-white px-2.5 py-1 text-xs text-black focus:border-[#1EA0DA] focus:outline-none"
                >
                  <option value="">All selected hospitals ({picked.length})</option>
                  {picked.map((h) => (
                    <option key={h.agency_key} value={h.agency_key}>
                      {h.name}
                    </option>
                  ))}
                </select>
                will see it
              </label>
            ) : (
              <span className="text-xs text-black/46">{TEST ? `The test e-mail, as ${MESSAGE_TEST_TO} will see it` : previewHospital ? `As ${previewHospital.name} will see it` : ''}</span>
            )}
          </div>
          <div className="mt-2 overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-[#F8FAFC]">
            <div className="space-y-0.5 border-b border-[#E2E8F0] bg-white px-4 py-2.5 text-xs">
              <p className="truncate">
                <span className="text-black/46">To: </span>
                <span className="text-black">
                  {TEST
                    ? MESSAGE_TEST_TO
                    : previewHospital
                    ? previewHospital.emails.join(', ')
                    : picked.length
                      ? `${picked.length} hospitals, each at its own address: ${picked.flatMap((h) => h.emails).join(', ')}`
                      : '—'}
                </span>
              </p>
              {!previewHospital && picked.length > 1 && (
                <p className="text-black/46">Each hospital gets its own e-mail, with its name where {placeholderName} is shown.</p>
              )}
              <p className="truncate">
                <span className="text-black/46">Subject: </span>
                <span className="font-semibold text-black">{fill(subject) || '(no subject yet)'}</span>
              </p>
            </div>
            <EmailFrame html={preview.html} />
          </div>
        </aside>
      )}
      </div>

      {step === 'done' && result && (
        <div className="space-y-3">
          <p className={`rounded-[14px] border px-4 py-3 text-sm ${result.sent ? 'border-[#61A644]/30 bg-[#61A644]/8 text-[#2F5321]' : 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]'}`}>
            {TEST
              ? result.sent
                ? `Test e-mail sent to ${MESSAGE_TEST_TO}. No hospital received it.`
                : `The test e-mail to ${MESSAGE_TEST_TO} was not sent.`
              : `Sent to ${result.sent} of ${result.results.length} hospital${result.results.length === 1 ? '' : 's'}.`}
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

// The e-mail drawn at its real 640px width and scaled down to fit the preview column
const EMAIL_WIDTH = 640;
function EmailFrame({ html }) {
  const box = useRef(null);
  const frame = useRef(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(900);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / EMAIL_WIDTH));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const measure = () => {
    const doc = frame.current?.contentDocument;
    if (doc) setHeight(doc.documentElement.scrollHeight);
  };

  return (
    <div ref={box} className="max-h-[62dvh] overflow-y-auto overscroll-contain">
      <div style={{ height: height * scale }}>
        <iframe
          ref={frame}
          title="E-mail preview"
          sandbox="allow-same-origin"
          onLoad={measure}
          srcDoc={`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff">${html}</body></html>`}
          style={{ width: EMAIL_WIDTH, height, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0, display: 'block' }}
        />
      </div>
    </div>
  );
}
