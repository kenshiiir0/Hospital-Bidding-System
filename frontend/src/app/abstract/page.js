'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatPeso } from '@/lib/format';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';
import ImportExcel from '@/components/ImportExcel';
import { ABSTRACT_SHEET, completeHospitalAbstract, readAbstractSheet, readHospitalAbstract } from '@/lib/sheetImport.mjs';
import { SegmentedTabs } from '@/components/FilterControls';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import PageHeader, { KpiRow, blueAction } from '@/components/PageHeader';

// Abstract of Bids (table bid_abstracts, /api/abstracts): who won each item a hospital bid out, at what price, next to
// our price. From the "ABSTRACT 2026" sheet of the WINNING BID TRACKER (tools/import-abstract.mjs) plus Add Result.
// Hospitals post on PhilGEPS and PS-PhilGEPS alike; the abstract is the same for both.

// The winner is us (2MG Incorporated / GetMeds)
const isUs = (winner) => /\b2\s*MG\b|GET\s*MEDS/i.test(winner || '');
const resultOf = (r) => (isUs(r.winner) ? 'won' : r.our_price == null ? 'nobid' : 'lost');
// How far our price was above (+) or below (−) the winning price, in % of the winning price
const gapOf = (r) => (r.our_price != null && r.winning_price ? ((r.our_price - r.winning_price) / r.winning_price) * 100 : null);
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-PH'));

export default function AbstractPage() {
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState('');
  const [view, setView] = useState('all');
  const [archiving, setArchiving] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const listTop = useRef(null);

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/abstracts');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setResults(data);
      setError('');
    } catch (e) {
      setError(`Could not load the abstract: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(load);
  }, [load]);

  // Hospital List names, offered when importing a hospital's own abstract (the file names no hospital)
  const [hospitalList, setHospitalList] = useState([]);
  useEffect(() => {
    authFetch('/api/hospitals')
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => Array.isArray(rows) && setHospitalList(rows.filter((h) => !h.archived_at).map((h) => h.name)))
      .catch(() => {});
  }, []);

  const setArchived = async (result, archived) => {
    const res = await authFetch('/api/abstracts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: result.id, archived }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    setAdded(archived ? `${result.item} (${result.hospital}) was archived. Restore it from Archived any time.` : `${result.item} (${result.hospital}) was restored.`);
    await load();
  };

  const restore = async (result) => {
    setRestoring(result.id);
    setError('');
    try {
      await setArchived(result, false);
    } catch (e) {
      setError(`Could not restore ${result.item}: ${e.message}`);
    }
    setRestoring(null);
  };

  const all = results || [];
  const current = all.filter((r) => !r.archived_at);
  const archived = all.filter((r) => r.archived_at);
  const bid = current.filter((r) => r.our_price != null);
  const notBid = current.filter((r) => r.our_price == null);
  const shown = view === 'archived' ? archived : view === 'bid' ? bid : view === 'nobid' ? notBid : current;
  const query = search.trim().toLowerCase();
  const rows = shown.filter((r) => !query || `${r.hospital} ${r.item} ${r.winner || ''} ${r.note || ''}`.toLowerCase().includes(query));
  const gaps = bid.filter((r) => resultOf(r) === 'lost').map(gapOf).filter((g) => g != null);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const hospitals = new Set(current.map((r) => r.agency_key)).size;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const actionButton = 'whitespace-nowrap rounded-lg px-3 py-1 text-xs font-semibold transition-all disabled:opacity-60';
  const columns = [
    { label: 'Hospital', render: (r) => <span className="text-xs text-black/62">{r.hospital}</span> },
    {
      label: 'Item',
      title: true,
      render: (r) => (
        <span>
          {r.item}
          {r.note && <span className="mt-0.5 block text-xs font-normal text-black/62">{r.note}</span>}
        </span>
      ),
    },
    { label: 'Quantity', width: '6.5rem', nowrap: true, render: (r) => <span className="tabular-nums">{qty(r.quantity)}</span> },
    { label: 'ABC Price', width: '7.5rem', nowrap: true, render: (r) => <span className="tabular-nums">{formatPeso(r.abc_price) || '—'}</span> },
    {
      label: 'Our Price',
      width: '7.5rem',
      nowrap: true,
      render: (r) => (r.our_price == null ? <span className="rounded-full bg-[#E2E8F0]/70 px-2 py-0.5 text-xs text-black/62">Did not bid</span> : <span className="tabular-nums">{formatPeso(r.our_price)}</span>),
    },
    { label: 'Winner', render: (r) => r.winner || <span className="text-black/46">—</span> },
    { label: 'Winning Price', width: '8rem', nowrap: true, render: (r) => <span className="font-medium tabular-nums">{formatPeso(r.winning_price) || '—'}</span> },
    view === 'archived'
      ? {
          label: 'Archived',
          width: '8rem',
          render: (r) => (
            <span className="text-xs text-black/62">
              {new Date(r.archived_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
              {r.archived_by && <span className="block text-black/46">by {r.archived_by.split('@')[0]}</span>}
            </span>
          ),
        }
      : {
          label: 'Our Gap',
          width: '8rem',
          nowrap: true,
          render: (r) => {
            if (resultOf(r) === 'won') return <span className="rounded-full bg-[#61A644]/10 px-2 py-0.5 text-xs text-[#3F6F2C]">We won</span>;
            const g = gapOf(r);
            if (g == null) return <span className="text-black/46">—</span>;
            return (
              <span className={`text-xs font-medium tabular-nums ${g > 0 ? 'text-[#B3312C]' : 'text-[#3F6F2C]'}`} title="Our price compared with the winning price">
                {g > 0 ? '+' : ''}
                {formatPeso(r.our_price - r.winning_price)}
                <span className="block font-normal">
                  {g > 0 ? '+' : ''}
                  {g.toFixed(1)}% {g > 0 ? 'above' : 'below'}
                </span>
              </span>
            );
          },
        },
    {
      label: 'Actions',
      width: '7rem',
      nowrap: true,
      render: (r) =>
        r.archived_at ? (
          <button type="button" onClick={() => restore(r)} disabled={restoring === r.id} className={`${actionButton} text-[#3F6F2C] hover:bg-[#61A644]/10`}>
            {restoring === r.id ? 'Restoring…' : '↺ Restore'}
          </button>
        ) : (
          <button type="button" onClick={() => setArchiving(r)} className={`${actionButton} text-black/62 hover:bg-[#1EA0DA]/8 hover:text-[#12769F]`}>
            <ArchiveIcon className="mr-1 inline h-3.5 w-3.5 -translate-y-px" />
            Archive
          </button>
        ),
    },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <PageHeader
          title="Abstract of Bids"
          subtitle="Who won each item the hospitals bid out, at what price, next to our price (PhilGEPS and PS-PhilGEPS)"
          actions={
            <>
              <ImportExcel
                sheet={ABSTRACT_SHEET}
                columns="HOSPITAL, ITEM, ABC PRICE, QUANTITY, 2MG PRICE, WON, PRICE"
                read={(wb) => {
                  // A hospital's own abstract (every bidder's price per item): only the winner, the winning price and
                  // our price are kept, for the hospital and year chosen in the window
                  const own = readHospitalAbstract(wb);
                  if (own) {
                    return {
                      sheet: own.sheet,
                      rows: own.results,
                      format: `Read as a hospital's own Abstract of Bids: for each item only the winner (lowest bid), its price and our price (2MG) are kept; ${own.skippedNoBids} item${own.skippedNoBids === 1 ? '' : 's'} nobody bid on ${own.skippedNoBids === 1 ? 'is' : 'are'} left out.`,
                      ask: {
                        fields: [
                          { key: 'hospital', label: 'Hospital', placeholder: 'Choose or type the hospital', options: [...new Set([...hospitalList, ...all.map((r) => r.hospital)])].sort() },
                          { key: 'year', label: 'Year', placeholder: '2026', defaultValue: String(new Date().getFullYear()), number: true },
                        ],
                        complete: completeHospitalAbstract,
                      },
                    };
                  }
                  const { sheet, results: rows } = readAbstractSheet(wb);
                  return { sheet, rows };
                }}
                describe={(rows) => describeAbstractImport(rows, all)}
                endpoint="/api/abstracts"
                field="results"
                disabled={!results}
                onDone={(message) => {
                  setAdded(message);
                  load();
                }}
              />
              <button
                onClick={() => {
                  setAdding(true);
                  setAdded('');
                }}
                className={blueAction}
              >
                + Add Result
              </button>
            </>
          }
        />
        <KpiRow
          items={[
            { label: 'Results', value: results ? current.length : '—', note: `items · ${hospitals} hospital${hospitals === 1 ? '' : 's'}` },
            { label: 'We bid', value: results ? bid.length : '—', tone: 'blue', note: `${notBid.length} not bid` },
            { label: 'We won', value: results ? current.filter((r) => resultOf(r) === 'won').length : '—', tone: 'green', note: 'winner is 2MG' },
            { label: 'Avg. above winner', value: avgGap == null ? '—' : `${avgGap > 0 ? '+' : ''}${avgGap.toFixed(1)}%`, tone: 'docs', note: 'our price vs the winning price' },
          ]}
        />

        {error && <p className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">{error}</p>}
        {added && <p className="rounded-[14px] border border-[#61A644]/30 bg-[#61A644]/8 px-4 py-3 text-sm text-[#2F5321]">{added}</p>}
        {adding && (
          <AddResult
            results={all}
            onCancel={() => setAdding(false)}
            onAdded={(result) => {
              setAdding(false);
              setAdded(`${result.item} (${result.hospital}) was added to the abstract.`);
              setView('all');
              load();
            }}
          />
        )}
        {archiving && (
          <ArchiveResult
            result={archiving}
            onCancel={() => setArchiving(null)}
            onArchive={async () => {
              await setArchived(archiving, true);
              setArchiving(null);
            }}
          />
        )}

        <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 sm:flex-row sm:items-center">
          <SegmentedTabs
            label="Show"
            value={view}
            onChange={(next) => {
              setView(next);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All', count: current.length },
              { value: 'bid', label: 'We bid', count: bid.length },
              { value: 'nobid', label: 'Did not bid', count: notBid.length },
              { value: 'archived', label: 'Archived', count: archived.length },
            ]}
          />
          <input
            type="text"
            placeholder="Search by hospital, item or winner..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
          />
        </div>

        {!results ? (
          <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the abstract...'}</p>
        ) : rows.length ? (
          <>
            <ResponsiveTable columns={columns} rows={pageRows} rowKey={(r) => r.id} />
            {rows.length > PAGE_SIZES[0] && (
              <Pagination
                page={currentPage}
                pageSize={pageSize}
                total={rows.length}
                onPageChange={goToPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            )}
          </>
        ) : (
          <p className="py-12 text-center text-black/46">{query ? 'No result matches the search.' : view === 'archived' ? 'Nothing is archived.' : 'No results here yet.'}</p>
        )}
      </div>
    </div>
  );
}

// What the Import Excel window says about the sheet: new results, updated ones, per hospital
function describeAbstractImport(rows, current) {
  const have = new Set(current.map((r) => `${r.year}|${r.agency_key}|${r.item}`));
  const fresh = rows.filter((r) => !have.has(`${r.year}|${r.agency_key}|${r.item}`));
  const perHospital = Object.entries(rows.reduce((m, r) => ({ ...m, [r.hospital]: (m[r.hospital] || 0) + 1 }), {}));
  return {
    // A hospital's own abstract can lack our column on a sheet (its rows carry a note): our price unknown, not "not bid"
    headline: `${rows.length} results from ${perHospital.length} hospital${perHospital.length === 1 ? '' : 's'} (${rows[0].year}): ${rows.filter((r) => r.our_price != null).length} we bid, ${rows.filter((r) => r.our_price == null && !r.note).length} not bid${
      rows.some((r) => r.our_price == null && r.note) ? `, ${rows.filter((r) => r.our_price == null && r.note).length} with our price not on the hospital's sheet` : ''
    }`,
    lines: [
      `New (${fresh.length}), already in the abstract and updated (${rows.length - fresh.length}).`,
      perHospital
        .slice(0, 8)
        .map(([h, n]) => `${h} (${n})`)
        .join(' · ') + (perHospital.length > 8 ? ` · and ${perHospital.length - 8} more` : ''),
      'Kept as they are: archived results and results not on the sheet.',
    ],
  };
}

function ArchiveIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </svg>
  );
}

const cancelButton = 'rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60';
const saveButton = 'rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60';

function ArchiveResult({ result, onCancel, onArchive }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const archive = async () => {
    setSaving(true);
    setError('');
    try {
      await onArchive();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Archive result?"
      subtitle="It stays in the abstract under Archived and can be restored any time."
      busy={saving}
      onClose={onCancel}
      icon={<ArchiveIcon className="h-5 w-5" />}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="button" onClick={archive} disabled={saving} className={saveButton}>
            {saving ? 'Archiving…' : 'Archive'}
          </button>
        </>
      }
    >
      <section className="rounded-[14px] border border-[#E2E8F0] p-4">
        <p className="text-base font-semibold text-black">{result.item}</p>
        <p className="mt-1 text-xs text-black/62">
          {result.hospital}
          {result.winner && ` · won by ${result.winner} at ${formatPeso(result.winning_price) || '—'}`}
        </p>
      </section>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}

// The Add Result window: Hospital and Item are required; prices in pesos per unit.
function AddResult({ results, onCancel, onAdded }) {
  const [form, setForm] = useState({ hospital: '', item: '', quantity: '', abc_price: '', our_price: '', winner: '', winning_price: '', note: '' });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const required = ['hospital', 'item'];
  const fields = [
    ['hospital', 'Hospital', 'e.g. East Avenue Medical Center', 'list'],
    ['item', 'Item', 'e.g. Capecitabine 500 mg tablet'],
    ['quantity', 'Quantity', 'e.g. 100000', 'number'],
    ['abc_price', 'ABC Price (₱ per unit)', 'e.g. 49.50', 'number'],
    ['our_price', 'Our Price (₱ per unit)', 'Empty if we did not bid', 'number'],
    ['winner', 'Winner', 'e.g. Endure'],
    ['winning_price', 'Winning Price (₱ per unit)', 'e.g. 11.34', 'number'],
    ['note', 'Note', 'Optional'],
  ];
  const hospitalNames = [...new Set(results.map((r) => r.hospital))].sort();
  const input = (invalid) =>
    `mt-1.5 w-full rounded-full border bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:outline-none focus:ring-2 ${
      invalid ? 'border-[#B3312C] focus:ring-[#B3312C]/20' : 'border-[#CBD5E1] focus:border-[#1EA0DA] focus:ring-[#1EA0DA]/25'
    }`;

  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (required.some((k) => !form[k].trim())) return;
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/abstracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onAdded(data.result);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Result"
      subtitle="Add an item from a hospital's abstract of bids: who won and at what price."
      busy={saving}
      onClose={onCancel}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM17 6h3a3 3 0 0 1-3 3M7 6H4a3 3 0 0 0 3 3" />
        </svg>
      }
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="add-result" disabled={saving} className={saveButton}>
            {saving ? 'Adding…' : 'Add Result'}
          </button>
        </>
      }
    >
      <form id="add-result" onSubmit={save} noValidate className="space-y-3.5">
        <datalist id="abstract-hospitals">
          {hospitalNames.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        {fields.map(([key, label, placeholder, kind]) => {
          const invalid = tried && required.includes(key) && !form[key].trim();
          return (
            <label key={key} className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-black/62">
                {label} {required.includes(key) && <span className="text-[#B3312C]">*</span>}
              </span>
              <input
                value={form[key]}
                placeholder={placeholder}
                maxLength={key === 'note' ? 500 : 200}
                inputMode={kind === 'number' ? 'decimal' : undefined}
                list={kind === 'list' ? 'abstract-hospitals' : undefined}
                aria-invalid={invalid}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={input(invalid)}
              />
              {invalid && <span className="mt-1 block px-4 text-xs text-[#B3312C]">{label} is required.</span>}
            </label>
          );
        })}
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}
