'use client';

import { useState } from 'react';
import { addScreened, removeScreened, useScreened } from '@/lib/screened';
import WorkingDots from '@/components/WorkingDots';

// "Add to Screened" in a tender's View details footer: puts the tender on the Screened Tenders page (lib/screened.js),
// where the Excel export is. Once added it reads "✓ Screened" and a second click takes it off again.
// getTender(): the tender in export shape (philgepsTender / psTender), saved as it is now; products: our products in it.
export default function ScreenButton({ source, tenderRef, title, products, getTender }) {
  const { rows, has } = useScreened();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!tenderRef) return null;
  const screened = has(source, tenderRef);

  const toggle = async () => {
    setSaving(true);
    setError('');
    try {
      if (screened) await removeScreened(source, tenderRef);
      else await addScreened(source, tenderRef, title, getTender(), products);
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={!rows || saving}
        title={screened ? 'On the Screened Tenders page. Click to take it off.' : 'Put this tender on the Screened Tenders page, where the Excel export is'}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-70 ${
          screened
            ? 'border border-[#61A644]/40 bg-[#61A644]/10 text-[#3F6F2C] hover:bg-[#61A644]/20'
            : 'bg-[#4A8033] text-white hover:bg-[#3F6F2C]'
        }`}
      >
        {saving ? <>Saving <WorkingDots /></> : screened ? '✓ Screened · Remove' : '+ Add to Screened'}
      </button>
      {error && <span role="alert" className="text-[11px] font-medium text-[#B3312C]">{error}</span>}
    </span>
  );
}
