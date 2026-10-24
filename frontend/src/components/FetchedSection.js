'use client';

import { formatInstant } from '@/lib/format';
import { KeyValueList, PanelSection } from '@/components/PsDetailsPanel';

// "Fetched" in View details (PhilGEPS and PS-PhilGEPS): when this tender's data was fetched, whether that
// was the automatic fetch or someone's Sync, and when the next automatic fetch runs. The automatic fetches
// are Supabase cron jobs (Philippine time, every day): PhilGEPS update at :00 and PS-PhilGEPS Sync at :15,
// each hourly from 6 AM to 5 PM. Keep `minute` in step with those jobs.
// items: [[label, value]] shown first.
export default function FetchedSection({ items, minute }) {
  return (
    <PanelSection title="Fetched">
      <KeyValueList
        missing="Not yet"
        items={[
          ...items,
          ['Automatic fetch', `On · every hour at :${String(minute).padStart(2, '0')}, ${hourLabel(6, minute)}–${hourLabel(17, minute)}`],
          ['Next automatic fetch', formatInstant(nextRun(minute))],
        ]}
      />
    </PanelSection>
  );
}

// "Automatic" for the schedule, else the team member who pressed Sync (their username)
export function startedByLabel(startedBy) {
  if (!startedBy) return null;
  if (startedBy === 'schedule') return 'Automatic';
  return `Sync by ${startedBy.replace(/@users\.opportunity-radar\.invalid$/, '')}`;
}

const PH_OFFSET_MS = 8 * 60 * 60 * 1000; // Philippine time, no daylight saving
const FIRST_HOUR = 6;
const LAST_HOUR = 17;

const hourLabel = (h, minute) => `${h % 12 || 12}:${String(minute).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

// The next hourly run between 6 AM and 5 PM Philippine time
function nextRun(minute, now = Date.now()) {
  const ph = new Date(now + PH_OFFSET_MS);
  for (let day = 0; day < 2; day++) {
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
      const at = Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth(), ph.getUTCDate() + day, h, minute) - PH_OFFSET_MS;
      if (at > now) return new Date(at).toISOString();
    }
  }
  return null;
}
