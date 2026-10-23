'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { displayName } from '@/lib/username';
import { getExportScope, useExportSummary } from '@/lib/exportScope';
import { exportBothPortals } from '@/lib/unifiedExport';
import WorkingDots from '@/components/WorkingDots';

// Two sources, each with its own pages and its own Sync: the old PhilGEPS (notices.philgeps.gov.ph)
// and the new PS-PhilGEPS (philgeps.gov.ph)
const GROUPS = [
  {
    label: 'PhilGEPS',
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
];

// Signing out also drops the tender list cached in this browser (see page.js)
async function signOut() {
  try {
    localStorage.removeItem('bidsCache');
  } catch {}
  await supabase.auth.signOut();
}

// One Excel for both portals (lib/unifiedExport.js), oldest at the top. Uses the filters and search of the
// page on screen when it registered them (lib/exportScope.js), else exports everything.
function ExportButton() {
  const summary = useExportSummary();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setExporting(true);
    setError('');
    try {
      const scope = getExportScope();
      await exportBothPortals(scope?.getShown ? { ...scope, shown: scope.getShown() } : {});
    } catch (err) {
      setError(`Export failed: ${err.message}`);
    }
    setExporting(false);
  };

  return (
    <div className="flex flex-col items-stretch gap-1.5">
      <button
        onClick={run}
        disabled={exporting}
        title="One Excel with PhilGEPS and PS-PhilGEPS tenders, oldest at the top"
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#4A8033] px-3 py-2 text-xs font-semibold text-white hover:bg-[#3F6F2C] disabled:bg-[#4A8033]/50 disabled:cursor-wait transition whitespace-nowrap"
      >
        {exporting ? <>Exporting <WorkingDots /></> : '⬇ Export Excel'}
      </button>
      <p className="text-[11px] leading-snug text-black/62">
        PhilGEPS + PS-PhilGEPS, oldest first · {summary || 'everything (no filters on this page)'}
      </p>
      {error && <p role="alert" className="text-[11px] font-medium text-[#B3312C]">{error}</p>}
    </div>
  );
}

// The navigation: groups of links, the shared Export, the signed-in user and Sign out.
// onNavigate: called when a link is followed (closes the phone menu).
function SidebarContent({ pathname, user, onNavigate }) {
  return (
    <div className="flex h-full flex-col gap-8 px-5 py-8">
      <div className="shrink-0">
        <div className="text-sm font-bold tracking-tight text-black">Opportunity Radar</div>
        <div className="text-xs text-black/62 mt-0.5">PhilGEPS · Drugs &amp; Medicines</div>
      </div>
      <nav className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-black/46">{group.label}</div>
            {group.links.map(({ href, label, icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                    active ? 'bg-[#1EA0DA]/10 text-[#12769F]' : 'text-black/62 hover:text-black hover:bg-[#1EA0DA]/6'
                  }`}
                >
                  <span aria-hidden className="w-4 text-center">{icon}</span>
                  {label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-[#E2E8F0] pt-4">
        <ExportButton />
        <div className="truncate pt-2 text-xs text-black/62" title={user?.email}>{displayName(user?.email)}</div>
        <button
          onClick={signOut}
          className="rounded-lg px-3 py-2 text-left text-sm font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 hover:text-black"
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
      <aside className="hidden md:block md:w-60 md:shrink-0 md:h-screen md:sticky md:top-0 bg-white border-r border-[#E2E8F0] overflow-y-auto">
        <SidebarContent pathname={pathname} user={user} />
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
            <SidebarContent pathname={pathname} user={user} onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
