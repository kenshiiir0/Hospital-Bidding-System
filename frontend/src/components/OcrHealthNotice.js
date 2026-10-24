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

// Report Log page: the OCR state of both sites, always shown: red when a scanned document has waited more
// than 6 hours, blue while reading, green when nothing waits; with when each layer last ran, so the cause is visible.
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
  const head = {
    late: { box: 'border-[#B3312C]/25 bg-[#B3312C]/6 text-[#B3312C]', text: `${n} scanned document${n > 1 ? 's have' : ' has'} waited more than 6 hours to be read.` },
    reading: { box: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/6 text-[#12769F]', text: `Reading ${n} scanned document${n > 1 ? 's' : ''} (OCR)` },
    ok: {
      box: 'border-[#61A644]/25 bg-[#61A644]/8 text-[#3F6F2C]',
      text: n ? `${n} scanned document${n > 1 ? 's' : ''} waiting, less than 6 hours.` : 'No scanned documents waiting to be read.',
    },
  }[view.kind];

  return (
    <div role={view.kind === 'late' ? 'alert' : 'status'} className={`rounded-[14px] border px-4 py-3 text-sm ${head.box}`}>
      <b className="inline-flex items-center gap-2">
        {head.text} {view.kind === 'reading' && <WorkingDots />}
      </b>{' '}
      <span className="text-black/70">
        OCR on GitHub: {status.github_last_run_at ? `${formatInstant(status.github_last_run_at)} · ${status.github_last_result || ''}` : 'has not run yet'}.
        {' '}Google Vision backup: {status.vision_last_run_at ? `${formatInstant(status.vision_last_run_at)} · ${status.vision_last_result || ''}` : 'not used yet'}
        {status.vision_pages ? ` (${status.vision_pages} pages this month)` : ''}.
      </span>
      {n > 0 && status.oldest_waiting_since && (
        <span className="mt-1 block text-xs text-black/62">Oldest waiting since {formatInstant(status.oldest_waiting_since)}.</span>
      )}
    </div>
  );
}
