'use client';

import WorkingDots from '@/components/WorkingDots';

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const LOOK = {
  // Before starting: is PhilGEPS up?
  checking: { ring: 'stroke-[#1EA0DA]', text: 'text-[#12769F]', title: 'Checking PhilGEPS…' },
  // Clicked while the automatic update runs: starts right after it
  queued: { ring: 'stroke-[#94A3B8]', text: 'text-[#12769F]', title: 'Sync waiting' },
  running: { ring: 'stroke-[#1EA0DA]', text: 'text-[#12769F]', title: 'Syncing with PhilGEPS' },
  // PhilGEPS was down, so nothing was started
  unavailable: { ring: 'stroke-[#94A3B8]', text: 'text-black/80', title: 'PhilGEPS is down — Sync not started' },
  success: { ring: 'stroke-[#61A644]', text: 'text-[#3F6F2C]', title: 'Sync complete' },
  // Finished, but something was left for later (e.g. the session time limit); blue, as amber is off-brand
  warning: { ring: 'stroke-[#1EA0DA]', text: 'text-[#12769F]', title: 'Synced with a warning' },
  failed: { ring: 'stroke-[#B3312C]', text: 'text-[#B3312C]', title: 'Sync failed' },
  // Stopped with the Cancel button (PhilGEPS: after a confirmed log-out)
  cancelling: { ring: 'stroke-[#94A3B8]', text: 'text-[#12769F]', title: 'Cancelling Sync' },
  cancelled: { ring: 'stroke-[#94A3B8]', text: 'text-black/80', title: 'Sync cancelled' },
};

// Bottom-left card with a progress ring for a Sync (log-in and documents; job from GET /api/scrape).
// A failed Sync, one that finished with a warning, one cancelled, or one not started because PhilGEPS is down,
// stays on screen until dismissed. raised: lifts the card above the automatic-update bar.
// title: replaces the status title (SyncAlertHost names the portal). inline: placed by the parent instead of fixed.
// onCancel: shows a Cancel button while the Sync runs (it stops the Sync; on PhilGEPS it also logs out).
export default function ScrapeProgress({ job, onDismiss, onCancel, raised = false, title, inline = false }) {
  const cancelling = job?.status === 'running' && job.cancelling;
  const look = LOOK[cancelling ? 'cancelling' : job?.status === 'success' && job.warning ? 'warning' : job?.status];
  if (!look) return null;

  const percent = Math.min(100, Math.max(0, job.percent || 0));
  const busy = ['running', 'checking', 'queued'].includes(job.status);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`${inline ? 'w-full' : `fixed ${raised ? 'bottom-14' : 'bottom-5'} left-5 z-40 w-80 max-w-[calc(100vw-2.5rem)]`} flex gap-3 items-start bg-white border border-[#E2E8F0] rounded-[14px] p-4 shadow-[0_4px_16px_rgba(0,0,0,0.08)]`}
    >
      <div className="relative h-12 w-12 shrink-0">
        <svg viewBox="0 0 48 48" className="h-12 w-12 -rotate-90">
          <circle cx="24" cy="24" r={RADIUS} fill="none" strokeWidth="4" className="stroke-[#E2E8F0]" />
          <circle
            cx="24"
            cy="24"
            r={RADIUS}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
            className={`${look.ring} transition-[stroke-dashoffset] duration-500`}
          />
        </svg>
        <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums ${look.text}`}>
          {job.status === 'failed' ? '!' : ['unavailable', 'cancelled'].includes(job.status) ? '–' : job.status === 'checking' || job.status === 'queued' || cancelling ? '…' : `${percent}%`}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className={`text-sm font-semibold ${look.text} flex items-center gap-1.5`}>
            {title || look.title}
            {busy && <WorkingDots />}
          </div>
          {!busy && (
            <button onClick={onDismiss} aria-label="Close" className="text-black/46 hover:text-black text-sm leading-none -mt-0.5">
              ×
            </button>
          )}
          {onCancel && job.status === 'running' && !cancelling && (
            <button
              onClick={onCancel}
              title="Stop the Sync. On PhilGEPS it stops after the tender in progress and logs out of PhilGEPS."
              className="shrink-0 text-xs font-semibold text-[#B3312C] border border-[#E2E8F0] hover:border-[#B3312C] rounded-full px-2.5 py-0.5 -mt-0.5"
            >
              Cancel
            </button>
          )}
        </div>
        {job.status === 'unavailable' ? (
          <p className="text-xs text-black/62 mt-1 break-words">
            {job.error} Nothing was changed. Try again in a few minutes.
          </p>
        ) : job.status === 'failed' ? (
          <p className="text-xs text-[#B3312C] mt-1 break-words max-h-28 overflow-y-auto">
            {job.stage && <span className="block text-black/62">Stopped at: {job.stage}</span>}
            {job.error || 'Unknown error'}
          </p>
        ) : job.status === 'success' && job.warning ? (
          <p className="text-xs text-black/62 mt-1 break-words max-h-28 overflow-y-auto">{job.warning}</p>
        ) : job.status === 'success' || job.status === 'cancelled' ? (
          <p className="text-xs text-black/80 mt-1 break-words">{job.stage}</p>
        ) : (
          <p className="text-xs text-black/62 mt-1 truncate" title={job.stage}>{job.stage}</p>
        )}
      </div>
    </div>
  );
}
