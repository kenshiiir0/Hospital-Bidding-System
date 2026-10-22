import { createClient } from '@supabase/supabase-js';
import { parse } from 'node-html-parser';

// Checks hospitals' own procurement pages (table hospitals, procurement_pages) for postings: links whose
// text names an Invitation to Bid, Request for Quotation, bid bulletin, bidding documents, etc. New ones
// go to hospital_postings with today's date as first_seen_at (the pages show no dates). Links only:
// nothing is downloaded. Each hospital is checked at most every CHECK_EVERY_MS.
// Plain .mjs (no Next imports) so it can also be run directly with node.

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const POSTING = /request for quotation|\brfq\b|invitation to bid|\bib no\b|\bitb\b|bid (?:bulletin|supplement)|supplemental|bidding documents|schedule of requirements|technical specifications?|notice of award|price quotation|purchase request/i;

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const clean = (s) => (s || '').replace(/&#8211;|&ndash;/g, '–').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function readPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (res.status === 403) throw new Error('The site blocks automatic checks (403); open it in a browser.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (/under maintenance/i.test(html.slice(0, 5000))) throw new Error('The site says it is under maintenance.');
  const root = parse(html);
  const seen = new Set();
  return root
    .querySelectorAll('a[href]')
    .map((a) => ({ title: clean(a.text), url: new URL(a.getAttribute('href'), res.url).href }))
    .filter(({ title, url }) => title.length > 3 && POSTING.test(title) && /^https?:/.test(url) && !seen.has(url) && seen.add(url));
}

// Returns { checked, found }
export async function checkHospitals({ maxMs = 60000, force = false } = {}) {
  const started = Date.now();
  const supabase = admin();
  const { data: hospitals } = await supabase.from('hospitals').select('agency_key, procurement_pages, checked_at');
  const due = (hospitals || []).filter(
    (h) => h.procurement_pages?.length && (force || !h.checked_at || Date.now() - new Date(h.checked_at).getTime() > CHECK_EVERY_MS)
  );
  let checked = 0;
  let found = 0;
  for (const h of due) {
    if (Date.now() - started > maxMs) break;
    const errors = [];
    const now = new Date().toISOString();
    for (const page of h.procurement_pages) {
      try {
        const postings = (await readPage(page.url)).map((p, i) => ({ ...p, page_order: i, agency_key: h.agency_key, page_url: page.url, page_label: page.label }));
        if (!postings.length) continue;
        // The first check of a page only records what is already there (baseline: never "new");
        // later checks add new links with first_seen_at = now (column default)
        // Links already recorded for this page (read in pages of 1000, the API's row limit; looking them
        // up by URL list instead makes a request address too long and fails silently)
        const known = new Set();
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase.from('hospital_postings').select('url').eq('page_url', page.url).range(from, from + 999);
          if (error) throw new Error(`Reading recorded postings: ${error.message}`);
          data.forEach((k) => known.add(k.url));
          if (data.length < 1000) break;
        }
        const firstCheck = known.size === 0;
        const fresh = postings.filter((p) => !known.has(p.url)).map((p) => ({ ...p, baseline: firstCheck }));
        const seenAgain = postings.filter((p) => known.has(p.url)).map((p) => ({ ...p, last_seen_at: now }));
        const write = async (query) => {
          const { data, error } = await query;
          if (error) throw new Error(`Saving postings: ${error.message}`);
          return data || [];
        };
        // A link already recorded from another page of the same site is left as it is (not counted)
        let added = 0;
        for (let i = 0; i < fresh.length; i += 500) {
          const rows = await write(
            supabase.from('hospital_postings').upsert(fresh.slice(i, i + 500), { onConflict: 'url', ignoreDuplicates: true }).select('url')
          );
          added += rows.length;
        }
        // Known ones: new position and last_seen_at; first_seen_at and baseline stay as they were
        for (let i = 0; i < seenAgain.length; i += 500) await write(supabase.from('hospital_postings').upsert(seenAgain.slice(i, i + 500)));
        if (!firstCheck) found += added;
      } catch (e) {
        errors.push(`${page.label || page.url}: ${e.message}`);
      }
    }
    await supabase.from('hospitals').update({ checked_at: now, check_error: errors.join(' · ') || null }).eq('agency_key', h.agency_key);
    checked++;
  }
  return { checked, found };
}
