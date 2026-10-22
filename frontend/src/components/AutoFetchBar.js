'use client';

import WorkingDots from '@/components/WorkingDots';

// Thin loading bar along the bottom of the screen for the hourly automatic update (public data;
// job from GET /api/scrape with kind 'auto'). Quiet while it runs; a failure or a skipped step
// stays as a one-line note until closed.
export default function AutoFetchBar({ job, onDismiss }) {
  if (!job) return null;
  const running = job.status === 'running';
  const failed = job.status === 'failed' || job.status === 'unavailable';
  const percent = Math.min(100, Math.max(0, job.percent || 0));

  const message = running
    ? `Updating public data from PhilGEPS · ${percent}%${job.stage ? ` · ${job.stage}` : ''}`
    : job.status === 'unavailable'
      ? `Automatic update skipped: ${job.error} It tries again later this hour.`
      : failed
        ? `Automatic update failed: ${job.error || 'Unknown error'}`
        : job.warning
          ? `Public data updated. ${job.warning}`
          : 'Public data updated';

  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-0 z-30 bg-white/95 border-t border-[#E2E8F0]">
      <div className="h-1 bg-[#E2E8F0]">
        <div
          className={`h-full transition-[width] duration-500 ${failed ? 'bg-[#B3312C]' : running ? 'bg-[#1EA0DA]' : 'bg-[#61A644]'}`}
          style={{ width: `${failed ? 100 : percent}%` }}
        />
      </div>
      <div className="flex items-center gap-3 px-4 py-1.5 text-xs">
        {running && <WorkingDots className="bg-[#1EA0DA]" />}
        <span className={`flex-1 min-w-0 truncate ${failed ? 'text-[#B3312C]' : 'text-black/62'}`} title={message}>
          {message}
        </span>
        {!running && (
          <button onClick={onDismiss} aria-label="Close" className="shrink-0 text-black/46 hover:text-black leading-none">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
