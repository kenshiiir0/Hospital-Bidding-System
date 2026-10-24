'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatInstant } from '@/lib/format';

const LATE_MS = 6 * 60 * 60 * 1000;

// Warns (PhilGEPS and PS-PhilGEPS pages) when scanned documents have waited more than 6 hours to be read
// with OCR, i.e. both automatic layers are behind or stopped (ocr_status, kept by scripts/ocr-job.mjs and
// lib/ocrVision.mjs). Says when each layer last ran, so the cause is visible. Nothing shows when all is well.
export default function OcrHealthNotice() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    // Whether it is late is worked out here (not while drawing, which must not read the clock)
    const load = () =>
      supabase
        .from('ocr_status')
        .select('*')
        .eq('id', 'latest')
        .maybeSingle()
        .then(({ data }) => {
          const late = data?.waiting > 0 && data.oldest_waiting_since && Date.now() - new Date(data.oldest_waiting_since).getTime() >= LATE_MS;
          setStatus(late ? data : null);
        });
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!status) return null;

  return (
    <div role="alert" className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">
      <b>{status.waiting} scanned document{status.waiting > 1 ? 's have' : ' has'} waited more than 6 hours to be read.</b>{' '}
      <span className="text-black/70">
        Hourly OCR (GitHub): {status.github_last_run_at ? `${formatInstant(status.github_last_run_at)} · ${status.github_last_result || ''}` : 'has not run yet'}.
        {' '}Google Vision backup: {status.vision_last_run_at ? `${formatInstant(status.vision_last_run_at)} · ${status.vision_last_result || ''}` : 'not used yet'}
        {status.vision_pages ? ` (${status.vision_pages} pages this month)` : ''}.
      </span>
    </div>
  );
}
