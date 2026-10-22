'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { agencyKey } from '@/lib/agencyKey';
import { instantDay } from '@/lib/format';

const LATEST_PER_PAGE = 5;

// Under the hospital name in View details: the hospital's own website, its procurement pages and their
// latest postings (tables hospitals / hospital_postings, checked by lib/hospitals.mjs; links only).
// "New" = appeared after the first check, in this month. Team members can add or fix the website here.
export default function HospitalLinks({ name }) {
  const key = agencyKey(name);
  const [hospital, setHospital] = useState(undefined);
  const [postings, setPostings] = useState([]);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: h }, { data: p }] = await Promise.all([
      supabase.from('hospitals').select('*').eq('agency_key', key).maybeSingle(),
      supabase
        .from('hospital_postings')
        .select('title, url, page_label, page_order, first_seen_at, baseline')
        .eq('agency_key', key)
        .order('page_order')
        .limit(300),
    ]);
    setHospital(h || null);
    setPostings(p || []);
  }, [key]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  if (!key || hospital === undefined) return null;
  if (editing) return <HospitalForm name={name} hospital={hospital} onDone={() => (setEditing(false), load())} />;

  if (!hospital) {
    return (
      <p className="text-xs text-black/46 mt-1.5">
        No website saved for this hospital.{' '}
        <button onClick={() => setEditing(true)} className="text-[#12769F] hover:underline">Add website</button>
      </p>
    );
  }

  const thisMonth = instantDay(new Date().toISOString()).slice(0, 7);
  const isNew = (p) => !p.baseline && instantDay(p.first_seen_at)?.slice(0, 7) === thisMonth;
  const byPage = (hospital.procurement_pages || []).map((page) => ({
    ...page,
    latest: postings.filter((p) => p.page_label === page.label).slice(0, LATEST_PER_PAGE),
    newCount: postings.filter((p) => p.page_label === page.label && isNew(p)).length,
  }));

  return (
    <div className="mt-2 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {hospital.website && (
          <a href={hospital.website} target="_blank" rel="noreferrer" className="text-[#12769F] hover:underline font-medium">
            🌐 {hospital.website.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗
          </a>
        )}
        <button onClick={() => setEditing(true)} className="text-black/46 hover:text-black">Edit</button>
      </div>
      {hospital.note && <p className="text-black/62">{hospital.note}</p>}
      {hospital.check_error && <p className="text-[#B3312C]">Last check: {hospital.check_error}</p>}
      {byPage.map((page) => (
        <div key={page.url} className="rounded-lg border border-[#E2E8F0] px-3 py-2">
          <a href={page.url} target="_blank" rel="noreferrer" className="font-medium text-[#12769F] hover:underline">
            {page.label} ↗
          </a>
          {page.newCount > 0 && <span className="ml-2 rounded-full bg-[#61A644]/10 px-2 py-0.5 text-[#3F6F2C]">{page.newCount} new this month</span>}
          {page.latest.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {page.latest.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-black hover:text-[#12769F] hover:underline">
                    {p.title}
                  </a>
                  {isNew(p) && <span className="ml-1.5 text-[#3F6F2C] font-medium">New</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-black/46">{hospital.checked_at ? 'No postings found on this page.' : 'Not checked yet.'}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// Website + procurement pages, one per line as "Label | https://..." (or just the address)
function HospitalForm({ name, hospital, onDone }) {
  const [website, setWebsite] = useState(hospital?.website || '');
  const [pages, setPages] = useState((hospital?.procurement_pages || []).map((p) => `${p.label} | ${p.url}`).join('\n'));
  const [note, setNote] = useState(hospital?.note || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const procurement_pages = pages
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [label, url] = l.includes('|') ? l.split('|').map((s) => s.trim()) : ['Procurement page', l];
        return { label, url };
      });
    const bad = procurement_pages.find((p) => !/^https?:\/\/\S+$/.test(p.url));
    if (bad || (website && !/^https?:\/\/\S+$/.test(website.trim()))) return setError('Addresses must start with http:// or https://');
    setSaving(true);
    const { data: auth } = await supabase.auth.getUser();
    const { error: dbError } = await supabase.from('hospitals').upsert({
      agency_key: agencyKey(name),
      name,
      website: website.trim() || null,
      procurement_pages,
      note: note.trim() || null,
      updated_by: auth.user?.email || null,
      updated_at: new Date().toISOString(),
      // Changed pages are checked again at the next keep-alive call
      checked_at: null,
    });
    setSaving(false);
    if (dbError) setError(dbError.message);
    else onDone();
  };

  const input = 'w-full rounded-lg border border-[#CBD5E1] px-2.5 py-1.5 text-xs outline-none focus:border-[#1EA0DA]';
  return (
    <form onSubmit={save} className="mt-2 space-y-2 rounded-lg border border-[#1EA0DA]/25 bg-[#1EA0DA]/6 p-3 text-xs">
      <label className="block space-y-1">
        <span className="text-black/62">Website</span>
        <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." className={input} />
      </label>
      <label className="block space-y-1">
        <span className="text-black/62">Procurement pages, one per line (Label | address)</span>
        <textarea value={pages} onChange={(e) => setPages(e.target.value)} rows={3} placeholder="Invitation to Bid | https://..." className={input} />
      </label>
      <label className="block space-y-1">
        <span className="text-black/62">Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={input} />
      </label>
      {error && <p role="alert" className="text-[#B3312C]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="rounded-full bg-[#1EA0DA] px-3 py-1 text-white hover:bg-[#12769F] disabled:opacity-60">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone} className="rounded-full px-3 py-1 text-black/62 hover:text-black">Cancel</button>
      </div>
    </form>
  );
}
