'use client';

import { useEffect, useRef, useState } from 'react';

// The ••• menu of a row. Drawn fixed (not inside the table box, which clips), opens upward near the bottom of the screen.
export default function RowMenu({ label, items }) {
  const [pos, setPos] = useState(null);
  const button = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (menu.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setPos(null);
      if (e.type === 'keydown') button.current?.focus();
    };
    const closeNow = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', closeNow, true);
    window.addEventListener('resize', closeNow);
    menu.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', closeNow, true);
      window.removeEventListener('resize', closeNow);
    };
  }, [pos]);
  const toggle = () => {
    if (pos) return setPos(null);
    const r = button.current.getBoundingClientRect();
    const up = r.bottom + 150 > window.innerHeight;
    setPos({ right: window.innerWidth - r.right, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30 ${pos ? 'bg-[#1EA0DA]/8 text-[#12769F]' : ''}`}
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {pos && (
        <div ref={menu} role="menu" aria-label={`Actions for ${label}`} style={pos} className="fixed z-40 w-44 overflow-hidden rounded-xl border border-[#E2E8F0] bg-white py-1 text-left shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setPos(null);
                item.onClick();
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-black/85 transition hover:bg-[#1EA0DA]/6 hover:text-[#12769F] focus:bg-[#1EA0DA]/6 focus:outline-none"
            >
              <span className="text-black/46">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function EyeIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
