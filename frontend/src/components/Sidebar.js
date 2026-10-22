'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { displayName } from '@/lib/username';

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

// Left navigation on wide screens, a top bar on phones
export default function Sidebar({ user }) {
  const pathname = usePathname();

  return (
    <aside className="md:w-60 md:shrink-0 md:h-screen md:sticky md:top-0 bg-white border-b md:border-b-0 md:border-r border-[#E2E8F0]">
      <div className="flex md:flex-col md:h-full items-center md:items-stretch gap-4 md:gap-8 px-4 md:px-5 py-3 md:py-8">
        <div className="shrink-0">
          <div className="text-sm font-bold tracking-tight text-black">Opportunity Radar</div>
          <div className="hidden md:block text-xs text-black/62 mt-0.5">PhilGEPS · Drugs &amp; Medicines</div>
        </div>
        <nav className="flex md:flex-col gap-1 md:gap-5 overflow-x-auto">
          {GROUPS.map((group) => (
            <div key={group.label} className="flex md:flex-col gap-1 items-center md:items-stretch">
              <div className="hidden md:block px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-black/46">
                {group.label}
              </div>
              {group.links.map(({ href, label, icon }) => {
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition ${
                      active
                        ? 'bg-[#1EA0DA]/10 text-[#12769F]'
                        : 'text-black/62 hover:text-black hover:bg-[#1EA0DA]/6'
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
        <div className="ml-auto md:ml-0 md:mt-auto flex md:flex-col items-center md:items-stretch gap-2 md:pt-4 md:border-t md:border-[#E2E8F0]">
          <div className="hidden md:block text-xs text-black/62 truncate" title={user?.email}>{displayName(user?.email)}</div>
          <button
            onClick={signOut}
            className="rounded-lg px-3 py-2 text-sm font-medium text-black/62 hover:text-black hover:bg-[#1EA0DA]/6 transition text-left"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
