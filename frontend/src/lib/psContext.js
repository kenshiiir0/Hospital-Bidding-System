'use client';

import { createContext, useContext } from 'react';

// PS-PhilGEPS status + last Sync data + the search box text, provided by app/ps-philgeps/layout.js to
// its pages (Bid Match, My Opportunities, Award Notices)
export const PsContext = createContext(null);
export const usePsPhilgeps = () => useContext(PsContext);

// Search: every word typed must appear somewhere in the row (all PhilGEPS columns, including the long
// title the list doesn't show) or in extra text such as our product names. Case-insensitive.
export function matchesSearch(search, row, extra = '') {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${row.cells.join(' ')} ${extra}`.toLowerCase();
  return words.every((w) => text.includes(w));
}
