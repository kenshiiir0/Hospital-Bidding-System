'use client';

import ResponsiveTable from '@/components/ResponsiveTable';
import PsDetailsPanel, { AbcAmount, ChecklistList, ComputedNote, KeyValueList, MissingTag, PanelSection, ProductPills, ReadingNote } from '@/components/PsDetailsPanel';
import ScreenButton from '@/components/ScreenButton';
import FetchedSection from '@/components/FetchedSection';
import DocumentsPanel, { SourceLinks } from '@/components/DocumentsPanel';
import { stillReading } from '@/lib/documentsReading';
import { ReadingAlertBox } from '@/components/ReadingAlert';
import { abcOf, asWritten, moleculeText, psRefOf, psTender } from '@/lib/opportunityWorkbook';
import { bidDateText, deliveryText } from '@/lib/bidDates';
import { formatInstant } from '@/lib/format';
import LotGroups from '@/components/LotGroups';

// View details for one PS-PhilGEPS Bid Match tender, opened from Bid Match and from Screened Tenders:
// bidding dates, when it was fetched, our products, what was read in its documents and the files, with
// "Add to Screened" in the footer.
// data: the PS-PhilGEPS data (lists.bidMatch, notices, analysis, syncedAt); row: a Bid Match row;
// lastSyncBy: who started the Sync that fetched the list (optional).
export default function PsBidMatchDetails({ data, row, lastSyncBy, onClose }) {
  const list = data.lists.bidMatch;
  const ref = psRefOf(row);
  const notice = data.notices?.[ref];
  const reading = data.analysis?.[ref];
  // Our products: matched on the notice page or named in its documents
  const products = [...new Set([...(notice?.matched || []), ...(reading?.result?.items || []).flatMap((i) => i.our_products)])];
  return (
    <PsDetailsPanel
      list={list}
      row={row}
      titleColumn="Notice Title"
      subtitleColumn="Agency name"
      address={notice?.address}
      link={row.links.find((l) => /viewBidNotice/.test(l.href))?.href}
      wide
      onClose={onClose}
      action={
        <ScreenButton
          source="ps"
          tenderRef={ref}
          title={row.cells[list.headers.indexOf('Notice Title')]}
          products={products}
          getTender={() => psTender(row, list.headers, notice, reading)}
        />
      }
      lead={
        <>
          <PanelSection title="Bidding dates" tone="blue">
            <ScheduleList schedule={notice?.schedule} reading={reading} />
          </PanelSection>
          {/* When this tender was fetched (the last Sync's list) and its documents read, and the automatic schedule */}
          <FetchedSection
            items={[
              // (kept since 2026-11-19; earlier tenders weren't timed)
              ['First fetched', notice && (notice.first_seen ? formatInstant(notice.first_seen) : 'Before Nov 19, 2026 (not recorded)')],
              ['Last fetched', data.syncedAt && [formatInstant(data.syncedAt), lastSyncBy].filter(Boolean).join(' · ')],
              ['Documents read', reading?.analyzed_at && `${formatInstant(reading.analyzed_at)} · Automatic`],
            ]}
          />
        </>
      }
    >
      <PanelSection title="Our products" count={products.length} plain>
        <ProductPills names={products} />
      </PanelSection>
      <FromDocuments reading={reading} tenderRef={ref} documents={notice?.documents} noticeItems={notice?.matched_items} lot={Boolean(notice?.lot)} lotType={notice?.lot_type} />
      <PsDocuments ref_={ref} notice={notice} syncedAt={data.syncedAt} />
    </PsDetailsPanel>
  );
}

// The top of View details, where the team looks first: every date and term needed to bid. Each comes from
// the notice page (Sync, psSync.mjs readSchedule) or, when the notice page doesn't give it, from the bid
// documents (psDocs.mjs bid data sheet, tagged "from documents"). The full sections stay further down.
function ScheduleList({ schedule, reading }) {
  if (!schedule && !reading) return <MissingTag>Not read yet (Sync again)</MissingTag>;
  const bds = reading?.status === 'done' ? reading.result.bid_data_sheet : {};
  const pick = (fromPage, fromDocs) => fromPage || (fromDocs && <FromDocs text={fromDocs} />) || null;
  return (
    <KeyValueList
      missing="Not found"
      items={[
        ['Pre-bid conference', pick(schedule?.prebid && [schedule.prebid, schedule.prebidVenue].filter(Boolean).join(' · '), bidDateText(bds.prebid_conference))],
        ['Request for clarification', pick(schedule?.clarification)],
        ['Bid opening', pick(schedule?.bidOpening, bidDateText(bds.bid_opening))],
        ['Submission deadline', pick(schedule?.deadline, bidDateText(bds.bid_submission_deadline))],
        ['Closing', pick(schedule?.closing)],
        ['Delivery period', pick(null, deliveryText(bds.delivery_period))],
        ['Bid validity', pick(null, bds.bid_validity)],
        ['Bid security', pick(null, bds.bid_security)],
        ['Last updated', pick(schedule?.lastUpdated)],
      ]}
    />
  );
}

function FromDocs({ text }) {
  return (
    <>
      {text} <span className="ml-1 whitespace-nowrap rounded bg-[#61A644]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#3F6F2C]">from documents</span>
    </>
  );
}

// What was read in the tender's PDFs (lib/psDocs.mjs: free text rules; scanned PDFs can't be read)
const BDS_FIELDS = [
  ['Pre-bid conference', 'prebid_conference'],
  ['Bid opening', 'bid_opening'],
  ['Submission deadline', 'bid_submission_deadline'],
  ['Delivery period', 'delivery_period'],
  ['Bid validity', 'bid_validity'],
  ['Bid security', 'bid_security'],
];
const peso = (n) => (n == null ? '—' : Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 }));

// The notice page's own line items (psSync.mjs readLineItems) for the products the documents give no line for:
// documents first, the notice as fallback (user 2026-11-21, PS 153359: only the bidding documents' template was
// attached, so the tracker was empty though the notice lists 27 of our lines)
function trackerItems(reading, noticeItems) {
  const fromDocs = reading?.status === 'done' ? reading.result.items : [];
  const inDocuments = new Set(fromDocs.filter((i) => i.quantity != null).flatMap((i) => i.our_products || []));
  const fromNotice = (noticeItems || [])
    .filter((i) => !(i.products || []).every((p) => inDocuments.has(p)))
    .map((i) => ({
      ...i,
      description: i.line,
      our_products: i.products,
      written: [i.item_no, i.line, i.quantity?.toLocaleString('en-PH'), i.unit, i.total != null && peso(i.total)].filter(Boolean).join(' '),
      source: 'Notice page (Line Item Details)',
    }));
  return { items: [...fromDocs, ...fromNotice], fromNotice: fromNotice.length };
}

function FromDocuments({ reading, tenderRef, documents, noticeItems, lot, lotType }) {
  const { items, fromNotice } = trackerItems(reading, noticeItems);
  return (
    <>
      <PanelSection title="Bid data sheet (from the documents)">
        {!reading ? (
          <p className="text-xs text-black/46">The documents haven&rsquo;t been read yet (this happens within a few minutes of a Sync).</p>
        ) : reading.status !== 'done' ? (
          <MissingTag>{reading.error || 'Not read'}</MissingTag>
        ) : (
          <ChecklistList items={BDS_FIELDS.map(([label, key]) => [label, reading.result.bid_data_sheet[key]])} />
        )}
        {stillReading(reading?.documents_read) && (
          <div className="mt-2">
            <ReadingNote read={reading.documents_read} />
          </div>
        )}
      </PanelSection>
      {/* Always shown, as on PhilGEPS, so Attached documents sits in the same place on both portals */}
      <PanelSection title={`Molecule tracker${items.length ? ` (${items.length} lines naming our products)` : ''}`}>
        <ReadingAlertBox accuracy={reading?.result?.accuracy} reading={stillReading(reading?.documents_read)} />
        {/* A request for quotation: quantities and no budget per item (psDocs.mjs no_abc) */}
        {items.some((i) => i.no_abc) && (
          <p className="mb-2 text-xs text-black/62">
            The documents give the quantities and no ABC for these lines (a request for quotation: the bidders give the prices), so ABC/Unit and ABC Total are empty.
          </p>
        )}
        {fromNotice > 0 && (
          <p className="mb-2 text-xs text-black/62">
            {fromNotice === items.length ? 'The documents give no item lines for our products; these' : `${fromNotice} of these lines`} come from the notice page&rsquo;s Line Item Details (ABC/Unit worked out as ABC ÷ Qty).
          </p>
        )}
        {/* One lot: its lines are not shown as an opportunity (lib/packageTender.js); said so, with where it says it
            (user 2026-11-26, PS 161025: "No line in the readable documents names our products" on a tender whose
            rows had been read) */}
        {items.length ? null : lot ? (
          <p className="text-sm text-black/62">
            This tender is bought as <span className="font-medium">one lot</span>
            {/single\s+lot/i.test(lotType || '') ? ' (the notice says “Lot Type: Single Lot”)' : reading?.result?.package ? ' (its documents say so: one lot, partial bids not allowed)' : ' (its line item is “1 Lot”)'}, so its lines are not listed as an opportunity.
          </p>
        ) : reading?.status !== 'done' ? (
          <p className="text-sm text-black/46">
            {reading ? 'The documents could not be read, so no item lines were picked out.' : 'The item lines naming our products show here once the documents are read.'}
          </p>
        ) : (
          <p className="text-sm text-black/46">No line in the readable documents names our products.</p>
        )}
        {items.length > 0 && (
          <LotGroups items={items} leftOut={reading?.result?.lots_left_out}>{(rows) => <ResponsiveTable
            size="xs"
            rows={rows}
            columns={[
              // Same columns and wording as the Excel (lib/opportunityWorkbook.js): no item or page numbers
              { label: 'Molecule', title: true, render: (it) => <span className="font-medium text-[#3F6F2C]">{moleculeText(it.description || it.line, it.our_products)}</span> },
              { label: 'Qty', nowrap: true, render: (it) => (it.quantity != null ? `${it.quantity.toLocaleString('en-PH')} ${it.unit || ''}`.trim() : '—') },
              { label: 'ABC/Unit', nowrap: true, render: (it) => <AbcAmount text={abcOf(it).unitPrice == null ? null : peso(abcOf(it).unitPrice)} computed={abcOf(it).computed === 'unit_price'} formula="ABC Total ÷ Qty" /> },
              { label: 'ABC Total', nowrap: true, render: (it) => <AbcAmount text={abcOf(it).total == null ? null : peso(abcOf(it).total)} computed={abcOf(it).computed === 'total'} formula="Qty × ABC/Unit" /> },
              // The line exactly as the document gives it, to check against
              { label: 'As written', wide: true, render: (it) => <span className="text-black/62">{asWritten(it.written || (it.quantity != null ? it.line : it.context))}</span> },
              // The file (and page) to open to check this line
              { label: 'Source', wide: true, render: (it) => <SourceLinks item={it} documents={documents} bucket="ps-documents" tenderRef={tenderRef} source="ps" /> },
            ]}
          />}</LotGroups>
        )}
        {items.length > 0 && <ComputedNote items={items} abcOf={abcOf} />}
      </PanelSection>
    </>
  );
}

// The notice's files (psSync.mjs, Storage bucket ps-documents) in the shared Attached documents section
function PsDocuments({ ref_, notice, syncedAt }) {
  const documents = notice?.documents || [];
  const status = !notice
    ? { label: 'Not read yet', tone: 'blue' }
    : notice.error
      ? { label: 'Not read', tone: 'red' }
      : documents.length
        ? { label: '✓ Downloaded', tone: 'green' }
        : { label: 'None found', tone: 'grey' };
  const footer = notice?.error || [
    notice && 'From the PS-PhilGEPS notice page',
    syncedAt && `Last Sync ${formatInstant(syncedAt)}`,
  ].filter(Boolean).join(' · ');
  return (
    <DocumentsPanel
      documents={documents}
      bucket="ps-documents"
      tenderRef={ref_}
      source="ps"
      status={status}
      footer={footer}
      empty={notice ? 'None found' : 'Sync again to read this notice.'}
    />
  );
}
