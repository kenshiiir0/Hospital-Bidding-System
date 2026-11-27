import { requireUser } from '@/lib/auth';
import { agencyKey } from '@/lib/agencyKey';
import { planHospitalImport } from '@/lib/sheetImport.mjs';
import { serverDb } from '@/lib/db/index.mjs';

// The database client. Without its settings (SUPABASE_URL + SUPABASE_KEY, or DATA_BACKEND=pg + DATABASE_URL) it
// throws NoDatabase, and the handlers answer with that message instead of crashing with an empty reply.
class NoDatabase extends Error {}
function admin() {
  const db = serverDb();
  if (!db) throw new NoDatabase('The database settings (SUPABASE_URL + SUPABASE_KEY, or DATABASE_URL) are not set on this server.');
  return db;
}
const handled = (handler) => async (request) => {
  try {
    return await handler(request);
  } catch (e) {
    if (e instanceof NoDatabase) return Response.json({ ok: false, error: e.message }, { status: 503 });
    throw e;
  }
};

const FIELDS = 'agency_key, name, status, list_note, contacts, emails, website, sheet_row, source, added_by, created_at, archived_at, archived_by';
const STATUSES = ['active', 'rfq', 'prospect'];
const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The Hospital List (table hospitals, rows with a status; archived ones too). Team members only: who we bid for
// and their contacts are not for competitors.
async function handleGET(request) {
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
async function handlePOST(request) {
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// Edit (Hospital List ••• → Edit, "+ Add email"): the same columns Add Hospital and Import Excel write.
// Each field is optional; a field left out stays as it is.
function editChange(edit) {
  const change = { updated_at: new Date().toISOString() };
  if (edit.status !== undefined) {
    if (!STATUSES.includes(edit.status)) return { error: 'Unknown status.' };
    change.status = edit.status;
  }
  if (edit.list_note !== undefined) change.list_note = clean(edit.list_note, 500) || null;
  if (edit.emails !== undefined) {
    if (!Array.isArray(edit.emails)) return { error: 'E-mails must be a list.' };
    const emails = [...new Set(edit.emails.map((e) => clean(e).toLowerCase()).filter(Boolean))];
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) return { error: `"${bad}" does not look like an e-mail address.` };
    change.emails = emails.slice(0, 10);
  }
  if (edit.contacts !== undefined) {
    if (!Array.isArray(edit.contacts)) return { error: 'Contacts must be a list.' };
    change.contacts = edit.contacts
      .slice(0, 50)
      .map((c) => ({
        name: clean(c?.name) || null,
        role: clean(c?.role) || null,
        phone: clean(c?.phone, 80) || null,
        ...(typeof c?.source === 'string' ? { source: clean(c.source, 40) } : {}),
      }))
      .filter((c) => c.name || c.phone);
  }
  return { change };
}

// Archive / Restore: { agency_key, archived: true | false }. An archived hospital stays in the table.
// Edit: { agency_key, edit: { status?, list_note?, emails?, contacts? } }.
async function handlePATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const isEdit = body.edit && typeof body.edit === 'object';
  if (typeof body.agency_key !== 'string' || (!isEdit && typeof body.archived !== 'boolean')) {
    return Response.json({ ok: false, error: 'Send { agency_key, archived: true | false } or { agency_key, edit }.' }, { status: 400 });
  }
  let change;
  if (isEdit) {
    const result = editChange(body.edit);
    if (result.error) return Response.json({ ok: false, error: result.error }, { status: 400 });
    change = result.change;
  } else {
    change = body.archived ? { archived_at: new Date().toISOString(), archived_by: user.email } : { archived_at: null, archived_by: null };
  }
  const { data, error } = await admin().from('hospitals').update(change).eq('agency_key', body.agency_key).not('status', 'is', null).select(FIELDS).maybeSingle();
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return Response.json({ ok: false, error: 'That hospital is no longer on the list.' }, { status: 404 });
  return Response.json({ ok: true, hospital: data });
}

// Import Excel: { hospitals: [...] } as read in the browser from the "Active Hospital" sheet (lib/sheetImport.mjs
// readHospitalSheet). Same rules as tools/import-hospitals.mjs: matched by name, websites and archive state kept,
// contacts added outside the sheet kept, hospitals not on the sheet left alone.
async function handlePUT(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.hospitals) || !body.hospitals.length || body.hospitals.length > 2000) {
    return Response.json({ ok: false, error: 'No hospitals to import.' }, { status: 400 });
  }
  const text = (v, max) => clean(v, max) || null;
  const hospitals = body.hospitals
    .map((h) => ({
      name: clean(h?.name).toUpperCase(),
      status: STATUSES.includes(h?.status) ? h.status : 'prospect',
      list_note: text(h?.list_note, 500),
      contacts: (Array.isArray(h?.contacts) ? h.contacts : []).slice(0, 30).map((c) => ({ name: text(c?.name, 200), phone: text(c?.phone, 80) })).filter((c) => c.name || c.phone),
      emails: (Array.isArray(h?.emails) ? h.emails : []).map((e) => clean(e, 200).toLowerCase()).filter((e) => e.includes('@')).slice(0, 10),
      websites: (Array.isArray(h?.websites) ? h.websites : []).map((w) => clean(w, 200).toLowerCase()).filter((w) => /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/.test(w.replace(/^https?:\/\//, ''))).slice(0, 3),
      sheet_row: Number.isInteger(h?.sheet_row) ? h.sheet_row : null,
    }))
    .filter((h) => agencyKey(h.name));
  const supabase = admin();
  const { data: existing, error: readError } = await supabase.from('hospitals').select('agency_key, website, contacts');
  if (readError) return Response.json({ ok: false, error: readError.message }, { status: 500 });
  const { inserts, updates } = planHospitalImport(hospitals, existing, { source: 'excel-import', addedBy: user.email });
  for (let i = 0; i < updates.length; i += 10) {
    const results = await Promise.all(updates.slice(i, i + 10).map(({ agency_key, ...change }) => supabase.from('hospitals').update(change).eq('agency_key', agency_key)));
    const failed = results.find((r) => r.error);
    if (failed) return Response.json({ ok: false, error: failed.error.message }, { status: 500 });
  }
  if (inserts.length) {
    const { error } = await supabase.from('hospitals').insert(inserts);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, added: inserts.length, updated: updates.length });
}

export const GET = handled(handleGET);
export const POST = handled(handlePOST);
export const PATCH = handled(handlePATCH);
export const PUT = handled(handlePUT);
