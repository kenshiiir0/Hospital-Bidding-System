import { requireUser } from '@/lib/auth';
import { serverDb } from '@/lib/db/index.mjs';

// The pages' database reads and writes, for a server without Supabase's API (the private Coolify database).
// The browser (lib/supabase.js with NEXT_PUBLIC_DATA_VIA_SERVER=1) sends the query it would have sent to Supabase
// as a list of steps: { table, steps: [['select', '*'], ['eq', 'id', 1], ['order', 'id', {ascending:false}]] }.
// Here it is checked and run on the server's database client, with the same rules the database gave the
// browser under Supabase (schema.sql): signed-in team members read these tables, and may only add/edit hospitals
// and add/remove Screened Tenders. Everything else (Syncs, updates, products, ...) goes through its own API route.

const READ = new Set([
  'philgeps_opportunities', 'activity_log', 'ps_philgeps_snapshot', 'ps_sync_status', 'ps_tender_analysis', 'hospitals',
  'hospital_postings', 'products', 'award_notifications', 'screened_tenders', 'ocr_status', 'bid_abstracts',
  'abstract_tracker', 'abstract_tracker_items', 'abstract_tracker_molecules',
]);
const WRITE = { hospitals: new Set(['insert', 'update', 'upsert']), screened_tenders: new Set(['insert', 'delete', 'upsert']) };

const ACTIONS = new Set(['select', 'insert', 'upsert', 'update', 'delete']);
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'filter', 'match', 'not', 'or']);
const SHAPE = new Set(['order', 'limit', 'range', 'single', 'maybeSingle']);
const MAX_STEPS = 40;

const isText = (v) => typeof v === 'string' && v.length <= 20_000;
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Only the options these steps really take (no referencedTable / foreignTable: those reach other tables)
const pick = (o, keys) => (plain(o) ? Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : undefined);

// Checks the steps; returns { action, steps } with cleaned arguments, or { error }
function check(table, steps) {
  if (!READ.has(table)) return { error: `The table "${table}" can't be read from the pages.` };
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return { error: 'No query.' };
  let action = null;
  const out = [];
  for (const step of steps) {
    if (!Array.isArray(step) || !isText(step[0])) return { error: 'Bad query step.' };
    const [name, ...args] = step;
    if (ACTIONS.has(name)) {
      // select() after a write only asks for the written rows back
      if (name === 'select') {
        // "(" would embed another table (PostgREST resource embedding), which could read past these rules
        if (args[0] !== undefined && (!isText(args[0]) || args[0].includes('('))) return { error: 'Bad column list.' };
        out.push([name, args[0] ?? '*', action ? undefined : pick(args[1], ['count', 'head'])]);
        action ||= 'select';
        continue;
      }
      if (action) return { error: 'One action per query.' };
      action = name;
      if (!(WRITE[table] && WRITE[table].has(name))) return { error: `The pages can't ${name} in "${table}".` };
      if (name === 'delete') out.push([name]);
      else {
        const rows = args[0];
        if (!(plain(rows) || (Array.isArray(rows) && rows.length <= 500 && rows.every(plain)))) return { error: 'Bad rows.' };
        const options = name === 'upsert' ? pick(args[1], ['onConflict', 'ignoreDuplicates']) : undefined;
        // Screened Tenders may be added but never changed: an upsert there must skip rows that already exist
        if (name === 'upsert' && table === 'screened_tenders' && !options?.ignoreDuplicates) return { error: `The pages can't update "${table}".` };
        if (options?.onConflict !== undefined && !isText(options.onConflict)) return { error: 'Bad onConflict.' };
        out.push(options ? [name, rows, options] : [name, rows]);
      }
      continue;
    }
    if (FILTERS.has(name)) {
      if (name === 'or') {
        if (!isText(args[0])) return { error: 'Bad or().' };
        out.push([name, args[0]]);
      } else if (name === 'match') {
        if (!plain(args[0])) return { error: 'Bad match().' };
        out.push([name, args[0]]);
      } else {
        if (!isText(args[0]) || (name !== 'filter' && name !== 'not' && args.length > 2)) return { error: `Bad ${name}().` };
        if ((name === 'filter' || name === 'not') && !isText(args[1])) return { error: `Bad ${name}().` };
        out.push([name, ...args.slice(0, name === 'filter' || name === 'not' ? 3 : 2)]);
      }
      continue;
    }
    if (SHAPE.has(name)) {
      if (name === 'order') {
        if (!isText(args[0])) return { error: 'Bad order().' };
        out.push([name, args[0], pick(args[1], ['ascending', 'nullsFirst'])]);
      } else if (name === 'limit') {
        if (!Number.isInteger(args[0]) || args[0] < 0) return { error: 'Bad limit().' };
        out.push([name, args[0]]);
      } else if (name === 'range') {
        if (!Number.isInteger(args[0]) || !Number.isInteger(args[1]) || args[0] < 0 || args[1] < args[0]) return { error: 'Bad range().' };
        out.push([name, args[0], args[1]]);
      } else out.push([name]);
      continue;
    }
    return { error: `"${name}" is not allowed here.` };
  }
  if (!action) return { error: 'No select, insert, update or delete.' };
  if ((action === 'update' || action === 'delete') && !out.some(([n]) => FILTERS.has(n))) return { error: `${action} needs a filter.` };
  return { action, steps: out };
}

const failed = (message, status = 400) => Response.json({ data: null, error: { message, code: 'DATA_ROUTE', details: null, hint: null }, count: null, status }, { status });

export async function POST(request) {
  const { response } = await requireUser(request);
  if (response) return response;
  const body = await request.json().catch(() => null);
  if (!plain(body)) return failed('Bad request.');
  const checked = check(body.table, body.steps);
  if (checked.error) return failed(checked.error);
  const db = serverDb();
  if (!db) return failed('The database settings are missing on the server.', 500);

  let query = db.from(body.table);
  for (const [name, ...args] of checked.steps) {
    while (args.length && args.at(-1) === undefined) args.pop();
    query = query[name](...args);
  }
  const result = await query;
  // Sent back as Supabase's client would hand it to the page (the page reads data/error/count)
  const error = result.error ? { message: result.error.message, code: result.error.code || '', details: result.error.details ?? null, hint: result.error.hint ?? null } : null;
  return Response.json({ data: result.data ?? null, error, count: result.count ?? null, status: result.status ?? 200 });
}
