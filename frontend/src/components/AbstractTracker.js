'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatPeso } from '@/lib/format';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';
import ImportExcel from '@/components/ImportExcel';
import Pagination, { PAGE_SIZES } from '@/components/Pagination';
import PageHeader, { KpiRow, blueAction, greenAction, pesoTotal } from '@/components/PageHeader';
import { CustomSelect } from '@/components/FilterControls';
import { readHospitalBidRows } from '@/lib/sheetImport.mjs';
import { downloadTrackerWorkbook, groupTracker, isOurBidder, moleculeStats, planHospitalMerge, readTrackerWorkbook, sumAbc, totalAbc } from '@/lib/abstractTracker.mjs';

// Abstract of Bids → Overall Abstract / All Bids: the team's Overall Abstract workbook kept in the system
// (/api/abstracts/tracker, lib/abstractTracker.mjs). Import Excel takes the whole workbook (replaces that year) or a
// hospital's own Abstract of Bids (adds its bidders and our molecules' items); Export Excel writes the same workbook
// back. Qty / ABC Price / Total ABC Price are often blank: hospitals' files do not give them.

const qty = (n) => (n == null ? '—' : Number(n).toLocaleString('en-PH'));
const dash = <span className="text-black/46">—</span>;
const actionButton = 'whitespace-nowrap rounded-lg px-3 py-1 text-xs font-semibold text-black/62 transition-all hover:bg-[#1EA0DA]/8 hover:text-[#12769F] disabled:opacity-60';

export default function AbstractTracker({ section, tabs, hospitalList }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [editing, setEditing] = useState(null); // an item, or { add: true }
  const [bidsOf, setBidsOf] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [exporting, setExporting] = useState(false);
  const listTop = useRef(null);

  const load = useCallback(async (year) => {
    try {
      const res = await authFetch(`/api/abstracts/tracker${year ? `?year=${year}` : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      setData(body);
      setError('');
    } catch (e) {
      setError(`Could not load the tracker: ${e.message}`);
    }
  }, []);
  useEffect(() => {
    Promise.resolve().then(() => load());
  }, [load]);

  const tracker = data?.tracker;
  const items = data?.items || [];
  const molecules = data?.molecules || [];
  const bidders = tracker?.bidders || [];
  const year = tracker?.year;
  const hospitals = groupTracker(items);
  const query = search.trim().toLowerCase();

  const goToPage = (next) => {
    setPage(next);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const changed = (message) => {
    setNotice(message);
    load(year);
  };

  // ----- Import Excel: the whole workbook, or one hospital's Abstract of Bids
  const read = (wb, fileName) => {
    const whole = readTrackerWorkbook(wb);
    if (whole?.items.length) {
      const fromName = Number(String(fileName || '').match(/20\d\d/)?.[0]);
      return {
        sheet: whole.sheets.join(', '),
        rows: whole.items,
        format: 'Read as the Overall Abstract workbook (sheets "Overall Abstract" and "All Bids"). Import replaces that year\'s tracker in the system.',
        ask: {
          fields: [{ key: 'year', label: 'Year', placeholder: '2026', defaultValue: String(fromName || year || new Date().getFullYear()), number: true }],
          complete: (rows, values) => rows.map((r) => ({ ...r, year: Number(values.year) })),
        },
        body: (rows) => ({ items: rows, molecules: whole.molecules, meta: { ...whole.meta, file_name: fileName } }),
      };
    }
    const own = readHospitalBidRows(wb);
    if (own) {
      return {
        sheet: own.sheet,
        rows: own.rows,
        format: `Read as a hospital's own Abstract of Bids (every bidder's price per item). Its items that are our molecules in All Bids are added to the ${year || ''} tracker; Qty and ABC Price stay blank (not in the file). Importing the same hospital's file again replaces what it added.`,
        ask: {
          fields: [{ key: 'hospital', label: 'Hospital', placeholder: 'Choose or type the hospital', options: [...new Set([...hospitalList, ...hospitals.map((h) => h.hospital)])].sort() }],
          complete: (rows, values) => rows.map((r) => ({ ...r, hospital: values.hospital })),
        },
        body: (rows, values) => {
          const plan = planHospitalMerge({ items, molecules, meta: tracker }, rows, values.hospital);
          return { mode: 'hospital', year: year || new Date().getFullYear(), hospital: plan.hospital, bidders: plan.bidders, molecules: plan.molecules, items: plan.items, lowered: plan.lowered };
        },
      };
    }
    throw new Error('This file is neither the Overall Abstract workbook nor a hospital\'s Abstract of Bids (a sheet with "Item No.", "Item Description" and numbered bidders "1. NAME", "2. NAME", …).');
  };

  const describe = (rows) => {
    if (rows[0]?.bids) {
      const plan = planHospitalMerge({ items, molecules, meta: tracker }, rows, rows[0].hospital);
      return {
        headline: `${plan.matched} of ${rows.length} items are our molecules (${plan.withBids} with bids) → a new group for ${plan.hospital} in Overall Abstract`,
        lines: [
          `All Bids: prices on ${plan.molecules.length} molecule${plan.molecules.length === 1 ? '' : 's'}; ${plan.addedColumns.length} new bidder column${plan.addedColumns.length === 1 ? '' : 's'}${plan.addedColumns.length ? ` (${plan.addedColumns.slice(0, 3).join(', ')}${plan.addedColumns.length > 3 ? ', …' : ''})` : ''}.`,
          plan.replacedItems ? `Replaces the ${plan.replacedItems} item${plan.replacedItems === 1 ? '' : 's'} added earlier from this hospital's file.` : null,
          plan.lowered.length ? `Lowest Bid lowered on ${plan.lowered.length} row${plan.lowered.length === 1 ? '' : 's'} of other hospitals (a lower price in this file).` : null,
          `Left out: ${plan.notOurs} item${plan.notOurs === 1 ? '' : 's'} not among our molecules in All Bids.`,
          ...plan.ambiguous.map((a) => `Not added, fits several of our molecules: ${a.row.description} (${a.options.join(' / ')}). Add it with + Add Item.`),
          !molecules.length ? 'The tracker has no molecules yet: import the Overall Abstract workbook first.' : null,
        ].filter(Boolean),
      };
    }
    const n = new Set(rows.map((r) => r.agency_key)).size;
    return {
      headline: `${rows.length} items from ${n} hospitals for ${rows[0].year}`,
      lines: [
        tracker && tracker.year === rows[0].year ? `Replaces the ${tracker.year} tracker now in the system (${items.length} items, ${molecules.length} molecules).` : `A new tracker for ${rows[0].year}.`,
        `${rows.filter((r) => r.our_price != null).length} with a 2mg Price; ${rows.filter((r) => r.lowest_bid != null).length} with a Lowest Bid.`,
      ],
    };
  };

  const exportExcel = async () => {
    setExporting(true);
    setError('');
    try {
      await downloadTrackerWorkbook({ items, molecules, meta: tracker });
    } catch (e) {
      setError(`Could not build the Excel file: ${e.message}`);
    }
    setExporting(false);
  };

  // ----- What is shown
  const shownHospitals = hospitals
    .map((h) => {
      if (!query || h.hospital.toLowerCase().includes(query)) return h;
      const blocks = h.blocks.map((b) => ({ ...b, items: b.items.filter((it) => `${it.item_no} ${it.description} ${it.lowest_bidder || ''}`.toLowerCase().includes(query)) })).filter((b) => b.items.length);
      return blocks.length ? { ...h, blocks } : null;
    })
    .filter(Boolean);
  const shownMolecules = molecules.filter((m) => !query || `${m.item_no} ${m.molecule} ${Object.keys(m.prices || {}).join(' ')}`.toLowerCase().includes(query));
  const list = section === 'overall' ? shownHospitals : shownMolecules;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageList = list.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const kpis =
    section === 'overall'
      ? [
          { label: 'Hospitals', value: data ? hospitals.length : '—', note: `${hospitals.reduce((s, h) => s + h.blocks.length, 0)} groups` },
          { label: 'Items', value: data ? items.length : '—', tone: 'blue', note: `${items.filter((it) => it.lowest_bid != null).length} with a Lowest Bid` },
          { label: '2mg Price', value: data ? items.filter((it) => it.our_price != null).length : '—', tone: 'green', note: 'items with our price' },
          { label: 'Total ABC', value: data ? pesoTotal(sumAbc(items)) : '—', tone: 'docs', note: 'where Qty and ABC are given' },
        ]
      : [
          { label: 'Molecules', value: data ? molecules.length : '—', note: 'rows in All Bids' },
          { label: 'Bidder columns', value: data ? bidders.length : '—', tone: 'blue', note: `${bidders.filter(isOurBidder).length} are 2MG` },
          { label: 'With bids', value: data ? molecules.filter((m) => moleculeStats(m, bidders).count).length : '—', tone: 'green', note: 'at least one price' },
          { label: '2mg Price', value: data ? molecules.filter((m) => m.our_price != null).length : '—', tone: 'docs', note: 'molecules with our price' },
        ];

  return (
    <>
      <PageHeader
        title="Abstract of Bids"
        subtitle={
          section === 'overall'
            ? `Overall Abstract${year ? ` ${year}` : ''}: every hospital's items with the lowest bid found across all hospitals and bidders`
            : `All Bids${year ? ` ${year}` : ''}: every bidder's unit price per molecule, at each hospital`
        }
        actions={
          <>
            <ImportExcel sheet="Overall Abstract" columns="" read={read} describe={describe} endpoint="/api/abstracts/tracker" field="items" disabled={!data} onDone={changed} />
            <button type="button" onClick={exportExcel} disabled={!items.length || exporting} className={greenAction}>
              {exporting ? 'Building…' : '⇩ Export Excel'}
            </button>
            {section === 'overall' && (
              <button type="button" onClick={() => setEditing({ add: true })} disabled={!tracker} className={blueAction}>
                + Add Item
              </button>
            )}
          </>
        }
      />
      <KpiRow items={kpis} />
      {tabs}
      {error && <p className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">{error}</p>}
      {notice && <p className="rounded-[14px] border border-[#61A644]/30 bg-[#61A644]/8 px-4 py-3 text-sm text-[#2F5321]">{notice}</p>}

      <div ref={listTop} className="flex scroll-mt-4 flex-col gap-3 sm:flex-row sm:items-center">
        {data?.years?.length > 1 && <CustomSelect label="Year" value={year} onChange={(y) => load(y)} options={data.years.map((y) => ({ value: y, label: String(y) }))} />}
        <input
          type="text"
          placeholder={section === 'overall' ? 'Search by hospital, item or lowest bidder...' : 'Search by molecule or bidder...'}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-full flex-1 bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
        />
      </div>

      {!data ? (
        <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the tracker...'}</p>
      ) : !tracker ? (
        <p className="py-12 text-center text-black/46">No tracker yet. Use ⇪ Import Excel with the Overall Abstract workbook (e.g. Overall_Abstract_2026_v2.xlsx).</p>
      ) : !list.length ? (
        <p className="py-12 text-center text-black/46">{query ? 'Nothing matches the search.' : 'Nothing here yet.'}</p>
      ) : (
        <>
          {section === 'overall' ? (
            <div className="space-y-5">
              {pageList.map((h) => (
                <HospitalCard key={h.agency_key} hospital={h} red={(tracker.highlighted || []).includes(h.agency_key)} onEdit={setEditing} />
              ))}
            </div>
          ) : (
            <ResponsiveTable
              rowKey={(m) => m.id}
              rows={pageList}
              columns={[
                { label: 'Item No.', width: '5rem', nowrap: true, render: (m) => <span className="tabular-nums text-black/62">{m.item_no}</span> },
                { label: 'Molecule', title: true, render: (m) => m.molecule },
                { label: 'No. of Bids', width: '6rem', nowrap: true, render: (m) => <span className="tabular-nums">{moleculeStats(m, bidders).count}</span> },
                { label: 'Lowest Bid', width: '7.5rem', nowrap: true, render: (m) => <LowestBid value={moleculeStats(m, bidders).lowest} /> },
                { label: 'Lowest Bidder', render: (m) => <Bidder name={moleculeStats(m, bidders).bidder} /> },
                { label: '2mg Price', width: '7.5rem', nowrap: true, render: (m) => (m.our_price == null ? dash : <span className="tabular-nums">{formatPeso(m.our_price)}</span>) },
                {
                  label: 'Actions',
                  width: '10rem',
                  nowrap: true,
                  render: (m) => (
                    <span className="flex gap-1">
                      <button type="button" className={actionButton} onClick={() => setBidsOf(m)}>
                        View bids
                      </button>
                      <button type="button" className={actionButton} onClick={() => setPricing(m)}>
                        Edit
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          )}
          {list.length > PAGE_SIZES[0] && (
            <Pagination
              page={currentPage}
              pageSize={pageSize}
              total={list.length}
              onPageChange={goToPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}
          {section === 'overall' && tracker.overall_notes?.length > 0 && <Notes notes={tracker.overall_notes} />}
          {section === 'bids' && tracker.bids_notes?.length > 0 && <Notes notes={tracker.bids_notes} />}
        </>
      )}

      {editing && (
        <EditItem
          item={editing.add ? null : editing}
          year={year}
          hospitals={hospitals}
          hospitalList={hospitalList}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            changed(message);
          }}
        />
      )}
      {bidsOf && <ViewBids molecule={bidsOf} bidders={bidders} onClose={() => setBidsOf(null)} />}
      {pricing && (
        <EditPrice
          molecule={pricing}
          onCancel={() => setPricing(null)}
          onSaved={(message) => {
            setPricing(null);
            changed(message);
          }}
        />
      )}
    </>
  );
}

function LowestBid({ value, abc }) {
  if (value == null) return dash;
  const over = abc != null && value > abc;
  return (
    <span className={`rounded-md bg-[#9BC2E6]/30 px-1.5 py-0.5 font-semibold tabular-nums ${over ? 'text-[#B3312C]' : 'text-black'}`} title={over ? 'Above this row\'s ABC price' : undefined}>
      {formatPeso(value)}
    </span>
  );
}
function Bidder({ name }) {
  if (!name) return <span className="text-xs italic text-black/46">No bid found</span>;
  return <span className={`text-xs ${isOurBidder(name) ? 'font-medium text-[#3F6F2C]' : 'text-black/80'}`}>{name}</span>;
}
function Notes({ notes }) {
  return (
    <section className="rounded-[14px] border border-[#E2E8F0] bg-[#1EA0DA]/[0.02] p-4 text-xs text-black/62">
      <h3 className="mb-1.5 font-semibold uppercase tracking-wider">Notes</h3>
      <ul className="list-disc space-y-1 pl-4 italic">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </section>
  );
}

// One hospital: its groups (each with a subtotal of Total ABC Price) and the final total
function HospitalCard({ hospital, red, onEdit }) {
  const total = hospital.blocks.reduce((s, b) => s + sumAbc(b.items), 0);
  const count = hospital.blocks.reduce((s, b) => s + b.items.length, 0);
  return (
    <section className="rounded-[18px] border border-[#E2E8F0] bg-white p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={`text-sm font-semibold ${red ? 'text-[#B3312C]' : 'text-black'}`}>{hospital.hospital}</h2>
        <p className="text-xs text-black/62">
          {count} item{count === 1 ? '' : 's'} · {hospital.blocks.length} group{hospital.blocks.length === 1 ? '' : 's'} · Final total{' '}
          <b className="tabular-nums text-[#B3312C]">{formatPeso(total)}</b>
        </p>
      </header>
      <div className="space-y-4">
        {hospital.blocks.map((b) => (
          <div key={b.block}>
            <ResponsiveTable
              size="xs"
              rowKey={(it) => it.id}
              rows={b.items}
              columns={[
                { label: 'Item No.', width: '4.5rem', nowrap: true, render: (it) => <span className="tabular-nums text-black/62">{it.item_no}</span> },
                { label: 'Description', title: true, render: (it) => it.description },
                { label: 'Qty', width: '5.5rem', nowrap: true, optional: 2, render: (it) => <span className="tabular-nums">{qty(it.quantity)}</span> },
                { label: 'ABC Price', width: '6.5rem', nowrap: true, optional: 3, render: (it) => (it.abc_price == null ? dash : <span className="tabular-nums">{formatPeso(it.abc_price)}</span>) },
                { label: 'Total ABC', width: '7.5rem', nowrap: true, optional: 1, render: (it) => (totalAbc(it) == null ? dash : <span className="tabular-nums">{formatPeso(totalAbc(it))}</span>) },
                { label: 'Lowest Bid', width: '7rem', nowrap: true, render: (it) => <LowestBid value={it.lowest_bid} abc={it.abc_price} /> },
                { label: 'Lowest Bidder', render: (it) => <Bidder name={it.lowest_bidder} /> },
                { label: '2mg Price', width: '6.5rem', nowrap: true, render: (it) => (it.our_price == null ? dash : <span className="tabular-nums">{formatPeso(it.our_price)}</span>) },
                {
                  label: 'Actions',
                  width: '4.5rem',
                  nowrap: true,
                  render: (it) => (
                    <button type="button" className={actionButton} onClick={() => onEdit(it)}>
                      Edit
                    </button>
                  ),
                },
              ]}
            />
            <p className="mt-1.5 text-right text-xs text-black/62">
              Subtotal <b className="tabular-nums text-[#B3312C]">{formatPeso(sumAbc(b.items))}</b>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

const cancelButton = 'rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60';
const saveButton = 'rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60';
const removeButton = 'mr-auto rounded-lg border border-[#B3312C]/30 px-4 py-2 text-xs font-medium text-[#B3312C] transition hover:bg-[#B3312C]/6 disabled:opacity-60';
const inputClass = (invalid) =>
  `mt-1.5 w-full rounded-full border bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:outline-none focus:ring-2 ${
    invalid ? 'border-[#B3312C] focus:ring-[#B3312C]/20' : 'border-[#CBD5E1] focus:border-[#1EA0DA] focus:ring-[#1EA0DA]/25'
  }`;
const asText = (v) => (v == null ? '' : String(v));

// Add Item / Edit (Overall Abstract): all columns; Remove from Edit
function EditItem({ item, year, hospitals, hospitalList, onCancel, onSaved }) {
  const adding = !item;
  const [form, setForm] = useState({
    hospital: item?.hospital || '',
    block: 'new',
    item_no: item ? asText(item.item_no) : '',
    description: asText(item?.description),
    quantity: asText(item?.quantity),
    abc_price: asText(item?.abc_price),
    lowest_bid: asText(item?.lowest_bid),
    lowest_bidder: asText(item?.lowest_bidder),
    our_price: asText(item?.our_price),
  });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const groups = hospitals.find((h) => h.hospital === form.hospital.trim().toUpperCase())?.blocks || [];
  const fields = [
    ['item_no', 'Item No.', 'e.g. 13 (or -)'],
    ['description', 'Description', 'e.g. Capecitabine 500 mg tablet'],
    ['quantity', 'Qty', 'Optional', 'number'],
    ['abc_price', 'ABC Price (₱ per unit)', 'Optional', 'number'],
    ['lowest_bid', 'Lowest Bid (₱ per unit)', 'Empty: no bid found', 'number'],
    ['lowest_bidder', 'Lowest Bidder', 'e.g. ZUELLIG PHARMA - Davao Regional MC'],
    ['our_price', '2mg Price (₱ per unit)', 'Our price', 'number'],
  ];
  const missing = (adding && !form.hospital.trim()) || !form.description.trim();

  const send = async (method, body) => {
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/abstracts/tracker', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      return data;
    } catch (e) {
      setError(e.message);
      setSaving(false);
      return null;
    }
  };
  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (missing) return;
    const { hospital, block, ...values } = form;
    const done = adding ? await send('POST', { year, hospital, block: groups.length ? block : 'new', ...values }) : await send('PATCH', { id: item.id, ...values });
    if (done) onSaved(adding ? `${values.description} was added to ${hospital.trim().toUpperCase()}.` : `${values.description} (${item.hospital}) was saved.`);
  };
  const remove = async () => {
    const done = await send('DELETE', { id: item.id });
    if (done) onSaved(`${item.description} was removed from ${item.hospital}.`);
  };

  return (
    <Modal
      title={adding ? 'Add Item' : 'Edit Item'}
      subtitle={adding ? 'Add a row to a hospital in the Overall Abstract.' : item.hospital}
      busy={saving}
      onClose={onCancel}
      footer={
        <>
          {!adding &&
            (confirmRemove ? (
              <button type="button" onClick={remove} disabled={saving} className={removeButton}>
                Yes, remove it
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} disabled={saving} className={removeButton}>
                Remove
              </button>
            ))}
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="tracker-item" disabled={saving} className={saveButton}>
            {saving ? 'Saving…' : adding ? 'Add Item' : 'Save'}
          </button>
        </>
      }
    >
      <form id="tracker-item" onSubmit={save} noValidate className="space-y-3.5">
        {adding && (
          <>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-black/62">
                Hospital <span className="text-[#B3312C]">*</span>
              </span>
              <input
                value={form.hospital}
                placeholder="Choose or type the hospital"
                list="tracker-hospitals"
                maxLength={200}
                onChange={(e) => setForm({ ...form, hospital: e.target.value, block: 'new' })}
                className={inputClass(tried && !form.hospital.trim())}
              />
              <datalist id="tracker-hospitals">
                {[...new Set([...hospitals.map((h) => h.hospital), ...hospitalList])].sort().map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            </label>
            {groups.length > 0 && (
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-black/62">Group</span>
                <div className="mt-1.5">
                  <CustomSelect
                    label="Group"
                    showLabel={false}
                    value={form.block}
                    onChange={(block) => setForm({ ...form, block })}
                    options={[...groups.map((g) => ({ value: g.block, label: `Group ${g.block} (${g.items.length} items, from ${g.items[0].description})` })), { value: 'new', label: 'A new group' }]}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {fields.map(([key, label, placeholder, kind]) => {
          const invalid = tried && key === 'description' && !form.description.trim();
          return (
            <label key={key} className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-black/62">
                {label} {key === 'description' && <span className="text-[#B3312C]">*</span>}
              </span>
              <input
                value={form[key]}
                placeholder={placeholder}
                maxLength={key === 'description' || key === 'lowest_bidder' ? 500 : 40}
                inputMode={kind === 'number' ? 'decimal' : undefined}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={inputClass(invalid)}
              />
              {invalid && <span className="mt-1 block px-4 text-xs text-[#B3312C]">Description is required.</span>}
            </label>
          );
        })}
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}

// All Bids → View bids: every bidder's price for one molecule, lowest first
function ViewBids({ molecule, bidders, onClose }) {
  const priced = bidders.filter((b) => typeof molecule.prices?.[b] === 'number').sort((a, b) => molecule.prices[a] - molecule.prices[b]);
  return (
    <Modal
      title={molecule.molecule}
      subtitle={`${priced.length} bid${priced.length === 1 ? '' : 's'} of ${bidders.length} bidder columns, lowest first`}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className={cancelButton}>
          Close
        </button>
      }
    >
      {priced.length ? (
        <ul className="divide-y divide-[#E2E8F0] rounded-[14px] border border-[#E2E8F0]">
          {priced.map((b, i) => (
            <li key={b} className={`flex items-baseline justify-between gap-3 px-4 py-2 text-sm ${isOurBidder(b) ? 'bg-[#FCE4D6]/50' : ''}`}>
              <span className={i === 0 ? 'font-semibold' : ''}>{b}</span>
              <span className={`tabular-nums ${i === 0 ? 'font-semibold' : ''}`}>{formatPeso(molecule.prices[b])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-black/62">No bid found for this molecule.</p>
      )}
      {molecule.our_price != null && <p className="text-xs text-black/62">2mg Price: {formatPeso(molecule.our_price)}</p>}
    </Modal>
  );
}

// All Bids → Edit: the 2mg Price of a molecule
function EditPrice({ molecule, onCancel, onSaved }) {
  const [value, setValue] = useState(asText(molecule.our_price));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/abstracts/tracker', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ molecule_id: molecule.id, our_price: value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onSaved(`2mg Price of ${molecule.molecule} was saved.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  return (
    <Modal
      title="2mg Price"
      subtitle={molecule.molecule}
      busy={saving}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className={cancelButton}>
            Cancel
          </button>
          <button type="submit" form="tracker-price" disabled={saving} className={saveButton}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="tracker-price" onSubmit={save} noValidate>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wider text-black/62">2mg Price (₱ per unit)</span>
          <input value={value} placeholder="Empty: none yet" inputMode="decimal" maxLength={40} onChange={(e) => setValue(e.target.value)} className={inputClass(false)} />
        </label>
      </form>
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}
