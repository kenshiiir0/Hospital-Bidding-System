'use client';

import { useEffect, useState } from 'react';

// Item counts shown as green badges in the sidebar (e.g. Bid Match 32). Each page reports its count when its
// data loads (setNavCount); the counts are kept in this browser so the badges show from the next visit on,
// before the page itself is opened again.
const KEY = 'navCounts';
const EVENT = 'navcounts:change';

function read() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

/** Report the count for a sidebar link (href). */
export function setNavCount(href, count) {
  if (typeof window === 'undefined' || !Number.isFinite(count)) return;
  const counts = read();
  if (counts[href] === count) return;
  counts[href] = count;
  try {
    localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    // Storage blocked: the badge still updates for this visit
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: counts }));
}

/** The latest counts, { href: number }; empty until read in the browser. */
export function useNavCounts() {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    const first = setTimeout(() => setCounts(read()), 0);
    const onChange = (e) => setCounts({ ...e.detail });
    const onStorage = (e) => e.key === KEY && setCounts(read());
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      clearTimeout(first);
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return counts;
}
