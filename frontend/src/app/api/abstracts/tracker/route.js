import { requireUser } from '@/lib/auth';
import { agencyKey } from '@/lib/agencyKey';
import { createClient } from '@supabase/supabase-js';

// The Overall Abstract tracker (Abstract of Bids → Overall Abstract / All Bids; lib/abstractTracker.mjs). Team members
// only: our prices and the competitors' are not for competitors. Tables abstract_tracker, abstract_tracker_items,
// abstract_tracker_molecules (schema.sql); written only here, with the service key.

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const clean = (v, max = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
// Typed in a form: "1,092.50" -> 1092.5; empty -> null; anything else -> NaN (refused)
const typed = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : NaN;
  const s = String(v ?? '').replace(/[₱,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};
const validYear = (y) => Number.isInteger(y) && y > 2000 && y < 2100;

// GET ?year=2026 (default: the latest imported): { years, tracker, items, molecules }; tracker null when none yet
export async function GET(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const supabase = admin();
  const { data: trackers, error } = await supabase.from('abstract_tracker').select('*').order('year', { ascending: false });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const asked = Number(new URL(request.url).searchParams.get('year'));
  const tracker = trackers.find((t) => t.year === asked) || trackers[0] || null;
  if (!tracker) return Response.json({ years: [], tracker: null, items: [], molecules: [] });
  const [items, molecules] = await Promise.all([
    supabase.from('abstract_tracker_items').select('*').eq('year', tracker.year).order('position').limit(10000),
    supabase.from('abstract_tracker_molecules').select('*').eq('year', tracker.year).order('position').limit(5000),
  ]);
  const failed = items.error || molecules.error;
  if (failed) return Response.json({ ok: false, error: failed.message }, { status: 500 });
  return Response.json({ years: trackers.map((t) => t.year), tracker, items: items.data, molecules: molecules.data });
}

// Import Excel: { items: [...], molecules: [...], meta: { bidders, overall_notes, bids_notes, highlighted, file_name } }
// as read in the browser (readTrackerWorkbook); every item carries the year chosen in the window. Replaces that
// year's tracker in one go (replace_abstract_tracker), so a failed import leaves the old one as it was.
export async function PUT(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  if (body.mode === 'hospital') return mergeHospital(body, user);
  const items = Array.isArray(body.items) ? body.items : [];
  const molecules = Array.isArray(body.molecules) ? body.molecules : [];
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  if (!items.length || items.length > 5000 || molecules.length > 2000) return Response.json({ ok: false, error: 'No tracker rows to import.' }, { status: 400 });
  const year = Number(items[0]?.year);
  if (!validYear(year)) return Response.json({ ok: false, error: 'Please give the year of this tracker (e.g. 2026).' }, { status: 400 });
  const texts = (list, max) => (Array.isArray(list) ? list.map((s) => clean(s, max)).filter(Boolean).slice(0, 500) : []);

  const rows = [];
  for (const [i, r] of items.entries()) {
    const hospital = clean(r?.hospital, 200).toUpperCase();
    const description = clean(r?.description, 500);
    if (!agencyKey(hospital) || !description) continue;
    rows.push({
      position: Number.isFinite(r.position) ? r.position : i + 1,
      hospital,
      agency_key: agencyKey(hospital),
      block: Number.isInteger(r.block) && r.block > 0 ? r.block : 1,
      item_no: clean(r.item_no, 20) || '-',
      description,
      quantity: num(r.quantity),
      abc_price: num(r.abc_price),
      lowest_bid: num(r.lowest_bid),
      lowest_bidder: clean(r.lowest_bidder, 500) || null,
      our_price: num(r.our_price),
    });
  }
  if (!rows.length) return Response.json({ ok: false, error: 'No rows with a hospital and a description.' }, { status: 400 });
  const bidders = texts(meta.bidders, 200);
  const known = new Set(bidders);
  const mols = [];
  for (const [i, m] of molecules.entries()) {
    const molecule = clean(m?.molecule, 300);
    if (!molecule) continue;
    const prices = {};
    for (const [b, p] of Object.entries(m.prices || {})) if (known.has(b) && num(p) != null) prices[b] = p;
    mols.push({ position: Number.isInteger(m.position) ? m.position : i + 1, item_no: clean(m.item_no, 20) || String(i + 1), molecule, prices, our_price: num(m.our_price) });
  }

  const { data, error } = await admin().rpc('replace_abstract_tracker', {
    p_year: year,
    p_meta: {
      bidders,
      overall_notes: texts(meta.overall_notes, 1000),
      bids_notes: texts(meta.bids_notes, 1000),
      highlighted: texts(meta.highlighted, 200),
      file_name: clean(meta.file_name, 200) || null,
      imported_by: user.email,
    },
    p_items: rows,
    p_molecules: mols,
  });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const hospitals = new Set(rows.map((r) => r.agency_key)).size;
  return Response.json({
    ok: true,
    message: `Imported the ${year} tracker: ${data.items} items from ${hospitals} hospitals and ${data.molecules} molecules with ${bidders.length} bidder columns. The tracker before this import was replaced.`,
  });
}

// Import Excel with a hospital's own Abstract of Bids: { mode: 'hospital', year, hospital, bidders, molecules:
// [{ id, prices }], items: [...], lowered: [{ id, lowest_bid, lowest_bidder }] } as planned in the browser
// (planHospitalMerge). Saved in one go (merge_hospital_abstract); an earlier import of that hospital's file is replaced.
async function mergeHospital(body, user) {
  const year = Number(body.year);
  const hospital = clean(body.hospital, 200).toUpperCase();
  const key = agencyKey(hospital);
  if (!validYear(year)) return Response.json({ ok: false, error: 'Please give the year (e.g. 2026).' }, { status: 400 });
  if (!key) return Response.json({ ok: false, error: 'Please choose the hospital this abstract is from.' }, { status: 400 });
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const bidders = list(body.bidders, 2000).map((b) => clean(b, 200)).filter(Boolean);
  const known = new Set(bidders);
  const molecules = list(body.molecules, 2000)
    .filter((m) => Number.isInteger(m?.id))
    .map((m) => ({ id: m.id, prices: Object.fromEntries(Object.entries(m.prices || {}).filter(([b, p]) => known.has(b) && num(p) != null)) }));
  const items = list(body.items, 2000)
    .map((it, ord) => ({
      ord,
      item_no: clean(it?.item_no, 20) || '-',
      description: clean(it?.description, 500),
      lowest_bid: num(it?.lowest_bid),
      lowest_bidder: clean(it?.lowest_bidder, 500) || null,
      our_price: num(it?.our_price),
    }))
    .filter((it) => it.description);
  const lowered = list(body.lowered, 5000)
    .filter((l) => Number.isInteger(l?.id) && num(l.lowest_bid) != null)
    .map((l) => ({ id: l.id, lowest_bid: l.lowest_bid, lowest_bidder: clean(l.lowest_bidder, 500) || null }));
  if (!items.length && !molecules.length) return Response.json({ ok: false, error: 'Nothing in this file is one of our molecules in the tracker.' }, { status: 400 });

  const { data, error } = await admin().rpc('merge_hospital_abstract', {
    p_year: year,
    p_agency_key: key,
    p_hospital: hospital,
    p_bidders: bidders,
    p_molecules: molecules,
    p_items: items,
    p_lowered: lowered,
    p_user: user.email,
  });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({
    ok: true,
    message: `Added ${hospital}'s abstract to the ${year} tracker: ${data.items} item${data.items === 1 ? '' : 's'} in Overall Abstract, prices on ${data.molecules} molecule${data.molecules === 1 ? '' : 's'} in All Bids${
      data.lowered ? `, Lowest Bid lowered on ${data.lowered} row${data.lowered === 1 ? '' : 's'} of other hospitals` : ''
    }.`,
  });
}

const ITEM_FIELDS =['item_no', 'description', 'quantity', 'abc_price', 'lowest_bid', 'lowest_bidder', 'our_price'];
const NUMBER_FIELDS = new Set(['quantity', 'abc_price', 'lowest_bid', 'our_price']);
const LABELS = { quantity: 'Qty', abc_price: 'ABC Price', lowest_bid: 'Lowest Bid', our_price: '2mg Price' };

// Typed item fields -> columns to save, or { error }
function itemChange(body) {
  const change = {};
  for (const f of ITEM_FIELDS) {
    if (!(f in body)) continue;
    if (NUMBER_FIELDS.has(f)) {
      const n = typed(body[f]);
      if (Number.isNaN(n)) return { error: `${LABELS[f]} must be a number.` };
      change[f] = n;
    } else change[f] = clean(body[f], f === 'description' || f === 'lowest_bidder' ? 500 : 20) || (f === 'item_no' ? '-' : null);
  }
  if ('description' in change && !change.description) return { error: 'Please fill in the Description.' };
  return { change };
}

// Add Item: { year, hospital, block (a group number, or "new"), description (required), item_no, quantity, … }.
// Goes at the end of that group, or as a new group after the hospital's last one (a new hospital goes at the end).
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const year = Number(body.year);
  const hospital = clean(body.hospital, 200).toUpperCase();
  const key = agencyKey(hospital);
  if (!validYear(year)) return Response.json({ ok: false, error: 'Import a tracker first.' }, { status: 400 });
  if (!key) return Response.json({ ok: false, error: 'Please fill in: Hospital.' }, { status: 400 });
  const { change, error: bad } = itemChange({ ...body, description: body.description ?? '' });
  if (bad) return Response.json({ ok: false, error: bad }, { status: 400 });
  const supabase = admin();
  const { data: rows, error: readError } = await supabase.from('abstract_tracker_items').select('position, agency_key, hospital, block').eq('year', year).order('position');
  if (readError) return Response.json({ ok: false, error: readError.message }, { status: 500 });
  const mine = rows.filter((r) => r.agency_key === key);
  const blocks = [...new Set(mine.map((r) => r.block))];
  const block = body.block === 'new' || !blocks.length ? (blocks.length ? Math.max(...blocks) + 1 : 1) : Number(body.block);
  if (!Number.isInteger(block) || block < 1) return Response.json({ ok: false, error: 'Choose a group for the item.' }, { status: 400 });
  // After the group's last row (or the hospital's last row); halfway to the next row, so nothing else moves
  const anchor = [...mine].reverse().find((r) => r.block === block) || mine[mine.length - 1];
  const last = rows.length ? rows[rows.length - 1].position : 0;
  let position = last + 1;
  if (anchor) {
    const next = rows.find((r) => r.position > anchor.position);
    position = next ? (anchor.position + next.position) / 2 : anchor.position + 1;
  }
  const row = { year, hospital: mine[0]?.hospital || hospital, agency_key: key, block, position, item_no: '-', ...change, source: 'added', updated_by: user.email };
  const { data, error } = await supabase.from('abstract_tracker_items').insert(row).select().single();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, item: data }, { status: 201 });
}

// Edit: { id, ...item fields } for an Overall Abstract row, or { molecule_id, our_price } for an All Bids row
export async function PATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const supabase = admin();
  const now = new Date().toISOString();
  if (body.molecule_id != null) {
    const id = Number(body.molecule_id);
    const our = typed(body.our_price);
    if (!Number.isInteger(id) || Number.isNaN(our)) return Response.json({ ok: false, error: '2mg Price must be a number.' }, { status: 400 });
    const { data, error } = await supabase.from('abstract_tracker_molecules').update({ our_price: our, updated_by: user.email, updated_at: now }).eq('id', id).select().maybeSingle();
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return Response.json({ ok: false, error: 'That molecule is no longer in the tracker.' }, { status: 404 });
    return Response.json({ ok: true, molecule: data });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id)) return Response.json({ ok: false, error: 'Send { id, ...fields }.' }, { status: 400 });
  const { change, error: bad } = itemChange(body);
  if (bad) return Response.json({ ok: false, error: bad }, { status: 400 });
  const { data, error } = await supabase.from('abstract_tracker_items').update({ ...change, updated_by: user.email, updated_at: now }).eq('id', id).select().maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That item is no longer in the tracker.' }, { status: 404 });
  return Response.json({ ok: true, item: data });
}

// Remove an Overall Abstract row: { id }
export async function DELETE(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id)) return Response.json({ ok: false, error: 'Send { id }.' }, { status: 400 });
  const { data, error } = await admin().from('abstract_tracker_items').delete().eq('id', id).select().maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That item is no longer in the tracker.' }, { status: 404 });
  return Response.json({ ok: true, item: data });
}
