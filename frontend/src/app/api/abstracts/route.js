import { requireUser } from '@/lib/auth';
import { agencyKey } from '@/lib/agencyKey';
import { createClient } from '@supabase/supabase-js';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// "1,092.50" / 1092.5 -> 1092.5; empty -> null; anything else -> NaN (refused)
const amount = (v) => {
  const s = String(v ?? '').replace(/[₱,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

// The Abstract of Bids (table bid_abstracts, archived rows too). Team members only: our prices and the competitors'
// are not for competitors.
export async function GET(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const { data, error } = await admin()
    .from('bid_abstracts')
    .select('*')
    .order('year', { ascending: false })
    .order('sheet_row', { ascending: true, nullsFirst: false })
    .order('created_at');
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json(data);
}

// Add Result: { hospital, item (required), abc_price, quantity, our_price, winner, winning_price, note }.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const hospital = clean(body.hospital).toUpperCase();
  const item = clean(body.item);
  const missing = [!agencyKey(hospital) && 'Hospital', !item && 'Item'].filter(Boolean);
  if (missing.length) return Response.json({ ok: false, error: `Please fill in: ${missing.join(', ')}.` }, { status: 400 });
  const numbers = { abc_price: amount(body.abc_price), quantity: amount(body.quantity), our_price: amount(body.our_price), winning_price: amount(body.winning_price) };
  const bad = Object.entries(numbers).find(([, n]) => Number.isNaN(n));
  if (bad) return Response.json({ ok: false, error: `${bad[0].replace('_', ' ')} must be a number.` }, { status: 400 });
  const row = {
    year: new Date().getFullYear(),
    hospital,
    agency_key: agencyKey(hospital),
    item,
    ...numbers,
    winner: clean(body.winner).toUpperCase() || null,
    note: clean(body.note, 500) || null,
    source: 'added',
    added_by: user.email,
  };
  const { data, error } = await admin().from('bid_abstracts').insert(row).select().single();
  if (error) {
    const duplicate = error.code === '23505';
    return Response.json({ ok: false, error: duplicate ? 'This item is already in the abstract for that hospital (look in Archived too).' : error.message }, { status: duplicate ? 409 : 500 });
  }
  return Response.json({ ok: true, result: data }, { status: 201 });
}

// Archive / Restore: { id, archived: true | false }. An archived result stays in the table.
export async function PATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id) || typeof body.archived !== 'boolean') return Response.json({ ok: false, error: 'Send { id, archived: true | false }.' }, { status: 400 });
  const change = body.archived ? { archived_at: new Date().toISOString(), archived_by: user.email } : { archived_at: null, archived_by: null };
  const { data, error } = await admin().from('bid_abstracts').update(change).eq('id', id).select().maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That result is no longer in the abstract.' }, { status: 404 });
  return Response.json({ ok: true, result: data });
}

// Import Excel: { results: [...] } as read in the browser from the "ABSTRACT 2026" sheet (lib/sheetImport.mjs
// readAbstractSheet) or from a hospital's own abstract (readHospitalAbstract, which sends a note for every row: why
// our price is unknown, or none). Saved by (year, hospital, item): a row already there is updated (archive state
// kept), others added; rows not on the sheet are left alone. The tracker sends no note, so a typed note stays.
export async function PUT(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.results) || !body.results.length || body.results.length > 5000) {
    return Response.json({ ok: false, error: 'No results to import.' }, { status: 400 });
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const now = new Date().toISOString();
  const seen = new Set();
  const rows = [];
  // Every row of one import has the same columns (an upsert writes each column for all rows)
  const withNotes = body.results.some((r) => r && 'note' in r);
  for (const r of body.results) {
    const hospital = clean(r?.hospital).toUpperCase();
    const item = clean(r?.item);
    const agency_key = agencyKey(hospital);
    const year = Number.isInteger(r?.year) && r.year > 2000 && r.year < 2100 ? r.year : new Date().getFullYear();
    if (!agency_key || !item || seen.has(`${year}|${agency_key}|${item}`)) continue;
    seen.add(`${year}|${agency_key}|${item}`);
    rows.push({
      year,
      hospital,
      agency_key,
      item,
      abc_price: num(r.abc_price),
      quantity: num(r.quantity),
      our_price: num(r.our_price),
      winner: clean(r.winner).toUpperCase() || null,
      winning_price: num(r.winning_price),
      sheet_row: Number.isInteger(r.sheet_row) ? r.sheet_row : null,
      ...(withNotes ? { note: clean(r.note, 500) || null } : {}),
      source: 'excel-import',
      updated_at: now,
    });
  }
  if (!rows.length) return Response.json({ ok: false, error: 'No rows with a hospital and an item.' }, { status: 400 });
  const supabase = admin();
  const { data: before, error: readError } = await supabase.from('bid_abstracts').select('year, agency_key, item');
  if (readError) return Response.json({ ok: false, error: readError.message }, { status: 500 });
  const had = new Set(before.map((r) => `${r.year}|${r.agency_key}|${r.item}`));
  const { error } = await supabase.from('bid_abstracts').upsert(rows, { onConflict: 'year,agency_key,item' });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const updated = rows.filter((r) => had.has(`${r.year}|${r.agency_key}|${r.item}`)).length;
  return Response.json({ ok: true, added: rows.length - updated, updated });
}
