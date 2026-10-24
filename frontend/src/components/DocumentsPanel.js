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

/**
 * @param {object[]} props.documents  [{ name, title?, path?, size?, downloaded_at? }]
 * @param {string} props.bucket       Storage bucket of the files ("philgeps-documents", "ps-documents")
 * @param {string} props.tenderRef    Reference number (for files without a path)
 * @param {string} [props.source]     "ps" for /api/documents of PS-PhilGEPS files
 * @param {{ label: string, tone: string }} [props.status]  Pill beside the title
 * @param {React.ReactNode} [props.footer]  Muted line under the files (where from, last checked)
 * @param {React.ReactNode} [props.empty]   Shown when there are no files
 */
export default function DocumentsPanel({ documents = [], bucket, tenderRef, source, status, footer, empty = 'None found', children }) {
  const canOpen = /^\d+$/.test(tenderRef || '');
  return (
    <PanelSection
      title="Attached documents"
      count={documents.length}
      aside={
        status && (
          <span className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[status.tone] || STATUS_TONE.grey}`}>
            {status.label}
          </span>
        )
      }
    >
      {documents.length > 0 ? (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <FileRow key={doc.path || doc.name} doc={doc} bucket={bucket} tenderRef={tenderRef} source={source} canOpen={canOpen} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-black/46">{empty}</p>
      )}
      {footer && <p className="mt-2 px-1 text-[11px] leading-relaxed text-black/46">{footer}</p>}
      {children}
    </PanelSection>
  );
}

function FileRow({ doc, bucket, tenderRef, source, canOpen }) {
  const ext = extensionOf(doc.name);
  const meta = [
    `${KINDS[ext] || ext.toUpperCase() || 'File'} document`,
    sizeText(doc.size),
    doc.downloaded_at && `Downloaded ${formatInstant(doc.downloaded_at)}`,
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
      {canOpen && (
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

// View: a new tab (opened first so the browser doesn't block it as a pop-up). Save: the file is downloaded.
async function openDocument({ doc, bucket, tenderRef, source, save = false }) {
  if (!doc.path) {
    const url = `/api/documents?${source ? `source=${source}&` : ''}ref=${tenderRef}&name=${encodeURIComponent(doc.name)}`;
    if (save) download(url, doc.name);
    else window.open(url, '_blank', 'noopener');
    return;
  }
  const tab = save ? null : window.open('', '_blank');
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(doc.path, 3600, save ? { download: doc.name } : undefined);
  if (error || !data?.signedUrl) {
    tab?.close();
    alert(`Could not open ${doc.name}: ${error?.message || 'no link'}`);
    return;
  }
  if (save) download(data.signedUrl, doc.name);
  else if (tab) tab.location.href = data.signedUrl;
  else window.location.href = data.signedUrl;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
