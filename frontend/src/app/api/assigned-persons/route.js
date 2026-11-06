import { requireUser } from '@/lib/auth';
import { defaultRows } from '@/lib/awardRouting.mjs';
import { createClient } from '@supabase/supabase-js';

// Assigned Persons (tables assigned_people, assigned_hospitals): who handles each hospital on the served list. The
// award notice emails go by the same tables (lib/awardRouting.mjs loadRouting), so an edit here changes who is
// emailed from the next Sync on. Team members only.

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// "Maria Santos" -> "maria-santos"
const slug = (name) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'person';

async function readAll(supabase) {
  const [p, h] = await Promise.all([
    supabase.from('assigned_people').select('key, name, email, backup').order('name'),
    supabase.from('assigned_hospitals').select('no, name, rep, aliases, updated_by, updated_at').order('no'),
  ]);
  if (p.error || h.error) throw new Error((p.error || h.error).message);
  return { people: p.data, hospitals: h.data };
}

// { people: [{key, name, email, backup}], hospitals: [{no, name, rep, aliases}] }. The first time (tables empty) they
// are filled from the list in awardRouting.mjs.
export async function GET(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const supabase = admin();
  try {
    let list = await readAll(supabase);
    if (!list.people.length) {
      const seed = defaultRows();
      const p = await supabase.from('assigned_people').upsert(seed.people, { onConflict: 'key', ignoreDuplicates: true });
      if (p.error) throw new Error(p.error.message);
      const h = await supabase.from('assigned_hospitals').upsert(seed.hospitals, { onConflict: 'no', ignoreDuplicates: true });
      if (h.error) throw new Error(h.error.message);
      list = await readAll(supabase);
    }
    return Response.json(list);
  } catch (e) {
    // Tables not created yet (schema.sql not applied): show the built-in list, editing waits for the tables
    if (/does not exist|schema cache/i.test(e.message)) return Response.json({ ...defaultRows(), setupNeeded: true });
    return fail(`Could not read the assigned persons: ${e.message}`, 500);
  }
}

// Hospital fields from the form: { no, name, rep, aliases: [..] | "a, b" }
function hospitalFrom(body) {
  const no = Number(body.no);
  const name = clean(body.name);
  const aliases = (Array.isArray(body.aliases) ? body.aliases : String(body.aliases ?? '').split(/[,;\n]/))
    .map((a) => clean(a))
    .filter(Boolean)
    .slice(0, 10);
  if (!Number.isInteger(no) || no < 1 || no > 9999) return { error: 'The No. must be a whole number (1 or more).' };
  if (!name) return { error: 'Please fill in the Hospital name.' };
  if (typeof body.rep !== 'string' || !body.rep) return { error: 'Please choose the Assigned Person.' };
  return { hospital: { no, name, rep: body.rep, aliases } };
}

function personFrom(body) {
  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  if (!name) return { error: 'Please fill in the name.' };
  if (!EMAIL.test(email)) return { error: 'The e-mail address does not look right.' };
  return { person: { name, email, backup: Boolean(body.backup) } };
}

// Add: { kind: 'hospital', no, name, rep, aliases } or { kind: 'person', name, email, backup }
export async function POST(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const supabase = admin();
  const stamp = { updated_by: user.email, updated_at: new Date().toISOString() };

  if (body.kind === 'person') {
    const { person, error } = personFrom(body);
    if (error) return fail(error);
    const { data: people, error: readError } = await supabase.from('assigned_people').select('key, email');
    if (readError) return fail(readError.message, 500);
    if (people.some((p) => p.email === person.email)) return fail(`${person.email} is already on the list.`, 409);
    let key = slug(person.name);
    for (let i = 2; people.some((p) => p.key === key); i++) key = `${slug(person.name)}-${i}`;
    const { data, error: writeError } = await supabase.from('assigned_people').insert({ key, ...person, ...stamp }).select('key, name, email, backup').single();
    if (writeError) return fail(writeError.message, 500);
    return Response.json({ ok: true, person: data }, { status: 201 });
  }

  const { hospital, error } = hospitalFrom(body);
  if (error) return fail(error);
  const { data: taken, error: readError } = await supabase.from('assigned_hospitals').select('no, name').eq('no', hospital.no).maybeSingle();
  if (readError) return fail(readError.message, 500);
  if (taken) return fail(`No. ${hospital.no} is already ${taken.name}. Choose another number.`, 409);
  const { data, error: writeError } = await supabase.from('assigned_hospitals').insert({ ...hospital, ...stamp }).select('no, name, rep, aliases').single();
  if (writeError) return fail(/foreign key/i.test(writeError.message) ? 'That person is no longer on the list.' : writeError.message, 500);
  return Response.json({ ok: true, hospital: data }, { status: 201 });
}

// Edit: { kind: 'hospital', original_no, no, name, rep, aliases } or { kind: 'person', key, name, email, backup }
export async function PATCH(request) {
  const { user, response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const supabase = admin();
  const stamp = { updated_by: user.email, updated_at: new Date().toISOString() };

  if (body.kind === 'person') {
    const { person, error } = personFrom(body);
    if (error) return fail(error);
    const { data: people, error: readError } = await supabase.from('assigned_people').select('key, email, backup');
    if (readError) return fail(readError.message, 500);
    if (people.some((p) => p.key !== body.key && p.email === person.email)) return fail(`${person.email} is already someone else's.`, 409);
    if (!person.backup && !people.some((p) => p.key !== body.key && p.backup)) return fail('Keep at least one back-up: they get the hospitals not on the list.');
    const { data, error: writeError } = await supabase.from('assigned_people').update({ ...person, ...stamp }).eq('key', body.key).select('key, name, email, backup').maybeSingle();
    if (writeError) return fail(writeError.message, 500);
    if (!data) return fail('That person is no longer on the list.', 404);
    return Response.json({ ok: true, person: data });
  }

  const { hospital, error } = hospitalFrom(body);
  if (error) return fail(error);
  const original = Number(body.original_no);
  if (hospital.no !== original) {
    const { data: taken } = await supabase.from('assigned_hospitals').select('name').eq('no', hospital.no).maybeSingle();
    if (taken) return fail(`No. ${hospital.no} is already ${taken.name}. Choose another number.`, 409);
  }
  const { data, error: writeError } = await supabase.from('assigned_hospitals').update({ ...hospital, ...stamp }).eq('no', original).select('no, name, rep, aliases').maybeSingle();
  if (writeError) return fail(writeError.message, 500);
  if (!data) return fail('That hospital is no longer on the list.', 404);
  return Response.json({ ok: true, hospital: data });
}

// Remove: { kind: 'hospital', no } (its tenders then go to the back-ups) or { kind: 'person', key } (only someone
// with no hospitals, and never the last back-up)
export async function DELETE(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => ({}));
  const supabase = admin();

  if (body.kind === 'person') {
    const [{ data: people, error: e1 }, { count, error: e2 }] = await Promise.all([
      supabase.from('assigned_people').select('key, backup'),
      supabase.from('assigned_hospitals').select('no', { count: 'exact', head: true }).eq('rep', body.key),
    ]);
    if (e1 || e2) return fail((e1 || e2).message, 500);
    if (count) return fail(`They still have ${count} hospital${count === 1 ? '' : 's'}. Give them to someone else first.`);
    const me = people.find((p) => p.key === body.key);
    if (!me) return fail('That person is no longer on the list.', 404);
    if (me.backup && !people.some((p) => p.key !== body.key && p.backup)) return fail('Keep at least one back-up: they get the hospitals not on the list.');
    const { error } = await supabase.from('assigned_people').delete().eq('key', body.key);
    if (error) return fail(error.message, 500);
    return Response.json({ ok: true });
  }

  const { data, error } = await supabase.from('assigned_hospitals').delete().eq('no', Number(body.no)).select('no').maybeSingle();
  if (error) return fail(error.message, 500);
  if (!data) return fail('That hospital is no longer on the list.', 404);
  return Response.json({ ok: true });
}
