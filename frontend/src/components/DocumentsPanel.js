'use client';

import { supabase } from '@/lib/supabase';
import { formatInstant } from '@/lib/format';
import { PanelSection } from '@/components/PsDetailsPanel';

// The "Attached documents" section of View details, shared by PhilGEPS (TenderDetails) and PS-PhilGEPS
// (Bid Match): a status pill beside the title, one card per file with View (opens in a new tab) and Save
// (downloads), then a muted line on where the files came from and when they were checked.
// Files in a private Storage bucket open by a short-lived signed link; older ones (no path) only from the
// computer that downloaded them (/api/documents).

const STATUS_TONE = {
  green: 'border-[#61A644]/25 bg-[#61A644]/10 text-[#3F6F2C]',
  blue: 'border-[#1EA0DA]/25 bg-[#1EA0DA]/10 text-[#12769F]',
  grey: 'border-[#CBD5E1] bg-[#E2E8F0]/50 text-black/62',
  red: 'border-[#B3312C]/25 bg-[#B3312C]/8 text-[#B3312C]',
};

const KINDS = { pdf: 'PDF', docx: 'Word', doc: 'Word', xlsx: 'Excel', xls: 'Excel', zip: 'ZIP', jpg: 'Image', jpeg: 'Image', png: 'Image' };
const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const sizeText = (bytes) =>
  !bytes ? null : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// A bid bulletin / supplement: fetched from the bulletin's page (PhilGEPS, philgepsSync.mjs fetchBulletins), a
// PS-PhilGEPS corrigendum file, or named so. Shown apart from the bidding documents (user, 2026-11-05)
// When a bid bulletin was published on the portal: PS-PhilGEPS gives the time (published_at, psSync.mjs), PhilGEPS
// the day (published "YYYY-MM-DD", from its Bid Supplements list). Shown on its card and in the line below (user, 2026-11-11)
export const bulletinPublished = (b) =>
  b.published_at
    ? formatInstant(b.published_at)
    : b.published
      ? new Date(`${b.published}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' })
      : null;
const publishedTime = (b) => (b.published_at ? Date.parse(b.published_at) : b.published ? Date.parse(`${b.published}T00:00:00+08:00`) : Infinity);

export const isBulletin = (doc) =>
  doc.source === 'bulletin' ||
  Boolean(doc.supplement_no) ||
  /corrigendum/i.test(doc.url || '') ||
  /bid[\s._-]*bulletin|supplement(?:al)?[\s._-]*bulletin|addendum|corrigendum/i.test(doc.name || '');

/**
 * @param {object[]} props.documents  [{ name, title?, path?, size?, downloaded_at? }]
 * @param {string} props.bucket       Storage bucket of the files ("philgeps-documents", "ps-documents")
 * @param {string} props.tenderRef    Reference number (for files without a path)
 * @param {string} [props.source]     "ps" for /api/documents of PS-PhilGEPS files
 * @param {{ label: string, tone: string }} [props.status]  Pill beside the title
 * @param {React.ReactNode} [props.footer]  Muted line under the files (where from, last checked)
 * @param {React.ReactNode} [props.empty]   Shown when there are no files
 */
export default function DocumentsPanel({ documents = [], pendingBulletins = [], pendingLink, bucket, tenderRef, source, status, footer, empty = 'None found', children }) {
  const canOpen = /^\d+$/.test(tenderRef || '');
  // One card per file (an older Sync could list the same file twice, PS 112434)
  const unique = documents.filter((d, i, all) => all.findIndex((x) => (x.path || x.name) === (d.path || d.name)) === i);
  const bulletins = unique.filter(isBulletin);
  const files = unique.filter((d) => !isBulletin(d));
  const list = (docs) => (
    <ul className="space-y-2">
      {docs.map((doc) => (
        <FileRow key={doc.path || doc.name} doc={doc} bucket={bucket} tenderRef={tenderRef} source={source} canOpen={canOpen} />
      ))}
    </ul>
  );
  return (
    <PanelSection
      title="Attached documents"
      count={unique.length + pendingBulletins.length}
      aside={
        status && (
          <span className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[status.tone] || STATUS_TONE.grey}`}>
            {status.label}
          </span>
        )
      }
    >
      {unique.length + pendingBulletins.length > 0 ? (
        <div className="space-y-4">
          {files.length > 0 && (
            <section>
              {bulletins.length + pendingBulletins.length > 0 && <GroupTitle label="Bidding documents" count={files.length} />}
              {list(files)}
            </section>
          )}
          {bulletins.length + pendingBulletins.length > 0 && (
            <section>
              <GroupTitle label="Bid bulletins" count={bulletins.length + pendingBulletins.length} />
              {list(bulletins)}
              {pendingBulletins.length > 0 && (
                <ul className={`space-y-2 ${bulletins.length ? 'mt-2' : ''}`}>
                  {pendingBulletins.map((b) => (
                    <PendingBulletin key={b.no} bulletin={b} link={pendingLink} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      ) : (
        <p className="text-xs text-black/46">{empty}</p>
      )}
      {footer && <p className="mt-2 px-1 text-[11px] leading-relaxed text-black/46">{footer}</p>}
      <BulletinDates bulletins={[...bulletins, ...pendingBulletins]} />
      {children}
    </PanelSection>
  );
}

// "Bid bulletins published: No. 1 on Oct 29, 2026, 10:30 AM · No. 2 on Nov 4, 2026", oldest first
function BulletinDates({ bulletins }) {
  const dated = bulletins.filter(bulletinPublished).sort((a, b) => publishedTime(a) - publishedTime(b));
  if (!dated.length) return null;
  const text =
    dated.length === 1
      ? `Bid bulletin published ${bulletinPublished(dated[0])}.`
      : `Bid bulletins published: ${dated.map((b, i) => `No. ${i + 1} on ${bulletinPublished(b)}`).join(' · ')}.`;
  return <p className="mt-1 px-1 text-[11px] leading-relaxed text-black/46">{text}</p>;
}

function GroupTitle({ label, count }) {
  return (
    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#12769F]">
      {label} <span className="font-normal text-black/46">({count})</span>
    </h4>
  );
}

// A bulletin PhilGEPS lists whose file isn't here yet: its title and number, why, and the PhilGEPS list
function PendingBulletin({ bulletin, link }) {
  const date = bulletinPublished(bulletin);
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-3 sm:flex-nowrap">
      <div className="min-w-0 flex-1 basis-56">
        <div className="break-words text-xs font-semibold text-black">{bulletin.title}</div>
        <div className="mt-0.5 text-[11px] text-black/46">
          {[bulletin.no, bulletin.type, date && `Published ${date}`, bulletin.noFile ? 'No file attached on PhilGEPS' : 'File comes with the next documents Sync'].filter(Boolean).join(' • ')}
        </div>
      </div>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer" className="flex w-full shrink-0 items-center justify-center rounded-lg bg-[#1EA0DA]/10 px-3 py-1.5 text-xs font-semibold text-[#12769F] transition-all hover:bg-[#1EA0DA]/20 sm:w-auto">
          Open on PhilGEPS
        </a>
      )}
    </li>
  );
}

function FileRow({ doc, bucket, tenderRef, source, canOpen }) {
  const ext = extensionOf(doc.name);
  const meta = [
    `${KINDS[ext] || ext.toUpperCase() || 'File'} document`,
    sizeText(doc.size),
    bulletinPublished(doc) && `Published ${bulletinPublished(doc)}`,
    doc.downloaded_at && `Downloaded ${formatInstant(doc.downloaded_at)}`,
    // Read, then not kept: none of our products (lib/documentKeep.mjs)
    doc.removed && 'Not kept: none of our products',
  ].filter(Boolean);
  return (
    <li className="group flex flex-wrap items-center gap-3 rounded-xl border border-[#E2E8F0] bg-white p-3 transition-all hover:border-[#1EA0DA] sm:flex-nowrap">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg ${ext === 'pdf' ? 'bg-[#B3312C]/8 text-[#B3312C]' : 'bg-[#1EA0DA]/10 text-[#12769F]'}`} aria-hidden>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="h-4 w-4">
            <path d="M5 2.5h6.5L15 6v11.5H5z" />
            <path d="M11.5 2.5V6H15" />
          </svg>
          <span className="mt-0.5 whitespace-nowrap text-[8px] font-bold uppercase leading-none tracking-tight">{(ext === 'jpeg' ? 'jpg' : ext.slice(0, 3)) || 'file'}</span>
        </span>
        <div className="min-w-0">
          <div className="break-words text-xs font-semibold text-black transition-colors group-hover:text-[#12769F]">{doc.title || doc.name}</div>
          <div className="mt-0.5 text-[11px] text-black/46">{meta.join(' • ')}</div>
        </div>
      </div>
      {doc.removed && doc.url && (
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full shrink-0 items-center justify-center rounded-lg bg-[#1EA0DA]/10 px-3 py-1.5 text-xs font-semibold text-[#12769F] transition-all hover:bg-[#1EA0DA]/20 sm:w-auto"
        >
          Open original
        </a>
      )}
      {canOpen && !doc.removed && (
        <div className="flex w-full shrink-0 gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => openDocument({ doc, bucket, tenderRef, source })}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#1EA0DA]/10 px-3 py-1.5 text-xs font-semibold text-[#12769F] transition-all hover:bg-[#1EA0DA]/20 sm:flex-none"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
              <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z" />
              <circle cx="10" cy="10" r="2.5" />
            </svg>
            View
          </button>
          <button
            type="button"
            onClick={() => openDocument({ doc, bucket, tenderRef, source, save: true })}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#1EA0DA] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-[#1790C5] sm:flex-none"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
              <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3.5 16.5h13" />
            </svg>
            Save
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Molecule tracker: where a line was read ("Bidding Documents.pdf, page 69"; two files when its quantity and
 * price came from different ones) as links to the real file: a PDF opens in a new tab at that page, a Word or
 * Excel file opens in Word or Excel (not the preview; user, 2026-10-31). A file no longer among the tender's
 * documents stays plain text.
 * @param {object} props.item  A line with source ("<file>, page 3" or "<file>, Word/Excel file") and paired_with
 * Other props as DocumentsPanel.
 */
export function SourceLinks({ item, documents = [], bucket, tenderRef, source }) {
  const places = [item.source, item.paired_with].filter(Boolean).map((text) => {
    const [, name = text, page] = /^(.*), (?:page (\d+)|Word\/Excel file)$/.exec(text) || [];
    return { name, page, doc: documents.find((d) => d.name === name && !d.removed) };
  });
  if (!places.length) return <span className="text-black/62">—</span>;
  return places.map(({ name, page, doc }, i) => {
    const label = page ? `${name}, page ${page}` : name;
    return (
      <span key={label} className="[overflow-wrap:anywhere]">
        {i > 0 && <span className="text-black/46"> + </span>}
        {doc ? (
          <button
            type="button"
            onClick={() => openSource({ doc, bucket, tenderRef, source, page })}
            title="Open this file"
            className="text-left text-[#12769F] underline underline-offset-2 hover:text-[#0E5C7C] [overflow-wrap:anywhere]"
          >
            {label}
          </button>
        ) : (
          <span className="text-black/62">{label}</span>
        )}
      </span>
    );
  });
}

// Word and Excel files, which a browser downloads instead of showing: View opens them in /documents/view
const PREVIEWED = new Set(['docx', 'xlsx']);

// A Source link: Word and Excel files open in the app itself by Office's own link type ("ms-word:ofv|u|<address>",
// read-only), which needs Office on a computer; a phone downloads the file instead. Anything else opens as View does.
const OFFICE_APP = { docx: 'ms-word', doc: 'ms-word', xlsx: 'ms-excel', xls: 'ms-excel' };
async function openSource(place) {
  const { doc, bucket } = place;
  const app = OFFICE_APP[extensionOf(doc.name)];
  if (!app) return openDocument(place);
  if (!/Windows|Macintosh/.test(navigator.userAgent)) return openDocument({ ...place, save: true });
  let link = new URL(localFileUrl(place), window.location.origin).href;
  if (doc.path) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(doc.path, 3600);
    if (error || !data?.signedUrl) {
      alert(`Could not open ${doc.name}: ${error?.message || 'no link'}`);
      return;
    }
    link = data.signedUrl;
  }
  const officeLink = document.createElement('a');
  officeLink.href = `${app}:ofv|u|${link}`;
  officeLink.click();
}

// An older file without a Storage path, served by the computer that downloaded it
const localFileUrl = ({ doc, tenderRef, source }) =>
  `/api/documents?${source ? `source=${source}&` : ''}ref=${tenderRef}&name=${encodeURIComponent(doc.name)}`;

// View: a new tab (opened first so the browser doesn't block it as a pop-up), a PDF at `page` when given.
// Save: the file is downloaded.
async function openDocument({ doc, bucket, tenderRef, source, page, save = false }) {
  const atPage = page ? `#page=${page}` : '';
  const previewed = !save && PREVIEWED.has(extensionOf(doc.name));
  if (!doc.path) {
    const url = localFileUrl({ doc, tenderRef, source });
    if (save) download(url, doc.name);
    else window.open(previewed ? `/documents/view?src=${encodeURIComponent(url)}&name=${encodeURIComponent(doc.name)}` : `${url}${atPage}`, '_blank', 'noopener');
    return;
  }
  if (previewed) {
    window.open(`/documents/view?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(doc.path)}&name=${encodeURIComponent(doc.name)}`, '_blank', 'noopener');
    return;
  }
  const tab = save ? null : window.open('', '_blank');
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(doc.path, 3600, save ? { download: doc.name } : undefined);
  if (error || !data?.signedUrl) {
    tab?.close();
    alert(`Could not open ${doc.name}: ${error?.message || 'no link'}`);
    return;
  }
  const url = data.signedUrl + atPage;
  if (save) download(data.signedUrl, doc.name);
  else if (tab) tab.location.href = url;
  else window.location.href = url;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
