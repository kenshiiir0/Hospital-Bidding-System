'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { matchName } from '@/lib/products.mjs';
import ResponsiveTable from '@/components/ResponsiveTable';

// Our product list (table products): the team's PRODUCT LIST plus molecules added here. The only list tenders on
// PhilGEPS and PS-PhilGEPS are screened against; "Matched as" is the name the system looks for in tender text.
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
    { label: 'Source', width: '7rem', render: (p) => (p.source === 'product-list' ? 'Product list' : `Added${p.added_by ? ` by ${p.added_by.split('@')[0]}` : ''}`) },
  ];

  return (
    <div className="min-h-screen bg-white text-black antialiased">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-[#E2E8F0]">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-black">Product List</h1>
            <p className="text-xs text-black/62 mt-1">
              The molecules PhilGEPS and PS-PhilGEPS tenders are screened for{products ? ` · ${molecules} molecules, ${products.length} products` : ''}
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

// Generic Name, Brand Name and Dosage are required
function AddMolecule({ onCancel, onAdded }) {
  const [form, setForm] = useState({ generic_name: '', brand_name: '', dosage: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fields = [
    ['generic_name', 'Generic Name', 'e.g. Paclitaxel'],
    ['brand_name', 'Brand Name', 'e.g. PacliGet 100mg'],
    ['dosage', 'Dosage', 'e.g. 6 mg/ml (100 mg/16.7 ml)'],
  ];
  const missing = fields.filter(([key]) => !form[key].trim());

  const save = async (e) => {
    e.preventDefault();
    if (missing.length) return setError(`Please fill in: ${missing.map(([, label]) => label).join(', ')}.`);
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      onAdded(`${form.generic_name.trim()} (${form.brand_name.trim()}, ${form.dosage.trim()}) was added. Tenders are screened for "${data.matchedAs}" from the next update and Sync on.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="rounded-[14px] border border-[#E2E8F0] p-5 space-y-4">
      <h2 className="text-base font-semibold">Add Molecule</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {fields.map(([key, label, placeholder]) => (
          <label key={key} className="block text-sm">
            <span className="text-black/62">
              {label} <span className="text-[#B3312C]">*</span>
            </span>
            <input
              required
              value={form[key]}
              placeholder={placeholder}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              className="mt-1 w-full bg-white border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1EA0DA] focus:ring-2 focus:ring-[#1EA0DA]/25"
            />
          </label>
        ))}
      </div>
      {form.generic_name.trim() && (
        <p className="text-xs text-black/62">
          Tenders will be screened for <b className="text-[#3F6F2C]">{matchName(form.generic_name)}</b>.
        </p>
      )}
      {error && <p className="text-sm text-[#B3312C]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="bg-[#4A8033] hover:bg-[#3F6F2C] disabled:opacity-60 text-white px-4 py-2 rounded-full text-sm font-medium transition">
          {saving ? 'Saving…' : 'Add Molecule'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-full text-sm text-black/62 hover:bg-[#1EA0DA]/6 transition">
          Cancel
        </button>
      </div>
    </form>
  );
}
