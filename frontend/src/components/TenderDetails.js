'use client';

import { formatDate, formatDateTime, formatInstant, formatPeso } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { bidDateText, deliveryText } from '@/lib/bidDates';
import ResponsiveTable from '@/components/ResponsiveTable';
import PsDetailsPanel, { KeyValueList, ManualCheckNote, PanelSection, ProductPills } from '@/components/PsDetailsPanel';

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
// Same colours as the PS-PhilGEPS panel's small notes
const REMARK_TONE = {
  green: 'text-[#3F6F2C]',
  grey: 'text-black/62',
  red: 'text-[#B3312C]',
  blue: 'text-[#12769F]',
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

// Side panel for one tender, built on the PS-PhilGEPS panel (PsDetailsPanel) so both look the same: title and
// agency, "Bidding dates" first, the notice's label/value facts, then Our products, Molecule tracker,
// Documents, and the sections only PhilGEPS has (full description, supplements, contact person)
export default function TenderDetails({ bid, onClose }) {
  const d = bid.details || {};
  // Bid data sheet read from the downloaded documents (philgepsSync.mjs)
  const bds = d.documents_bid_data_sheet || {};
  const matched = bid.matched_molecules || [];
  // Lines naming our products: from the notice's item list (scraper; missing until the next update) and from
  // the downloaded documents (Sync, philgepsSync.mjs), as in the PS-PhilGEPS molecule tracker
  const descriptionItems = d.matched_items;
  // The documents are trusted over the notice: a product with lines in the documents shows only those
  const inDocuments = new Set((d.documents_items || []).flatMap((item) => item.our_products || []));
  const items =
    descriptionItems === undefined && !d.documents_items
      ? undefined
      : [
          ...(descriptionItems || [])
            .filter((item) => !(item.products || []).length || !item.products.every((p) => inDocuments.has(p)))
            .map((item) => ({ ...item, where: 'Description' })),
          ...(d.documents_items || []).map((item) => ({ ...item, products: item.our_products, where: item.source?.split(', ').pop() || 'Documents' })),
        ];
  const supplements = d.supplements || [];
  const documents = d.documents || [];
  const remark = documentsRemark(bid);
  const validRef = /^\d+$/.test(bid.ref_no || '');

  // PsDetailsPanel reads a list row: headers + cells (empty values are left out)
  const facts = [
    ['Notice Title', bid.title],
    ['Agency name', bid.procuring_entity],
    ['Reference Number', bid.ref_no],
    ['Notice type', d.notice_type],
    ['Solicitation Number', d.solicitation_no],
    ['Approve Budget Contract', bid.abc_amount && formatPeso(bid.abc_amount)],
    ['Mode of Procurement', d.procurement_mode],
    ['Classification', d.classification],
    ['Publish Date', formatDate(bid.publish_date)],
    ['Closing Date', formatDateTime(bid.closing_date)],
    ['Delivery Period', d.delivery_period],
    ['Area of Delivery', d.area_of_delivery],
    ['Status', d.status],
  ];
  const list = { headers: facts.map(([h]) => h) };
  const row = { cells: facts.map(([, v]) => v || ''), links: [] };

  return (
    <PsDetailsPanel
      list={list}
      row={row}
      titleColumn="Notice Title"
      subtitleColumn="Agency name"
      link={PHILGEPS_LINK.test(bid.detail_link || '') ? bid.detail_link : null}
      wide
      onClose={onClose}
      lead={
        <>
          {!bid.details && (
            <p className="text-sm text-black/46">
              Full notice details have not been captured for this tender yet. The next automatic update (hourly, 6 AM–5 PM) reads them from PhilGEPS.
            </p>
          )}
          <PanelSection title="Bidding dates" tone="blue">
            {/* The description first, else what the bid documents say (PhilGEPS's notice page has no schedule) */}
            <KeyValueList
              items={[
                ['Pre-bid conference', d.pre_bid || fromDocs(bidDateText(bds.prebid_conference))],
                ['Bid opening', d.bid_opening || fromDocs(bidDateText(bds.bid_opening))],
                ['Submission deadline', fromDocs(bidDateText(bds.bid_submission_deadline))],
                ['Closing', formatDateTime(bid.closing_date)],
                ['Delivery period', d.delivery_period || fromDocs(deliveryText(bds.delivery_period))],
                ['Last updated', d.last_updated],
              ]}
              missing={documents.length ? 'Not in the notice or its documents' : 'Not on the notice page'}
            />
          </PanelSection>
        </>
      }
    >
      <PanelSection title="Our products" count={matched.length} plain>
        <ProductPills names={matched} />
      </PanelSection>

      {/* Only the item lines that request our products */}
      <PanelSection title={`Molecule tracker${items?.length ? ` (${items.length} lines naming our products)` : ''}`}>
        {items === undefined ? (
          <p className="text-sm text-black/46">The next automatic update (hourly, 6 AM–5 PM) picks out the requested items for this tender.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-black/46">
            {d.documents_read_key
              ? 'No line in the description or the readable documents names our products.'
              : 'Our products are named in the title only; no single item line mentions them. See the full description below.'}
          </p>
        ) : (
          <ResponsiveTable
            size="xs"
            rows={items}
            columns={[
              { label: 'Product', title: true, render: (item) => <span className="text-[#3F6F2C]">{(item.products || []).join(', ') || '—'}</span> },
              { label: 'Item', render: (item) => item.item_no || '—' },
              { label: 'Qty', nowrap: true, render: (item) => (item.quantity != null ? item.quantity.toLocaleString('en-PH') : '—') },
              { label: 'Unit', render: (item) => item.unit || '—' },
              { label: 'Unit price', nowrap: true, render: (item) => formatPeso(item.unit_price) || '—' },
              { label: 'Total', nowrap: true, render: (item) => formatPeso(item.total) || '—' },
              // A line the scraper couldn't split into columns is shown as written
              { label: 'As written', wide: true, render: (item) => <span className="text-black/62">{item.where === 'Description' ? item.description || item.line : item.line}</span> },
              { label: 'Found in', render: (item) => <span className="text-black/46">{item.where}</span> },
            ]}
          />
        )}
      </PanelSection>

      {/* Files downloaded by Sync; the remark says why there are files or not */}
      <PanelSection title="Documents">
        {documents.length > 0 ? (
          <ul className="space-y-1">
            {documents.map((doc) => (
              <li key={doc.name}>
                {validRef ? (
                  <button
                    onClick={() => openDocument(bid.ref_no, doc)}
                    className="text-left text-xs text-[#12769F] hover:text-[#0E5C7C] hover:underline break-all"
                  >
                    📄 {doc.title || doc.name}
                  </button>
                ) : (
                  <span className="text-xs">📄 {doc.title || doc.name}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-black/46">None found</span>
        )}
        <p className={`text-xs ${REMARK_TONE[remark.tone]}`}>
          <span className="font-semibold">{remark.label}.</span> {remark.text}
          {d.documents_checked_at && <span className="text-black/46"> Last checked {formatInstant(d.documents_checked_at)}.</span>}
        </p>
        {/* As on PS-PhilGEPS: files whose text couldn't be read for our products (lib/manualCheck.js) */}
        <ManualCheckNote read={d.documents_read} />
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
          <FactList items={[['Name', d.contact_name], ...(d.contact_info || []).map((line, i) => [i ? '' : 'Contact', contactLine(line)])].filter(([, v]) => v)} />
        ) : (
          <span className="text-black/46">—</span>
        )}
      </PanelSection>
    </PsDetailsPanel>
  );
}

const contactLine = (line) =>
  EMAIL.test(line) ? (
    <a href={`mailto:${line}`} className="text-[#12769F] hover:text-[#0E5C7C] break-all">{line}</a>
  ) : (
    line
  );

// Label / value pairs as in the PS-PhilGEPS panel; an empty value shows `missing` (or is left out when not given)
function FactList({ items, missing }) {
  const shown = missing ? items : items.filter(([, value]) => value);
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
      {shown.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="contents">
          <dt className="text-black/62">{label}</dt>
          <dd className={value ? 'text-black break-words' : 'text-black/46'}>{value || missing}</dd>
        </div>
      ))}
    </dl>
  );
}

// A value read from the bid documents, marked as such (same marker as the PS-PhilGEPS panel)
function fromDocs(text) {
  if (!text) return null;
  return (
    <>
      {text} <span className="ml-1 whitespace-nowrap rounded bg-[#61A644]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#3F6F2C]">from documents</span>
    </>
  );
}
