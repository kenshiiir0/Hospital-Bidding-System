'use client';

import { KeyValueList, PanelSection } from '@/components/PsDetailsPanel';

// "Fetched" in View details (PhilGEPS and PS-PhilGEPS): when this tender's data was fetched and whether
// that was the automatic fetch or someone's Sync. items: [[label, value]].
export default function FetchedSection({ items }) {
  return (
    <PanelSection title="Fetched">
      <KeyValueList missing="Not yet" items={items} />
    </PanelSection>
  );
}

// "Automatic" for the schedule, else the team member who pressed Sync (their username)
export function startedByLabel(startedBy) {
  if (!startedBy) return null;
  if (startedBy === 'schedule') return 'Automatic';
  return `Sync by ${startedBy.replace(/@users\.opportunity-radar\.invalid$/, '')}`;
}
