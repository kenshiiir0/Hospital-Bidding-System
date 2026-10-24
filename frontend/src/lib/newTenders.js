'use client';

import { useEffect, useState } from 'react';
import { setNavCount } from '@/lib/navCounts';

// New, unread tenders, kept per browser (each teammate has their own "unread"):
// - PhilGEPS tenders are new when saved (created_at) after this browser's start point (its first visit minus
//   24 hours) and not yet read;
// - PS-PhilGEPS lists have no fetch time, so a row is new when a Sync brings one this browser hadn't seen
//   (the first time a list is seen, everything in it is the starting point, not new);
// - opening a tender's View details, or "Mark all as read", reads it.
// The unread counts go to the sidebar badges as navCounts "new:<href>".
const KEY = 'tenderNews';
const EVENT = 'tendernews:change';
const READ_KEEP_DAYS = 90;

const empty = () => ({ cutoff: {}, known: {}, firstSeen: {}, read: {} });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && typeof s === 'object' ? { ...empty(), ...s } : empty();
  } catch {
    return empty();
  }
}

function save(state) {
  // Forget reads older than READ_KEEP_DAYS so the store doesn't grow forever
  const oldest = Date.now() - READ_KEEP_DAYS * 86400000;
  state.read = Object.fromEntries(Object.entries(state.read).filter(([, at]) => at >= oldest));
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: labels still work for this visit
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

// "2026-10-24T01:00:00" (UTC without a zone, as philgeps_opportunities stores it) -> milliseconds
const instant = (value) => (value ? new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`).getTime() : NaN);

/** The PhilGEPS start point (first visit minus 24 hours), set on first use in this browser. */
export function philgepsCutoff() {
  const state = load();
  if (!state.cutoff.philgeps) {
    state.cutoff.philgeps = Date.now() - 86400000;
    save(state);
  }
  return state.cutoff.philgeps;
}

/** Record the rows of a PS-PhilGEPS list (keys); returns nothing. Rows not seen before become new. */
export function registerList(list, keys) {
  const state = load();
  const known = new Set(state.known[list] || []);
  if (!state.known[list]) {
    state.known[list] = keys;
    save(state);
    return;
  }
  const now = Date.now();
  const added = keys.filter((k) => !known.has(k));
  if (!added.length) return;
  for (const k of added) state.firstSeen[k] = now;
  state.known[list] = [...known, ...added];
  save(state);
}

/** Mark tenders as read (keys like "philgeps:12", "ps:109036"). */
export function markRead(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return;
  const state = load();
  const now = Date.now();
  let changed = false;
  for (const k of list) {
    if (!state.read[k]) {
      state.read[k] = now;
      changed = true;
    }
  }
  if (changed) save(state);
}

/** Report a link's unread count to the sidebar. */
export const reportUnread = (href, count) => setNavCount(`new:${href}`, count);

/**
 * { isNewPhilgeps(bid), isNewPs(key) } for the labels; re-renders when anything is read or registered.
 * Everything is "not new" until the state has been read in the browser.
 */
export function useTenderNews() {
  const [state, setState] = useState(null);
  useEffect(() => {
    const refresh = () => setState(load());
    const first = setTimeout(() => {
      philgepsCutoff();
      refresh();
    }, 0);
    const onStorage = (e) => e.key === KEY && refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      clearTimeout(first);
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return {
    ready: Boolean(state),
    isNewPhilgeps: (bid) =>
      Boolean(state?.cutoff.philgeps) && !state.read[`philgeps:${bid.id}`] && instant(bid.created_at) >= state.cutoff.philgeps,
    isNewPs: (key) => Boolean(state?.firstSeen[key]) && !state.read[key],
  };
}

/** Unread PhilGEPS tenders among rows { id, created_at } (for the sidebar, without the page open). */
export function unreadPhilgeps(rows) {
  const state = load();
  const cutoff = state.cutoff.philgeps;
  return cutoff ? rows.filter((r) => !state.read[`philgeps:${r.id}`] && instant(r.created_at) >= cutoff).length : 0;
}
