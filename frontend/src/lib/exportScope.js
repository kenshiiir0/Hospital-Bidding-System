'use client';

import { useEffect, useSyncExternalStore } from 'react';

// What the sidebar's "Export Excel" button exports: the page on screen registers its filtered list here
// (useExportScope); with no page registered the button exports both portals unfiltered.
// A plain module store rather than React state: pages update it after every render, and only the short
// summary line is subscribed to (it re-renders the sidebar only when the text changes).
// A scope is { owner, from: 'philgeps' | 'ps', getShown: () => tenders, search, publishedFrom, publishedTo, summary }.

let scope = null;
let summary = '';
const listeners = new Set();

function setScope(next) {
  scope = next;
  const text = next?.summary || '';
  if (text !== summary) {
    summary = text;
    listeners.forEach((listener) => listener());
  }
}

export const getExportScope = () => scope;

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// The sidebar's description of what will be exported ('' = nothing registered)
export const useExportSummary = () => useSyncExternalStore(subscribe, () => summary, () => '');

// For a page: build() returns the page's current scope; it is refreshed after every render and dropped
// when the page closes
export function useExportScope(owner, build) {
  useEffect(() => {
    setScope({ owner, ...build() });
  });
  useEffect(
    () => () => {
      if (scope?.owner === owner) setScope(null);
    },
    [owner]
  );
}
