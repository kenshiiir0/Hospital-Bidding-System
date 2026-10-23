'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { matchName } from '@/lib/products.mjs';
import ResponsiveTable from '@/components/ResponsiveTable';
import Modal from '@/components/Modal';

// Our product list (table products): the B2B price list and the team's PRODUCT LIST, plus molecules added here. The
// only list tenders on PhilGEPS and PS-PhilGEPS are screened against: a tender counts when it asks for the molecule
// ("Matched as") in one of these dosages (lib/products.mjs).
const SOURCES = { 'b2b-pricelist': 'B2B price list', 'product-list': 'Product list' };

export default function ProductsPage() {
  const [products, setProducts] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [added, setAdded] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/products?rows=1');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setProducts(data);
      setError('');
    } catch (e) {
      setError(`Could not load the product list: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(load);
  }, [load]);

  const query = search.trim().toLowerCase();
  const rows = (products || []).filter((p) => !query || `${p.generic_name} ${p.brand_name} ${p.dosage} ${p.classification || ''}`.toLowerCase().includes(query));
  const molecules = new Set((products || []).map((p) => matchName(p.generic_name))).size;

  const columns = [
    { label: 'Generic Name', title: true, render: (p) => p.generic_name },
    { label: 'Brand Name', render: (p) => p.brand_name },
    { label: 'Dosage', width: '10rem', render: (p) => p.dosage },
    { label: 'Dosage Form', render: (p) => p.dosage_form || '—' },
    { label: 'Matched as', width: '9rem', render: (p) => <span className="rounded-full bg-[#61A644]/10 text-[#3F6F2C] px-2 py-0.5 text-xs">{matchName(p.generic_name)}</span> },
    { label: 'Source', width: '7rem', render: (p) => SOURCES[p.source] || `Added${p.added_by ? ` by ${p.added_by.split('@')[0]}` : ''}` },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black">Product List</h1>
            <p className="text-xs text-black/62 mt-1">
              PhilGEPS and PS-PhilGEPS tenders count when they ask for one of these molecules in one of these dosages
              {products ? ` · ${molecules} molecules, ${products.length} products` : ''}
            </p>
          </div>
          <button
            onClick={() => {
              setAdding(true);
              setAdded('');
            }}
            className="inline-flex items-center justify-center gap-2 bg-[#4A8033] hover:bg-[#3F6F2C] text-white px-4 py-2 rounded-full text-sm font-medium transition"
          >
            + Add Molecule
          </button>
        </header>

        {error && <p className="rounded-[14px] border border-[#B3312C]/25 bg-[#B3312C]/6 px-4 py-3 text-sm text-[#B3312C]">{error}</p>}
        {added && <p className="rounded-[14px] border border-[#61A644]/30 bg-[#61A644]/8 px-4 py-3 text-sm text-[#2F5321]">{added}</p>}
        {adding && (
          <AddMolecule
            products={products || []}
            onCancel={() => setAdding(false)}
            onAdded={(message) => {
              setAdding(false);
              setAdded(message);
              load();
            }}
          />
        )}

        <input
          type="text"
          placeholder="Search by generic name, brand, dosage or classification..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white border border-[#CBD5E1] text-black placeholder:text-black/46 rounded-[14px] px-4 py-3 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25 transition"
        />

        {!products ? (
          <p className="py-12 text-center text-black/46">{error ? '' : 'Loading the product list...'}</p>
        ) : rows.length ? (
          <ResponsiveTable columns={columns} rows={rows} rowKey={(p) => p.id} />
        ) : (
          <p className="py-12 text-center text-black/46">No product matches the search.</p>
        )}
      </div>
    </div>
  );
}

const same = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

// The Add Molecule window. Generic Name, Brand Name and Dosage are required. While typing it shows what the list
// already has for that molecule (so a new dosage is easy to tell from a repeat) and how tenders will be matched.
function AddMolecule({ products, onCancel, onAdded }) {
  const [form, setForm] = useState({ generic_name: '', brand_name: '', dosage: '' });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fields = [
    ['generic_name', 'Generic Name', 'e.g. Paclitaxel', 'The molecule. Salts and brackets are dropped when matching.'],
    ['brand_name', 'Brand Name', 'e.g. PacliGet 100mg', 'Our brand for this product.'],
    ['dosage', 'Dosage', 'e.g. 6 mg/ml (100 mg/16.7 ml)', 'Tenders must ask for this exact strength.'],
  ];
  const missing = fields.filter(([key]) => !form[key].trim());
  const molecule = form.generic_name.trim() ? matchName(form.generic_name) : '';
  const onList = molecule ? products.filter((p) => matchName(p.generic_name) === molecule) : [];
  const duplicate = onList.find((p) => same(p.generic_name, form.generic_name) && same(p.brand_name, form.brand_name) && same(p.dosage, form.dosage));

  const save = async (e) => {
    e.preventDefault();
    setTried(true);
    if (missing.length || duplicate) return;
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onAdded(`${form.generic_name.trim()} (${form.brand_name.trim()}, ${form.dosage.trim()}) was added. From the next update and Sync on, tenders asking for "${data.matchedAs}" ${form.dosage.trim()} count as ours.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Molecule"
      subtitle="Add a product to our list so matching tenders on PhilGEPS and PS-PhilGEPS count as ours."
      busy={saving}
      onClose={onCancel}
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          <path d="m10.5 20.5-7-7a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7Z" />
          <path d="m7 10 7 7" />
        </svg>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-[#CBD5E1] px-4 py-2 text-xs font-medium text-black/62 transition hover:bg-[#1EA0DA]/6 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="add-molecule"
            disabled={saving || !!duplicate}
            className="rounded-lg bg-[#1EA0DA] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#1790C5] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Adding…' : 'Add Molecule'}
          </button>
        </>
      }
    >
      <form id="add-molecule" onSubmit={save} noValidate className="space-y-3.5">
        {fields.map(([key, label, placeholder, hint]) => {
          const invalid = tried && !form[key].trim();
          return (
            <label key={key} className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-black/62">
                {label} <span className="text-[#B3312C]">*</span>
              </span>
              <input
                value={form[key]}
                placeholder={placeholder}
                maxLength={200}
                aria-invalid={invalid}
                aria-describedby={`${key}-hint`}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className={`mt-1.5 w-full rounded-full border bg-white px-4 py-2.5 text-sm text-black placeholder:text-black/46 transition focus:outline-none focus:ring-2 ${
                  invalid ? 'border-[#B3312C] focus:ring-[#B3312C]/20' : 'border-[#CBD5E1] focus:border-[#1EA0DA] focus:ring-[#1EA0DA]/25'
                }`}
              />
              <span id={`${key}-hint`} className={`mt-1 block px-4 text-xs ${invalid ? 'text-[#B3312C]' : 'text-black/46'}`}>
                {invalid ? `${label} is required.` : hint}
              </span>
            </label>
          );
        })}
      </form>

      {/* Live preview: how tenders will be matched */}
      <section className="rounded-[14px] border border-[#E2E8F0] bg-[#1EA0DA]/[0.02] p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-black/62">How tenders will match</h3>
        {molecule ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-black/62">
            A tender counts as ours when it asks for
            <span className="rounded-full border border-[#61A644]/25 bg-[#61A644]/10 px-3 py-0.5 text-xs font-semibold text-[#3F6F2C]">{molecule}</span>
            in
            {form.dosage.trim() ? (
              <span className="rounded-full border border-[#1EA0DA]/25 bg-[#1EA0DA]/8 px-3 py-0.5 text-xs font-semibold text-[#12769F]">{form.dosage.trim()}</span>
            ) : (
              <span className="rounded-full border border-dashed border-[#CBD5E1] px-3 py-0.5 text-xs text-black/46">this dosage</span>
            )}
          </p>
        ) : (
          <p className="text-sm text-black/46">Type a Generic Name to see the molecule tenders are matched by.</p>
        )}

        {onList.length > 0 && (
          <div className="mt-3 border-t border-[#E2E8F0] pt-3">
            <p className="text-xs text-black/62">
              <b className="text-black">{molecule}</b> is already on the list in {onList.length === 1 ? '1 product' : `${onList.length} products`}. Adding a new dosage is fine.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {onList.map((p) => (
                <span
                  key={p.id}
                  title={p.brand_name}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${p === duplicate ? 'border-[#B3312C]/40 bg-[#B3312C]/6 text-[#B3312C]' : 'border-[#CBD5E1] text-black/62'}`}
                >
                  {p.dosage}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {duplicate && (
        <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">
          This molecule with that brand and dosage is already on the list.
        </p>
      )}
      {error && <p className="rounded-xl border border-[#B3312C]/25 bg-[#B3312C]/6 p-3.5 text-xs font-medium text-[#B3312C]">{error}</p>}
    </Modal>
  );
}
