'use client';

import { useEffect, useState } from 'react';

// A Sync someone pressed in this browser, per portal ('philgeps' | 'ps'), kept until its result is seen:
// { startedAt, status: 'running' | 'failed', error?, stage?, percent? }.
// The portal pages record it (watchSync / failSync / clearSync); SyncAlertHost (always on screen) keeps checking a
// running one while the person is on another page and shows a failure wherever they are, until it is closed with ×.
// A success or cancel clears it. Kept in this browser (localStorage) so leaving the page or reloading keeps it.
const KEY = 'sync-alerts';
const EVENT = 'sync-alerts-change';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked (private window): the page's own ring still shows the result while it is open
  }
  window.dispatchEvent(new Event(EVENT));
}

export const readSyncAlert = (portal) => readAll()[portal] || null;

function update(portal, next) {
  const all = readAll();
  if (next) all[portal] = next;
  else delete all[portal];
  writeAll(all);
}

/** A pressed Sync is running: remember it (a newer one replaces an older, unseen result). */
export function watchSync(portal, startedAt) {
  const cur = readSyncAlert(portal);
  if (!startedAt || (cur?.startedAt === startedAt && cur.status === 'running')) return;
  if (cur?.status === 'failed' && cur.startedAt === startedAt) return;
  update(portal, { startedAt: String(startedAt), status: 'running' });
}

/** The Sync failed: keep the failure until it is closed. startedAt omitted = the request itself failed. */
export function failSync(portal, { startedAt, error, stage, percent } = {}) {
  const cur = readSyncAlert(portal);
  const key = String(startedAt ?? `request-${Date.now()}`);
  if (cur?.status === 'failed' && cur.startedAt === key) return;
  update(portal, { startedAt: key, status: 'failed', error: error || 'Unknown error', stage: stage || '', percent: percent || 0 });
}

/** Seen, closed, or finished without a failure. startedAt given: only when it is still that Sync. */
export function clearSync(portal, startedAt) {
  const cur = readSyncAlert(portal);
  if (!cur || (startedAt != null && cur.startedAt !== String(startedAt))) return;
  update(portal, null);
}

/** A failure for this Sync that hasn't been closed yet. */
export const unseenFailure = (portal, startedAt) => {
  const cur = readSyncAlert(portal);
  return Boolean(cur?.status === 'failed' && startedAt != null && cur.startedAt === String(startedAt));
};

/** The portal's remembered Sync, kept up to date across components and tabs. */
export function useSyncAlert(portal) {
  const [alert, setAlert] = useState(null);
  useEffect(() => {
    const read = () => setAlert(readSyncAlert(portal));
    read();
    window.addEventListener(EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, [portal]);
  return alert;
}

// A Sync asked for but never seen starting (the request was lost) is forgotten after this long
const PENDING_GIVE_UP_MS = 10 * 60 * 1000;
// Start times: PhilGEPS a number (kept as a string here), PS-PhilGEPS an ISO date
const ms = (t) => (typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) : Date.parse(t));

/** Just pressed Sync: follow the next Sync of this portal that starts (its start time isn't known yet). */
export const pressedSync = (portal) => update(portal, { startedAt: `pending-${Date.now()}`, status: 'running' });

// A followed Sync whose end was never seen (e.g. the browser was closed) is forgotten after this long
const MAX_FOLLOW_MS = 3 * 60 * 60 * 1000;

/**
 * The portal's latest Sync or update as just read: { startedAt, pressed (the Sync button, not the hourly update),
 * running, status, error, stage, percent }, or null. A running pressed Sync is followed; when the followed one ends,
 * a failure is kept until closed and a success or cancel forgets it. One replaced by a newer run is forgotten (its
 * result is gone).
 */
export function followSync(portal, job) {
  const cur = readSyncAlert(portal);
  const startedHere = job?.running && job.pressed;
  if (cur?.status !== 'running') {
    if (startedHere) watchSync(portal, job.startedAt);
    return;
  }
  const pending = cur.startedAt.startsWith('pending-');
  const since = pending ? Number(cur.startedAt.slice(8)) : ms(cur.startedAt);
  const started = job?.startedAt != null ? ms(job.startedAt) : NaN;
  // A Sync started on another computer may have a clock a little off
  const ours = job?.pressed && (pending ? started >= since - 60000 : started === since);
  if (ours) {
    if (job.running) watchSync(portal, job.startedAt);
    else if (job.status === 'failed') failSync(portal, job);
    else clearSync(portal, cur.startedAt);
    return;
  }
  if (startedHere && started > since) return watchSync(portal, job.startedAt);
  const replaced = !pending && started > since;
  const gaveUp = Date.now() - since > (pending ? PENDING_GIVE_UP_MS : MAX_FOLLOW_MS);
  if (replaced || gaveUp) clearSync(portal, cur.startedAt);
}

/** GET /api/scrape's job in the shape followSync reads. */
export const philgepsRun = (job) =>
  job?.startedAt ? { startedAt: job.startedAt, pressed: job.kind === 'sync', running: job.status === 'running', status: job.status, error: job.error, stage: job.stage, percent: job.percent } : null;

/** The ps_sync_status row in the shape followSync reads. */
export const psRun = (row) =>
  row?.started_at ? { startedAt: row.started_at, pressed: row.started_by !== 'schedule', running: row.status === 'running', status: row.status, error: row.error, stage: row.stage, percent: row.percent } : null;
