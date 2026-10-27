'use client';

import ResponsiveTable from '@/components/ResponsiveTable';
import PsDetailsPanel, { ChecklistList, KeyValueList, MissingTag, PanelSection, ProductPills, ReadingNote } from '@/components/PsDetailsPanel';
import ScreenButton from '@/components/ScreenButton';
import FetchedSection from '@/components/FetchedSection';
import DocumentsPanel from '@/components/DocumentsPanel';
import { stillReading } from '@/lib/documentsReading';
import { abcOf, asWritten, moleculeText, psRefOf, psTender } from '@/lib/opportunityWorkbook';
import { bidDateText, deliveryText } from '@/lib/bidDates';
import { formatInstant } from '@/lib/format';

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
      <FromDocuments reading={reading} />
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

function FromDocuments({ reading }) {
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
      <PanelSection title={`Molecule tracker${reading?.status === 'done' && reading.result.items.length ? ` (${reading.result.items.length} lines naming our products)` : ''}`}>
        {reading?.status !== 'done' ? (
          <p className="text-sm text-black/46">
            {reading ? 'The documents could not be read, so no item lines were picked out.' : 'The item lines naming our products show here once the documents are read.'}
          </p>
        ) : reading.result.items.length === 0 ? (
          <p className="text-sm text-black/46">No line in the readable documents names our products.</p>
        ) : (
          <ResponsiveTable
            size="xs"
            rows={reading.result.items}
            columns={[
              // Same columns and wording as the Excel (lib/opportunityWorkbook.js): no item or page numbers
              { label: 'Molecule', title: true, render: (it) => <span className="font-medium text-[#3F6F2C]">{moleculeText(it.description || it.line, it.our_products)}</span> },
              { label: 'Qty', nowrap: true, render: (it) => (it.quantity != null ? `${it.quantity.toLocaleString('en-PH')} ${it.unit || ''}`.trim() : '—') },
              { label: 'ABC/Unit', nowrap: true, render: (it) => peso(abcOf(it).unitPrice) },
              { label: 'ABC Total', nowrap: true, render: (it) => peso(abcOf(it).total) },
              // The line exactly as the document gives it, to check against
              { label: 'As written', wide: true, render: (it) => <span className="text-black/62">{asWritten(it.written || (it.quantity != null ? it.line : it.context))}</span> },
            ]}
          />
        )}
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
