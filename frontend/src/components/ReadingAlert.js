'use client';

import { isLowAccuracy, LOW_ACCURACY } from '@/lib/readingAccuracy.mjs';

// The "Check reading" alert (user, 2026-11-13): a tender whose documents were read at LOW_ACCURACY (70%) or below,
// both portals (lib/readingAccuracy.mjs). The percentage itself is not shown anywhere else; only these show it.
// Nothing while scanned files are still being read (OCR): the row says "Reading scans (OCR)" then.

const tip = (accuracy) => `Reading accuracy ${accuracy.percent}% (alert at ${LOW_ACCURACY}% or below). ${accuracy.reasons.join(' · ')}`;

/** On a list row (Bid Match, Screened Tenders), under the documents count */
export function ReadingAlertTag({ accuracy, reading = false }) {
  if (reading || !isLowAccuracy(accuracy)) return null;
  return (
    <span title={tip(accuracy)} className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-[#B3312C]/25 bg-[#B3312C]/6 px-2 py-0.5 text-[11px] font-semibold text-[#B3312C]">
      <span aria-hidden>⚠</span> Check reading
    </span>
  );
}

/** In View details, at the top of the Molecule tracker: what to check against the documents */
export function ReadingAlertBox({ accuracy, reading = false }) {
  if (reading || !isLowAccuracy(accuracy)) return null;
  return (
    <div role="alert" className="mb-3 rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3 text-xs">
      <p className="font-semibold text-[#B3312C]">
        ⚠ Check reading: the documents were read at {accuracy.percent}% accuracy
      </p>
      <p className="mt-0.5 text-black/62">Compare the lines below with the documents before using them.</p>
      {accuracy.reasons.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-black/80">
          {accuracy.reasons.map((r) => (
            <li key={r} className="break-words">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
