'use client';

import { useEffect, useRef } from 'react';

// The system's pop-up window, built like the View details drawer (PsDetailsPanel) so both feel the same:
// - a blurred backdrop; click it, ✕ or Escape to close (not while `busy`, e.g. saving),
// - header: an optional icon badge, the title and a line under it, ✕,
// - a scrolling body and a footer for the buttons.
// Centred on wider screens, a sheet from the bottom on phones. The page behind is locked while it is open and
// Tab stays inside it.
export default function Modal({ title, subtitle, icon, busy = false, onClose, footer, children, width = 'sm:max-w-lg' }) {
  const card = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = busy ? () => {} : onClose;
  }, [busy, onClose]);

  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const returnTo = document.activeElement;
    // Start on the first field, else on ✕
    (card.current?.querySelector('input, textarea, select') || card.current?.querySelector('button'))?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') return closeRef.current();
      if (e.key !== 'Tab' || !card.current) return;
      const focusable = [...card.current.querySelectorAll('button, input, textarea, select, a[href]')].filter((el) => !el.disabled);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = before;
      returnTo?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <button className="modal-backdrop absolute inset-0 bg-black/30 backdrop-blur-sm" aria-label="Close" tabIndex={-1} onClick={() => closeRef.current()} />
      <div
        ref={card}
        className={`modal-card relative flex max-h-[92dvh] w-full ${width} flex-col overflow-hidden rounded-t-[14px] border border-[#E2E8F0] bg-white shadow-2xl sm:rounded-[14px]`}
      >
        <header className="flex items-start gap-3 border-b border-[#E2E8F0] px-5 py-4">
          {icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#61A644]/10 text-[#3F6F2C]">{icon}</span>}
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-snug text-black">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs leading-snug text-black/62">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={() => closeRef.current()}
            disabled={busy}
            aria-label="Close"
            className="shrink-0 rounded-full p-2 text-black/62 transition hover:bg-[#1EA0DA]/8 hover:text-[#12769F] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1EA0DA]/30"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">{children}</div>

        {footer && <footer className="flex items-center justify-end gap-2 border-t border-[#E2E8F0] bg-white p-4">{footer}</footer>}
      </div>
    </div>
  );
}
