'use client';

import { useEffect } from 'react';
import { formatDate, formatDateTime, formatInstant, formatPeso } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { PanelSection } from '@/components/PsDetailsPanel';
import HospitalLinks from '@/components/HospitalLinks';

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

// Side panel with everything the scraper stored for one tender, laid out like the PS-PhilGEPS panel
// (PsDetailsPanel): title and agency, label/value facts, then small-heading sections
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

  const facts = [
    ['Reference Number', bid.ref_no],
    ['Notice type', d.notice_type],
    ['Solicitation Number', d.solicitation_no],
    ['Approved Budget', bid.abc_amount && formatPeso(bid.abc_amount)],
    ['Procurement Mode', d.procurement_mode],
    ['Classification', d.classification],
    ['Publish Date', formatDate(bid.publish_date)],
    ['Closing Date', formatDateTime(bid.closing_date)],
    ['Delivery Period', d.delivery_period],
    ['Area of Delivery', d.area_of_delivery],
    ['Status', d.status],
    ['Last Updated', d.last_updated],
  ].filter(([, value]) => value);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={bid.title}>
      <button className="absolute inset-0 bg-black/20" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-4xl h-full overflow-y-auto bg-white p-6 shadow-[0_4px_16px_rgba(0,0,0,.08)] space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-black leading-snug">{bid.title}</h2>
            <p className="text-sm text-black/62 mt-1">{bid.procuring_entity}</p>
            <HospitalLinks name={bid.procuring_entity} />
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full px-3 py-1 text-sm text-black/62 hover:bg-[#1EA0DA]/6" aria-label="Close">
            ✕
          </button>
        </div>

        {!bid.details && (
          <p className="rounded-[14px] border border-[#1EA0DA]/25 bg-[#1EA0DA]/6 px-4 py-3 text-sm text-[#12769F]">
            Full notice details have not been captured for this tender yet. The next automatic update (hourly, 6 AM–5 PM) reads them from PhilGEPS.
          </p>
        )}

        <FactList items={facts} />

        <PanelSection title="Schedule">
          <FactList
            items={[
              ['Pre-bid conference', d.pre_bid],
              ['Bid opening', d.bid_opening],
              ['Closing', formatDateTime(bid.closing_date)],
            ]}
            missing="Not on the notice page"
          />
        </PanelSection>

        <PanelSection title="Our products">
          {matched.length ? (
            <div className="flex flex-wrap gap-1">
              {matched.map((name) => (
                <span key={name} className="rounded-full bg-[#61A644]/10 text-[#3F6F2C] px-2 py-0.5 text-xs">{name}</span>
              ))}
            </div>
          ) : (
            <span className="text-black/46">—</span>
          )}
        </PanelSection>

        {/* Files downloaded by Sync; Remarks say why there are files or not */}
        <PanelSection title={`Documents${documents.length ? ` (${documents.length})` : ''}`}>
          {documents.length > 0 && (
            <ul className="space-y-1.5">
              {documents.map((doc) => (
                <li key={doc.name}>
                  {validRef ? (
                    <button
                      onClick={() => openDocument(bid.ref_no, doc)}
                      className="text-left text-sm text-[#12769F] hover:text-[#0E5C7C] hover:underline break-all"
                    >
                      📄 {doc.title || doc.name}
                    </button>
                  ) : (
                    <span className="text-sm">📄 {doc.title || doc.name}</span>
                  )}
                  <div className="text-xs text-black/46 pl-6 break-all">
                    {doc.name} · {formatSize(doc.size)}
                    {doc.order_no ? ` · PhilGEPS order ${doc.order_no}` : ''} · {formatInstant(doc.downloaded_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className={`rounded-[14px] border px-4 py-3 ${REMARK_STYLE[remark.tone]}`}>
            <div className="text-xs font-semibold">Remarks · {remark.label}</div>
            <p className="text-sm mt-1 leading-relaxed">{remark.text}</p>
            {d.documents_checked_at && <p className="text-xs opacity-70 mt-1.5">Last checked {formatInstant(d.documents_checked_at)}</p>}
          </div>
        </PanelSection>

        {/* Only the item lines that request our products */}
        <PanelSection title={`Requested items${items?.length ? ` (${items.length} lines naming our products)` : ''}`}>
          {items === undefined ? (
            <p className="text-sm text-black/46">The next automatic update (hourly, 6 AM–5 PM) picks out the requested items for this tender.</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-black/46">Our products are named in the title only; no single item line mentions them. See the full description below.</p>
          ) : (
            <div className="overflow-x-auto rounded-[14px] border border-[#E2E8F0]">
              <table className="w-full text-xs">
                <thead className="bg-[#1EA0DA]/5 text-left text-black/62">
                  <tr>
                    {['Item', 'Qty', 'Unit', 'Description', 'Unit price', 'Total'].map((h) => (
                      <th key={h} className="px-2.5 py-2 font-semibold whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) =>
                    item.description ? (
                      <tr key={i} className="border-t border-[#E2E8F0] align-top">
                        <td className="px-2.5 py-2">{item.item_no || '—'}</td>
                        <td className="px-2.5 py-2 whitespace-nowrap">{item.quantity != null ? item.quantity.toLocaleString('en-PH') : '—'}</td>
                        <td className="px-2.5 py-2">{item.unit || '—'}</td>
                        <td className="px-2.5 py-2 min-w-[16rem]">{highlight(item.description, item.products)}</td>
                        <td className="px-2.5 py-2 whitespace-nowrap">{formatPeso(item.unit_price) || '—'}</td>
                        <td className="px-2.5 py-2 whitespace-nowrap">{formatPeso(item.total) || '—'}</td>
                      </tr>
                    ) : (
                      // Layout the scraper couldn't split into columns: show the line as written
                      <tr key={i} className="border-t border-[#E2E8F0]">
                        <td colSpan="6" className="px-2.5 py-2 text-black/62">{highlight(item.line, item.products)}</td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </PanelSection>

        {/* Full notice text, collapsed unless there are no requested items to show */}
        <PanelSection title="Full description">
          {bid.items_text ? (
            <details open={!items?.length} className="group rounded-[14px] border border-[#E2E8F0]">
              <summary className="cursor-pointer select-none list-none px-4 py-2.5 text-sm text-[#12769F] hover:text-[#0E5C7C] flex items-center justify-between">
                <span className="group-open:hidden">Show the notice text</span>
                <span className="hidden group-open:inline">Hide the notice text</span>
                <span className="text-black/46 transition group-open:rotate-180">▾</span>
              </summary>
              <div className="px-4 pb-4 text-sm text-black leading-relaxed whitespace-pre-wrap max-h-[28rem] overflow-y-auto">
                {highlight(bid.items_text, matched)}
              </div>
            </details>
          ) : (
            <p className="text-sm text-black/46">No description on the PhilGEPS notice.</p>
          )}
        </PanelSection>

        <PanelSection title={`Bid supplements${supplements.length ? ` (${supplements.length})` : ''}`}>
          {supplements.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {supplements.map((s) => (
                <li key={s.no}>
                  <div className="text-black">{s.title}</div>
                  <div className="text-xs text-black/46">{s.no} · {s.type} · {formatDate(s.published) || s.published}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-black/46">No bid bulletins or addenda posted.</p>
          )}
          {validRef && supplements.length > 0 && (
            <a href={supplementsUrl(bid.ref_no)} target="_blank" rel="noreferrer" className="inline-block text-sm text-[#12769F] hover:text-[#0E5C7C] hover:underline">
              Supplement list on PhilGEPS ↗
            </a>
          )}
        </PanelSection>

        <PanelSection title="Contact person">
          {d.contact_name ? (
            <div className="text-sm space-y-0.5">
              <div className="font-semibold text-black">{d.contact_name}</div>
              {(d.contact_info || []).map((line, i) =>
                EMAIL.test(line) ? (
                  <a key={i} href={`mailto:${line}`} className="block text-[#12769F] hover:text-[#0E5C7C] break-all">{line}</a>
                ) : (
                  <div key={i} className="text-black/62">{line}</div>
                )
              )}
            </div>
          ) : (
            <span className="text-black/46">—</span>
          )}
        </PanelSection>

        {PHILGEPS_LINK.test(bid.detail_link || '') && (
          <a href={bid.detail_link} target="_blank" rel="noreferrer" className="inline-block text-sm text-[#12769F] hover:text-[#0E5C7C] hover:underline">
            Open on PhilGEPS ↗
          </a>
        )}
      </div>
    </div>
  );
}

// Label / value pairs as in the PS-PhilGEPS panel; an empty value shows `missing` (or is left out when not given)
function FactList({ items, missing }) {
  const shown = missing ? items : items.filter(([, value]) => value);
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-black/62">{label}</dt>
          <dd className={value ? 'text-black break-words' : 'text-black/46'}>{value || missing}</dd>
        </div>
      ))}
    </dl>
  );
}
