import { requireUser } from '@/lib/auth';
import { loadProducts, matchName } from '@/lib/products.mjs';
import { createClient } from '@supabase/supabase-js';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Our products (table products: the PRODUCT LIST plus Add Molecule). Default: the molecule names tenders are
// matched by (the dashboard's exclusion filter, as before); ?rows=1: every row, for signed-in team members.
export async function GET(request) {
  try {
    const products = await loadProducts(admin());
    if (new URL(request.url).searchParams.get('rows')) {
      const { response } = await requireUser(request);
      if (response) return response;
      return Response.json(products);
    }
    return Response.json([...new Set(products.map((p) => matchName(p.generic_name)))].sort((a, b) => a.localeCompare(b)));
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Add Molecule: { generic_name, brand_name, dosage } (all required). Tenders are screened for it from the next
// update and Sync on.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const row = { generic_name: clean(body.generic_name), brand_name: clean(body.brand_name), dosage: clean(body.dosage) };
  const missing = [['generic_name', 'Generic Name'], ['brand_name', 'Brand Name'], ['dosage', 'Dosage']].filter(([key]) => !row[key]).map(([, label]) => label);
  if (missing.length) return Response.json({ ok: false, error: `Please fill in: ${missing.join(', ')}.` }, { status: 400 });
  if (!matchName(row.generic_name)) return Response.json({ ok: false, error: 'The Generic Name has no molecule name in it.' }, { status: 400 });
  const { data, error } = await admin()
    .from('products')
    .insert({ ...row, source: 'added', added_by: user.email })
    .select()
    .single();
  if (error) {
    const duplicate = error.code === '23505';
    return Response.json({ ok: false, error: duplicate ? 'This molecule with that brand and dosage is already on the list.' : error.message }, { status: duplicate ? 409 : 500 });
  }
  return Response.json({ ok: true, product: data, matchedAs: matchName(row.generic_name) }, { status: 201 });
}
