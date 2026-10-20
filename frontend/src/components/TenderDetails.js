'use client';

import { useEffect } from 'react';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Scraped values end up in hrefs: only link to PhilGEPS over https and to plain e-mail addresses
const PHILGEPS_LINK = /^https:\/\/notices\.philgeps\.gov\.ph\//;
const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i;

// Wrap mentions of our matched products in <mark> so they stand out in the item list
function highlight(text, names) {
  if (!names.length) return text;
  const re = new RegExp(`(${names.map((n) => escapeRegex(n).replace(/\s+/g, '\\s+')).join('|')})`, 'gi');
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-emerald-500/20 text-emerald-200 rounded px-0.5">{part}</mark>
    ) : (
      part
    )
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-200 mt-0.5 break-words">{value || '—'}</dd>
    </div>
  );
}

// Side panel with everything the scraper stored for one tender
export default function TenderDetails({ bid, onClose }) {
  // Close on Escape
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = bid.details || {};
  const matched = bid.matched_molecules || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={bid.title}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <aside className="relative w-full max-w-2xl h-full overflow-y-auto bg-[#0b0f19] border-l border-slate-800 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0b0f19]/95 backdrop-blur border-b border-slate-800 px-6 py-5 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            {d.notice_type && (
              <span className="inline-block text-[11px] font-semibold uppercase tracking-wider text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded-md px-2 py-0.5 mb-2">
                {d.notice_type}
              </span>
            )}
            <h2 className="text-lg font-bold text-white leading-snug">{bid.title}</h2>
            <p className="text-sm text-slate-400 mt-1">{bid.procuring_entity}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 h-9 w-9 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-6 space-y-8">
          {!bid.details && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm rounded-xl px-4 py-3">
              Full notice details have not been captured for this tender yet. Click Refresh Table to read them from PhilGEPS.
            </div>
          )}

          {/* Key facts */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <Fact label="Reference No." value={bid.ref_no} />
            <Fact label="Solicitation No." value={d.solicitation_no} />
            <Fact
              label="Approved Budget (ABC)"
              value={bid.abc_amount && `₱${Number(bid.abc_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`}
            />
            <Fact label="Procurement Mode" value={d.procurement_mode} />
            <Fact label="Published" value={bid.publish_date} />
            <Fact label="Closing" value={bid.closing_date && bid.closing_date.slice(0, 16).replace('T', ' ')} />
            <Fact label="Delivery Period" value={d.delivery_period} />
            <Fact label="Area of Delivery" value={d.area_of_delivery} />
            <Fact label="PhilGEPS Status" value={d.status} />
            <Fact label="Last Updated" value={d.last_updated} />
          </dl>

          {/* Our products */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Our Products Requested</h3>
            <div className="flex flex-wrap gap-1.5">
              {matched.map((name) => (
                <span key={name} className="px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                  {name}
                </span>
              ))}
            </div>
          </section>

          {/* Item list */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Items / Description</h3>
            {bid.items_text ? (
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap max-h-[28rem] overflow-y-auto">
                {highlight(bid.items_text, matched)}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No item list on the PhilGEPS notice.</p>
            )}
          </section>

          {/* Contact */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Contact Person</h3>
            {d.contact_name ? (
              <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-sm space-y-0.5">
                <div className="font-semibold text-slate-100">{d.contact_name}</div>
                {(d.contact_info || []).map((line, i) =>
                  EMAIL.test(line) ? (
                    <a key={i} href={`mailto:${line}`} className="block text-blue-400 hover:text-blue-300 break-all">
                      {line}
                    </a>
                  ) : (
                    <div key={i} className="text-slate-400">{line}</div>
                  )
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">—</p>
            )}
          </section>

          {PHILGEPS_LINK.test(bid.detail_link || '') && (
            <a
              href={bid.detail_link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 transition"
            >
              View original notice and documents on PhilGEPS <span className="text-[10px]">↗</span>
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}
