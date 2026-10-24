'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';

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

const DOT = { error: 'bg-[#B3312C]', busy: 'bg-[#1EA0DA] animate-pulse', ok: 'bg-[#61A644]', off: 'bg-black/30' };

// Report Log page: the OCR state of both sites as log lines, newest first: when it happened, a dot coloured by
// its state (red = needs attention, blue = working, green = fine, grey = not used yet) and what happened, so
// the cause of a late document is visible at a glance.
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

  const logs = [
    n > 0 && {
      at: status.oldest_waiting_since,
      tone: view.kind === 'late' ? 'error' : 'busy',
      text:
        view.kind === 'late'
          ? `${docs} ${n === 1 ? 'has' : 'have'} waited more than 6 hours to be read (the oldest since this time).`
          : `${docs} waiting to be read (the oldest since this time).`,
    },
    running && status.github_running_since && { at: status.github_running_since, tone: 'busy', text: `OCR on GitHub started reading ${docs}.` },
    status.github_requested_at && { at: status.github_requested_at, tone: 'off', text: 'A Sync asked OCR on GitHub to read the new scanned documents.' },
    status.github_last_run_at && { at: status.github_last_run_at, tone: 'ok', text: `OCR on GitHub: ${status.github_last_result || 'finished'}.` },
    status.vision_last_run_at && {
      at: status.vision_last_run_at,
      tone: 'ok',
      text: `Google Vision backup: ${status.vision_last_result || 'finished'}${status.vision_pages ? ` (${status.vision_pages} pages this month)` : ''}.`,
    },
  ]
    .filter(Boolean)
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  // What has not happened yet goes at the end, without a time
  if (!status.github_last_run_at) logs.push({ tone: 'off', text: 'OCR on GitHub has not run yet.' });
  if (!status.vision_last_run_at) logs.push({ tone: 'off', text: 'Google Vision backup: not used yet.' });
  if (!n) logs.unshift({ at: status.updated_at, tone: 'ok', text: 'No scanned documents waiting to be read.' });

  return (
    <ul className="divide-y divide-[#E2E8F0] overflow-hidden rounded-[14px] border border-[#E2E8F0] bg-white">
      {logs.map((log) => (
        <li
          key={log.text}
          role={log.tone === 'error' ? 'alert' : undefined}
          className={`flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-baseline sm:gap-4 ${log.tone === 'error' ? 'bg-[#B3312C]/4' : ''}`}
        >
          <span className="shrink-0 text-xs tabular-nums text-black/46 sm:w-44">{log.at ? formatInstant(log.at) : '—'}</span>
          <span className={`flex min-w-0 items-baseline gap-2 ${log.tone === 'error' ? 'font-medium text-[#B3312C]' : 'text-black/70'}`}>
            <span className={`h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full ${DOT[log.tone]}`} aria-hidden />
            {log.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
