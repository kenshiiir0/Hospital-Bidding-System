import { requireUser } from '@/lib/auth';
import { loadProducts, matchName } from '@/lib/products.mjs';
import { createClient } from '@supabase/supabase-js';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Our products (table products: the PRODUCT LIST plus Add Molecule). Default: the molecule names tenders are
// matched by (the dashboard's exclusion filter, as before); ?rows=1: every row, archived ones too. Both for
// signed-in team members only: the list is what we bid on, which competitors must not see.
export async function GET(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  try {
    if (new URL(request.url).searchParams.get('rows')) {
      return Response.json(await loadProducts(admin(), { includeArchived: true }));
    }
    const products = await loadProducts(admin());
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
    const message = 'This molecule with that brand and dosage is already on the list (look in Archived too; Restore brings it back).';
    return Response.json({ ok: false, error: duplicate ? message : error.message }, { status: duplicate ? 409 : 500 });
  }
  return Response.json({ ok: true, product: data, matchedAs: matchName(row.generic_name) }, { status: 201 });
}

// Archive / Restore: { id, archived: true | false }. An archived product stays in the table but tenders are no
// longer screened for it from the next update and Sync on. The last active product can't be archived (the
// matcher never screens against an empty list).
export async function PATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || typeof body.archived !== 'boolean') return Response.json({ ok: false, error: 'Send { id, archived: true | false }.' }, { status: 400 });
  const supabase = admin();
  if (body.archived) {
    const { count, error } = await supabase.from('products').select('id', { count: 'exact', head: true }).is('archived_at', null).neq('id', id);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    if (!count) return Response.json({ ok: false, error: 'This is the last active product; add another before archiving it.' }, { status: 409 });
  }
  const change = body.archived ? { archived_at: new Date().toISOString(), archived_by: user.email } : { archived_at: null, archived_by: null };
  const { data, error } = await supabase.from('products').update(change).eq('id', id).select().maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That product is no longer on the list.' }, { status: 404 });
  return Response.json({ ok: true, product: data, matchedAs: matchName(data.generic_name) });
}
