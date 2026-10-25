'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';

// The "Exclude products" filter for the PS-PhilGEPS lists: all our products (GET /api/products) and the ones
// left out, saved in this browser under the same key as the PhilGEPS page (app/page.js EXCLUDED_KEY), so
// leaving a product out on one portal leaves it out on the other too.
const EXCLUDED_KEY = 'excludedProducts';

function readStored() {
  try {
    const stored = JSON.parse(localStorage.getItem(EXCLUDED_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

export function useExcludedProducts() {
  const [products, setProducts] = useState([]);
  const [excluded, setExcluded] = useState([]);

  useEffect(() => {
    let stopped = false;
    authFetch('/api/products')
      .then((res) => res.json())
      .then((names) => {
        if (stopped) return;
        setProducts(Array.isArray(names) ? names : []);
        setExcluded(readStored());
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);

  const update = (next) => {
    setExcluded(next);
    try {
      localStorage.setItem(EXCLUDED_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked (private window): the filter still works for this visit
    }
  };

  return { products, excluded, update };
}
