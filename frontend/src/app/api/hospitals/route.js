import { requireUser } from '@/lib/auth';
import { agencyKey } from '@/lib/agencyKey';
import { createClient } from '@supabase/supabase-js';

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const FIELDS = 'agency_key, name, status, list_note, contacts, emails, website, sheet_row, source, added_by, created_at, archived_at, archived_by';
const STATUSES = ['active', 'rfq', 'prospect'];
const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The Hospital List (table hospitals, rows with a status; archived ones too). Team members only: who we bid for
// and their contacts are not for competitors.
export async function GET(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const { data, error } = await admin()
    .from('hospitals')
    .select(FIELDS)
    .not('status', 'is', null)
    .order('sheet_row', { ascending: true, nullsFirst: false })
    .order('name');
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json(data);
}

// Add Hospital: { name (required), status, contact_name, contact_phone, email, note }. A hospital already saved
// only for its website (View details) joins the list; one already on the list is refused.
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const name = clean(body.name).toUpperCase();
  const key = agencyKey(name);
  if (!key) return Response.json({ ok: false, error: 'Please fill in the Hospital Name.' }, { status: 400 });
  const status = STATUSES.includes(body.status) ? body.status : 'active';
  const email = clean(body.email).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return Response.json({ ok: false, error: 'The e-mail address does not look right.' }, { status: 400 });
  const contact = { name: clean(body.contact_name) || null, phone: clean(body.contact_phone, 80) || null };
  const listed = {
    status,
    list_note: clean(body.note, 500) || null,
    contacts: contact.name || contact.phone ? [contact] : [],
    emails: email ? [email] : [],
    updated_at: new Date().toISOString(),
  };

  const supabase = admin();
  const { data: old, error: readError } = await supabase.from('hospitals').select('agency_key, name, status, archived_at').eq('agency_key', key).maybeSingle();
  if (readError) return Response.json({ ok: false, error: readError.message }, { status: 500 });
  if (old?.status) {
    const where = old.archived_at ? ' under Archived (Restore brings it back)' : '';
    return Response.json({ ok: false, error: `${old.name} is already on the list${where}.` }, { status: 409 });
  }
  const write = old
    ? supabase.from('hospitals').update({ ...listed, source: 'added', added_by: user.email }).eq('agency_key', key)
    : supabase.from('hospitals').insert({ agency_key: key, name, ...listed, source: 'added', added_by: user.email });
  const { data, error } = await write.select(FIELDS).single();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, hospital: data }, { status: 201 });
}

// Archive / Restore: { agency_key, archived: true | false }. An archived hospital stays in the table.
export async function PATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  if (typeof body.agency_key !== 'string' || typeof body.archived !== 'boolean') {
    return Response.json({ ok: false, error: 'Send { agency_key, archived: true | false }.' }, { status: 400 });
  }
  const change = body.archived ? { archived_at: new Date().toISOString(), archived_by: user.email } : { archived_at: null, archived_by: null };
  const { data, error } = await admin().from('hospitals').update(change).eq('agency_key', body.agency_key).not('status', 'is', null).select(FIELDS).maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That hospital is no longer on the list.' }, { status: 404 });
  return Response.json({ ok: true, hospital: data });
}
