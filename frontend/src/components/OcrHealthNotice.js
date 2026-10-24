'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';
import { StatusPill } from '@/components/PageHeader';

const LATE_MS = 6 * 60 * 60 * 1000;
const RUN_MAX_MS = 70 * 60 * 1000; // the OCR job stops at 60 minutes
const REQUEST_SHOWN_MS = 15 * 60 * 1000; // GitHub takes a few minutes to start a requested run

// The 'latest' row of ocr_status (kept by scripts/ocr-job.mjs, lib/ocrTrigger.mjs and lib/ocrVision.mjs), live:
// { kind: 'reading' | 'late' | 'ok', status } or null while loading; worked out when loading (drawing must not
// read the clock)
// - reading: scanned documents are being read with OCR (a run started after a Sync, or the hourly one),
// - late: a scanned document has waited more than 6 hours (both automatic layers behind or stopped).
function useOcrStatus() {
  const [view, setView] = useState(null);

  useEffect(() => {
    const load = () =>
      supabase
        .from('ocr_status')
        .select('*')
        .eq('id', 'latest')
        .maybeSingle()
        .then(({ data }) => {
          const ago = (at) => (at ? Date.now() - new Date(at).getTime() : Infinity);
          if (data && (ago(data.github_running_since) < RUN_MAX_MS || ago(data.github_requested_at) < REQUEST_SHOWN_MS) && data.waiting > 0) {
            setView({ kind: 'reading', status: data });
          } else if (data?.waiting > 0 && ago(data.oldest_waiting_since) >= LATE_MS) {
            setView({ kind: 'late', status: data });
          } else {
            setView({ kind: 'ok', status: data || {} });
          }
        });
    load();
    // Live: changes the moment an OCR run starts or ends (Supabase Realtime); the timer also turns
    // "reading" into the 6-hour warning as time passes
    const channel = supabase
      .channel(`ocr_status_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ocr_status' }, load)
      .subscribe();
    const timer = setInterval(load, 60 * 1000);
    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  return view;
}

// PhilGEPS and PS-PhilGEPS pages: a blue bar while scanned documents are being read with OCR. Nothing shows
// otherwise; the 6-hour warning and the OCR layers' last runs are on the Report Log page (OcrReport).
export default function OcrHealthNotice() {
  const view = useOcrStatus();
  if (view?.kind !== 'reading') return null;
  const { status } = view;
  return (
    <div role="status" className="rounded-[14px] border border-[#1EA0DA]/25 bg-[#1EA0DA]/6 px-4 py-3 text-sm text-[#12769F]">
      <span className="inline-flex items-center gap-2 font-medium">
        Reading {status.waiting} scanned document{status.waiting > 1 ? 's' : ''} (OCR) <WorkingDots />
      </span>
      <span className="block text-xs text-black/62 mt-0.5">
        {status.github_running_since ? `Started ${formatInstant(status.github_running_since)}` : 'Starting after the last Sync'}. Their
        products and dates appear in View details when it finishes.
      </span>
    </div>
  );
}

const CIRCLE = {
  error: 'bg-[#B3312C] text-white',
  busy: 'bg-[#1EA0DA] text-white',
  ok: 'bg-[#61A644] text-white',
  off: 'border border-[#CBD5E1] bg-white text-black/62',
};

// Report Log page: the OCR state of both sites as a numbered log, always shown. Each row: its number in a
// circle coloured by its state (red = needs attention, blue = working, green = fine, grey = not used yet),
// what it is, a status pill and the details, so the cause of a late document is visible at a glance.
export function OcrReport() {
  const view = useOcrStatus();
  if (!view) {
    return (
      <div className="rounded-[14px] border border-[#E2E8F0] bg-white px-4 py-3 text-sm text-black/62">
        Loading <WorkingDots />
      </div>
    );
  }
  const { status } = view;
  const n = status.waiting || 0;
  const docs = `${n} scanned document${n === 1 ? '' : 's'}`;
  const running = view.kind === 'reading';

  const rows = [
    {
      title: 'Scanned documents waiting',
      tone: view.kind === 'late' ? 'error' : running ? 'busy' : 'ok',
      pill: view.kind === 'late' ? 'Waited over 6 hours' : running ? 'Reading now' : n ? 'On time' : 'None waiting',
      detail:
        view.kind === 'late'
          ? `${docs} ${n === 1 ? 'has' : 'have'} waited more than 6 hours to be read.`
          : running
            ? `Reading ${docs} (OCR); their products and dates appear in View details when it finishes.`
            : n
              ? `${docs} waiting, less than 6 hours.`
              : 'Every scanned document has been read.',
      note: n > 0 && status.oldest_waiting_since ? `Oldest waiting since ${formatInstant(status.oldest_waiting_since)}` : null,
    },
    {
      title: 'OCR on GitHub',
      tone: running ? 'busy' : status.github_last_run_at ? 'ok' : 'off',
      pill: running ? 'Running' : status.github_last_run_at ? 'Ran' : 'Not run yet',
      detail: status.github_last_run_at ? status.github_last_result || 'Finished.' : 'Has not run yet.',
      note: running && status.github_running_since
        ? `Started ${formatInstant(status.github_running_since)}`
        : status.github_last_run_at ? `Last run ${formatInstant(status.github_last_run_at)}` : null,
    },
    {
      title: 'Google Vision backup',
      tone: status.vision_last_run_at ? 'ok' : 'off',
      pill: status.vision_last_run_at ? 'Used' : 'Not used yet',
      detail: status.vision_last_run_at
        ? status.vision_last_result || 'Finished.'
        : 'Reads documents still waiting after 6 hours; it has not been needed yet.',
      note: [
        status.vision_last_run_at && `Last run ${formatInstant(status.vision_last_run_at)}`,
        status.vision_pages ? `${status.vision_pages} pages this month` : null,
      ].filter(Boolean).join(' · ') || null,
    },
  ];

  return (
    <ol className="divide-y divide-[#E2E8F0] overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-white">
      {rows.map((row, i) => (
        <li key={row.title} role={row.tone === 'error' ? 'alert' : undefined} className={`flex items-start gap-3 px-4 py-3.5 ${row.tone === 'error' ? 'bg-[#B3312C]/4' : ''}`}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold ${CIRCLE[row.tone]}`} aria-hidden>
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="text-sm font-semibold text-black">{row.title}</span>
              <StatusPill tone={row.tone} text={row.pill} />
              {row.tone === 'busy' && <WorkingDots />}
            </div>
            <p className={`mt-1 text-sm ${row.tone === 'error' ? 'font-medium text-[#B3312C]' : 'text-black/70'}`}>{row.detail}</p>
            {row.note && <p className="mt-0.5 text-xs text-black/46">{row.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
