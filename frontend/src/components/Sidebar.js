'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { displayName } from '@/lib/username';
import { authFetch } from '@/lib/authFetch';
import { setNavCount, useNavCounts } from '@/lib/navCounts';
import { useScreened } from '@/lib/screened';

// Two sources, each with its own pages and its own Sync: the old PhilGEPS (notices.philgeps.gov.ph)
// and the new PS-PhilGEPS (philgeps.gov.ph)
const GROUPS = [
  {
    label: 'PhilGEPS Portal',
    links: [
      { href: '/', label: 'Dashboard', icon: '▦' },
      { href: '/history', label: 'History', icon: '⟲' },
    ],
  },
  {
    label: 'PS-PhilGEPS',
    links: [
      { href: '/ps-philgeps', label: 'Bid Match', icon: '◎' },
      { href: '/ps-philgeps/opportunities', label: 'My Opportunities', icon: '☰' },
      { href: '/ps-philgeps/awards', label: 'Award Notices', icon: '★' },
      { href: '/history/ps-philgeps', label: 'History', icon: '⟲' },
    ],
  },
  // Tenders picked with "Add to Screened" in View details on either site; the Excel export is there
  {
    label: 'Screening & Matching',
    links: [{ href: '/screened', label: 'Screened Tenders', icon: '✓' }],
  },
  // The one product list both sites' tenders are screened against
  {
    label: 'Catalog Management',
    links: [{ href: '/products', label: 'Product List', icon: '✚' }],
  },
];

// Signing out also drops the tender list cached in this browser (see page.js)
async function signOut() {
  try {
    localStorage.removeItem('bidsCache');
  } catch {}
  await supabase.auth.signOut();
}

// The navigation: groups of links (with item counts), the signed-in user and Sign out.
// onNavigate: called when a link is followed (closes the phone menu).
function SidebarContent({ pathname, user, counts, onNavigate }) {
  return (
    <div className="flex h-full flex-col justify-between gap-6 p-4">
      <div className="min-h-0">
        <div className="px-2 pt-2">
          <div className="text-base font-bold tracking-tight text-black">Opportunity Radar</div>
          <div className="mt-0.5 text-xs text-black/46">PhilGEPS · Drugs &amp; Medicines</div>
        </div>
        <nav className="mt-2">
          {GROUPS.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="mb-1 mt-4 px-3 text-[10px] font-bold uppercase tracking-wider text-black/46">{group.label}</div>
              {group.links.map(({ href, label, icon }) => {
                const active = pathname === href;
                const count = counts[href];
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center justify-between gap-2 border-l-4 px-3 py-2 text-xs transition-all ${
                      active
                        ? 'rounded-r-lg border-[#1EA0DA] bg-[#1EA0DA]/10 font-semibold text-[#12769F]'
                        : 'rounded-lg border-transparent font-medium text-black/62 hover:bg-[#1EA0DA]/5 hover:text-[#12769F]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="w-4 shrink-0 text-center">{icon}</span>
                      <span className="truncate">{label}</span>
                    </span>
                    {count != null && (
                      <span className="shrink-0 rounded-full bg-[#61A644]/10 px-2 py-0.5 text-[10px] font-bold tabular-nums text-[#3F6F2C]" aria-label={`${count} items`}>
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
      <div className="flex flex-col gap-2 border-t border-[#E2E8F0] pt-4">
        <div className="truncate px-3 text-xs text-black/62" title={user?.email}>{displayName(user?.email)}</div>
        <button
          onClick={signOut}
          className="rounded-lg px-3 py-2 text-left text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/5 hover:text-[#12769F]"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

// Left sidebar on wide screens (md+). On phones and small tablets: a slim top bar (initial + ☰, page name)
// that stays at the top, and the same navigation sliding in from the left, as tall as the visible screen.
export default function Sidebar({ user }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = GROUPS.flatMap((g) => g.links.map((l) => ({ ...l, group: g.label }))).find((l) => l.href === pathname);
  const initial = (displayName(user?.email) || '?').trim().charAt(0).toUpperCase();
  const counts = useNavCounts();
  const screened = useScreened();

  // Counts that are cheap to read from anywhere; the PhilGEPS and PS-PhilGEPS pages report exact ones when open
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const { count } = await supabase.from('philgeps_opportunities').select('id', { count: 'exact', head: true }).not('matched_molecules', 'eq', '{}');
      if (!stopped && count != null) setNavCount('/', count);
      try {
        const res = await authFetch('/api/products');
        if (res.ok && !stopped) setNavCount('/products', (await res.json()).length);
      } catch {
        // Offline or signed out: keep the last count
      }
    };
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (screened.rows) setNavCount('/screened', screened.rows.length);
  }, [screened.rows]);

  // Escape closes the phone menu; the page behind doesn't scroll while it is open
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => e.key === 'Escape' && setMenuOpen(false);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <>
      <aside className="hidden md:block md:w-64 md:shrink-0 md:h-screen md:sticky md:top-0 bg-white border-r border-[#E2E8F0] overflow-y-auto">
        <SidebarContent pathname={pathname} user={user} counts={counts} />
      </aside>

      {/* Phone top bar */}
      <div className="md:hidden sticky top-0 z-40 flex items-center gap-3 border-b border-[#E2E8F0] bg-white px-4 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1EA0DA]/10 text-sm font-semibold text-[#12769F]" aria-hidden>
          {initial}
        </span>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#CBD5E1] text-black transition hover:border-[#1EA0DA] hover:bg-[#1EA0DA]/6"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
            <path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />
          </svg>
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-black">{current?.label || 'Opportunity Radar'}</div>
          {current && <div className="truncate text-[11px] text-black/46">{current.group}</div>}
        </div>
      </div>

      {/* Phone menu */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-black/30" aria-label="Close menu" tabIndex={-1} onClick={() => setMenuOpen(false)} />
          <div className="relative h-dvh w-72 max-w-[85vw] overflow-y-auto border-r border-[#E2E8F0] bg-white shadow-2xl">
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 rounded-full p-2 text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F]"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
            <SidebarContent pathname={pathname} user={user} counts={counts} onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
