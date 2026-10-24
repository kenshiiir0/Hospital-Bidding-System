'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInstant } from '@/lib/format';
import WorkingDots from '@/components/WorkingDots';

const LATE_MS = 6 * 60 * 60 * 1000;
const RUN_MAX_MS = 70 * 60 * 1000; // the OCR job stops at 60 minutes
const REQUEST_SHOWN_MS = 15 * 60 * 1000; // GitHub takes a few minutes to start a requested run

// PhilGEPS and PS-PhilGEPS pages, from ocr_status (kept by scripts/ocr-job.mjs, lib/ocrTrigger.mjs and
// lib/ocrVision.mjs):
// - blue while scanned documents are being read with OCR (a run started after a Sync, or the hourly one),
// - red when a scanned document has waited more than 6 hours (both automatic layers behind or stopped),
//   with when each layer last ran, so the cause is visible.
// Nothing shows when all is well.
export default function OcrHealthNotice() {
  // { kind: 'reading' | 'late', status } or null; worked out when loading (drawing must not read the clock)
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
            setView(null);
          }
        });
    load();
    // Live: the bar appears and goes the moment an OCR run starts or ends (Supabase Realtime); the timer also
    // turns the "reading" bar into the 6-hour warning as time passes
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

  if (!view) return null;
  const { status } = view;

  if (view.kind === 'reading') {
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

  return (
    <div role="alert" className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">
      <b>{status.waiting} scanned document{status.waiting > 1 ? 's have' : ' has'} waited more than 6 hours to be read.</b>{' '}
      <span className="text-black/70">
        OCR on GitHub: {status.github_last_run_at ? `${formatInstant(status.github_last_run_at)} · ${status.github_last_result || ''}` : 'has not run yet'}.
        {' '}Google Vision backup: {status.vision_last_run_at ? `${formatInstant(status.vision_last_run_at)} · ${status.vision_last_result || ''}` : 'not used yet'}
        {status.vision_pages ? ` (${status.vision_pages} pages this month)` : ''}.
      </span>
    </div>
  );
}
