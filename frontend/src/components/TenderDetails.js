'use client';

import { useEffect } from 'react';
import { formatDate, formatDateTime, formatInstant, formatPeso } from '@/lib/format';
import { supabase } from '@/lib/supabase';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Scraped values end up in hrefs: only link to PhilGEPS over https and to plain e-mail addresses
const PHILGEPS_LINK = /^https:\/\/notices\.philgeps\.gov\.ph\//;
const EMAIL = /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[a-z]{2,}$/i;
// Public list of a tender's bid bulletins/addenda (opening the files themselves needs a PhilGEPS log-in)
const supplementsUrl = (ref) =>
  `https://notices.philgeps.gov.ph/GEPSNONPILOT/Tender/SplashBidSupplementsListUI.aspx?menuIndex=3&directFrom=BidAbstract&refID=${ref}`;

// Why a tender has no downloaded documents (documents_status set by the scraper's logged-in pass)
const DOCUMENT_STATUS_NOTE = {
  // From before Sync could order (2026-10-21); the next Sync orders and downloads these
  'needs-order': 'Not ordered on PhilGEPS yet. Click Sync to order (free) and download the documents.',
  closed: 'PhilGEPS says this bid notice is closed: bidding has ended, so its documents can no longer be ordered.',
  'pick-up': 'The procuring entity releases these bid documents for pick-up only, so there is no file on PhilGEPS to download.',
  'needs-payment': 'PhilGEPS asks for a payment for these documents. The system never pays; order them on PhilGEPS by hand, then click Sync to download them.',
  'no-order-link': 'PhilGEPS shows no Order link for this tender, so there are no documents to order yet. Sync checks again next time.',
  'order-flow-changed': 'PhilGEPS showed an unexpected page while ordering, so the system stopped for this tender. Sync tries again next time.',
  'none-found': 'The order exists but no document file came through yet. Sync tries again next time.',
};

// Status label, colour and reason for the Remarks box. Uses the Sync's own remark when there is one,
// otherwise a general explanation (older results, or tenders not checked yet).
const REMARK_LABELS = {
  downloaded: ['Documents downloaded', 'green'],
  'pick-up': ['Pick-up only', 'grey'],
  closed: ['Closed on PhilGEPS', 'grey'],
  'needs-payment': ['Needs payment', 'red'],
  'no-order-link': ['No Order link', 'red'],
  'order-flow-changed': ['Stopped while ordering', 'red'],
  'none-found': ['No file yet', 'red'],
  'needs-order': ['Not ordered yet', 'blue'],
};
const REMARK_STYLE = {
  green: 'bg-[#61A644]/8 border-[#61A644]/30 text-[#2F5321]',
  grey: 'bg-[#94A3B8]/10 border-[#94A3B8]/40 text-black/80',
  red: 'bg-[#B3312C]/6 border-[#B3312C]/25 text-[#8A2622]',
  blue: 'bg-[#1EA0DA]/8 border-[#1EA0DA]/25 text-[#0E5C7C]',
};

function documentsRemark(bid) {
  const d = bid.details || {};
  const docs = d.documents || [];
  const status = docs.length ? 'downloaded' : d.documents_status;
  if (!d.documents_checked_at || !status) {
    return {
      label: 'Not checked yet',
      tone: 'blue',
      text: 'The system has not looked for this tender\'s documents yet. The next Sync (or the first automatic update of the day) orders them on PhilGEPS for free and downloads them.',
    };
  }
  const [label, tone] = REMARK_LABELS[status] || [status, 'red'];
  const orders = [...new Set(docs.map((doc) => doc.order_no).filter(Boolean))];
  const fallback = status === 'downloaded'
    ? `${docs.length} file${docs.length === 1 ? '' : 's'} downloaded from PhilGEPS${orders.length ? ` (order ${orders.join(', ')})` : ''}.`
    : DOCUMENT_STATUS_NOTE[status] || 'No documents yet.';
  return { label, tone, text: d.documents_remark || fallback };
}

// Documents uploaded to the private Storage bucket "philgeps-documents" open by a short-lived signed link
// (works on any computer and the deployed dashboard); older ones only from this computer (/api/documents).
// The tab is opened first so the browser doesn't block it as a pop-up.
async function openDocument(ref, doc) {
  if (!doc.path) {
    window.open(`/api/documents?ref=${ref}&name=${encodeURIComponent(doc.name)}`, '_blank', 'noopener');
    return;
  }
  const tab = window.open('', '_blank');
  const { data, error } = await supabase.storage.from('philgeps-documents').createSignedUrl(doc.path, 3600);
  if (error || !data?.signedUrl) {
    tab?.close();
    alert(`Could not open ${doc.name}: ${error?.message || 'no link'}`);
    return;
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.location.href = data.signedUrl;
}

const formatSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Wrap mentions of our matched products in <mark> so they stand out in the item list
function highlight(text, names) {
  if (!names.length) return text;
  const re = new RegExp(`(${names.map((n) => escapeRegex(n).replace(/\s+/g, '\\s+')).join('|')})`, 'gi');
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-[#61A644]/20 text-[#3F6F2C] rounded px-0.5">{part}</mark>
    ) : (
      part
    )
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-black/46">{label}</dt>
      <dd className="text-sm text-black mt-0.5 break-words">{value || '—'}</dd>
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
  // Lines of the item list that request our products (set by the scraper; missing until the next scrape)
  const items = d.matched_items;
  const supplements = d.supplements || [];
  const documents = d.documents || [];
  const remark = documentsRemark(bid);
  const validRef = /^\d+$/.test(bid.ref_no || '');

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={bid.title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      <aside className="relative w-full max-w-2xl h-full overflow-y-auto bg-white border-l border-[#E2E8F0] shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-[#E2E8F0] px-6 py-5 flex items-start gap-4">
          <div className="flex-1 min-w-0">
            {d.notice_type && (
              <span className="inline-block text-[11px] font-semibold uppercase tracking-wider text-[#12769F] bg-[#1EA0DA]/8 border border-[#1EA0DA]/25 rounded-full px-2 py-0.5 mb-2">
                {d.notice_type}
              </span>
            )}
            <h2 className="text-lg font-bold text-black leading-snug">{bid.title}</h2>
            <p className="text-sm text-black/62 mt-1">{bid.procuring_entity}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 h-9 w-9 rounded-lg text-black/62 hover:text-black hover:bg-[#1EA0DA]/6 transition text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-6 space-y-8">
          {!bid.details && (
            <div className="bg-[#1EA0DA]/8 border border-[#1EA0DA]/25 text-[#12769F] text-sm rounded-[14px] px-4 py-3">
              Full notice details have not been captured for this tender yet. The next automatic update (hourly, 6 AM–5 PM) reads them from PhilGEPS.
            </div>
          )}

          {/* Key facts */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <Fact label="Reference No." value={bid.ref_no} />
            <Fact label="Solicitation No." value={d.solicitation_no} />
            <Fact
              label="Approved Budget (ABC)"
              value={bid.abc_amount && formatPeso(bid.abc_amount)}
            />
            <Fact label="Procurement Mode" value={d.procurement_mode} />
            <Fact label="Published" value={formatDate(bid.publish_date)} />
            <Fact label="Closing" value={formatDateTime(bid.closing_date)} />
            <Fact label="Delivery Period" value={d.delivery_period} />
            <Fact label="Area of Delivery" value={d.area_of_delivery} />
            <Fact label="PhilGEPS Status" value={d.status} />
            <Fact label="Last Updated" value={d.last_updated} />
          </dl>

          {/* Files downloaded by the logged-in fetch, opened from this machine's documents/ folder */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-black/62 mb-3">
              Downloaded Documents{documents.length ? ` (${documents.length})` : ''}
            </h3>
            {documents.length > 0 ? (
              <ul className="bg-white border border-[#E2E8F0] rounded-[14px] divide-y divide-[#E2E8F0] text-sm">
                {documents.map((doc) => (
                  <li key={doc.name} className="px-4 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-black truncate" title={doc.title}>{doc.title}</div>
                      <div className="text-xs text-black/46 mt-0.5 truncate">
                        {doc.name} · {formatSize(doc.size)} · {doc.order_no ? `PhilGEPS order ${doc.order_no}` : doc.source === 'supplements' ? 'bid supplement' : 'PhilGEPS'} · {formatInstant(doc.downloaded_at)}
                      </div>
                    </div>
                    {validRef && (
                      <button
                        onClick={() => openDocument(bid.ref_no, doc)}
                        className="shrink-0 text-xs font-semibold text-[#12769F] hover:text-[#0E5C7C] transition"
                      >
                        Open ↗
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {/* Remarks: why this tender has documents or not */}
            <div className={`${documents.length ? 'mt-3' : ''} rounded-[14px] border px-4 py-3 ${REMARK_STYLE[remark.tone]}`}>
              <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">Remarks · {remark.label}</div>
              <p className="text-sm mt-1 leading-relaxed">{remark.text}</p>
              {d.documents_checked_at && (
                <p className="text-xs opacity-70 mt-1.5">Last checked {formatInstant(d.documents_checked_at)}</p>
              )}
            </div>

          </section>


          {/* Our products */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-black/62 mb-3">Our Products Requested</h3>
            <div className="flex flex-wrap gap-1.5">
              {matched.map((name) => (
                <span key={name} className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#61A644]/10 text-[#3F6F2C] border border-[#61A644]/25">
                  {name}
                </span>
              ))}
            </div>
          </section>

          {/* Only the item lines that request our products */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-black/62 mb-3">
              Requested Items{items?.length ? ` (${items.length})` : ''}
            </h3>
            {items === undefined ? (
              <p className="text-sm text-black/46">The next automatic update (hourly, 6 AM–5 PM) picks out the requested items for this tender.</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-black/46">
                Our products are named in the title only; no single item line mentions them. See the full description below.
              </p>
            ) : (
              <div className="overflow-x-auto bg-white border border-[#E2E8F0] rounded-[14px]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-black/46 border-b border-[#E2E8F0]">
                      <th className="py-2 px-3 text-left w-10">#</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-left">Unit</th>
                      <th className="py-2 px-3 text-left">Description</th>
                      <th className="py-2 px-3 text-right">Unit Price</th>
                      <th className="py-2 px-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0]">
                    {items.map((item, i) =>
                      item.description ? (
                        <tr key={i} className="text-black align-top">
                          <td className="py-2 px-3 text-black/46 font-mono text-xs">{item.item_no || '—'}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{item.quantity?.toLocaleString('en-PH')}</td>
                          <td className="py-2 px-3">{item.unit}</td>
                          <td className="py-2 px-3">{highlight(item.description, item.products)}</td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatPeso(item.unit_price) || '—'}</td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatPeso(item.total) || '—'}</td>
                        </tr>
                      ) : (
                        // Layout the scraper couldn't split into columns: show the line as written
                        <tr key={i} className="text-black">
                          <td colSpan="6" className="py-2 px-3">{highlight(item.line, item.products)}</td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Full notice text, collapsed unless there are no requested items to show */}
          <section>
            {bid.items_text ? (
              <details open={!items?.length} className="group bg-white border border-[#E2E8F0] rounded-[14px]">
                <summary className="cursor-pointer select-none list-none px-4 py-3 text-xs font-semibold uppercase tracking-wider text-black/62 hover:text-black flex items-center justify-between">
                  Full Description
                  <span className="text-black/46 transition group-open:rotate-180">▾</span>
                </summary>
                <div className="px-4 pb-4 text-sm text-black leading-relaxed whitespace-pre-wrap max-h-[28rem] overflow-y-auto">
                  {highlight(bid.items_text, matched)}
                </div>
              </details>
            ) : (
              <p className="text-sm text-black/46">No description on the PhilGEPS notice.</p>
            )}
          </section>

          {/* Bid supplements list (public) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-black/62 mb-3">
              Documents / Bid Supplements{supplements.length ? ` (${supplements.length})` : ''}
            </h3>
            {supplements.length > 0 ? (
              <ul className="bg-white border border-[#E2E8F0] rounded-[14px] divide-y divide-[#E2E8F0] text-sm">
                {supplements.map((s) => (
                  <li key={s.no} className="px-4 py-3">
                    <div className="text-black">{s.title}</div>
                    <div className="text-xs text-black/46 mt-0.5">
                      {s.no} · {s.type} · {formatDate(s.published) || s.published}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-black/46">No bid bulletins or addenda posted.</p>
            )}
            {validRef && supplements.length > 0 && (
              <a
                href={supplementsUrl(bid.ref_no)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#12769F] hover:text-[#0E5C7C] transition mt-1"
              >
                Open supplement list on PhilGEPS <span className="text-[10px]">↗</span>
              </a>
            )}
          </section>

          {/* Contact */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-black/62 mb-3">Contact Person</h3>
            {d.contact_name ? (
              <div className="bg-white border border-[#E2E8F0] rounded-[14px] p-4 text-sm space-y-0.5">
                <div className="font-semibold text-black">{d.contact_name}</div>
                {(d.contact_info || []).map((line, i) =>
                  EMAIL.test(line) ? (
                    <a key={i} href={`mailto:${line}`} className="block text-[#12769F] hover:text-[#0E5C7C] break-all">
                      {line}
                    </a>
                  ) : (
                    <div key={i} className="text-black/62">{line}</div>
                  )
                )}
              </div>
            ) : (
              <p className="text-sm text-black/46">—</p>
            )}
          </section>

          {PHILGEPS_LINK.test(bid.detail_link || '') && (
            <a
              href={bid.detail_link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-black/62 hover:text-black transition"
            >
              View original notice on PhilGEPS <span className="text-[10px]">↗</span>
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}
