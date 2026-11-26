import pg from 'pg';

// A database client with the same interface as Supabase's (supabase.from('t').select().eq()...), for a plain
// PostgreSQL without Supabase's API in front of it (the private Coolify server). It answers like Supabase's API
// (PostgREST) does, so the code using it doesn't change:
// - dates as "2026-11-26T06:26:35.123456+00:00", bigint and numeric as numbers, json as objects
// - a read without range/limit returns at most 1000 rows (Supabase's max rows), range() is inclusive
// - { data, error, count, status } and never throws; single() / maybeSingle() like Supabase (code PGRST116)
// - update and delete need a filter (Supabase refuses them without one too)
// Only the parts this project uses: select (columns, aliases, json paths, count), eq neq gt gte lt lte like
// ilike is in match not or, order, range, limit, single, maybeSingle, insert, upsert, update, delete, rpc.
// Plain .mjs so tools/ (CommonJS) can import() it too. See db/index.mjs for which client the code gets.

const MAX_ROWS = Number(process.env.DB_MAX_ROWS) || 1000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ident = (name) => {
  if (!NAME.test(name)) throw new DbError(`Not a valid name: ${name}`, '42602');
  return `"${name}"`;
};
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

class DbError extends Error {
  constructor(message, code = '', details = null, hint = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}
// A missing table is PGRST205 from Supabase's API (42P01 from the database itself)
const asError = (e) => ({ message: e.message, code: e.code === '42P01' ? 'PGRST205' : e.code || '', details: e.detail ?? e.details ?? null, hint: e.hint ?? null });

// "details->documents", "job->>id", "items->0" → SQL, and the key PostgREST names it by (the last part)
function columnExpr(expr) {
  const m = String(expr).trim().match(/^([A-Za-z_][A-Za-z0-9_]*)((?:->>?[A-Za-z0-9_]+)*)$/);
  if (!m) throw new DbError(`Not a valid column: ${expr}`, '42703');
  let sql = ident(m[1]);
  let key = m[1];
  for (const [, arrow, part] of m[2].matchAll(/(->>?)([A-Za-z0-9_]+)/g)) {
    sql += arrow + (/^\d+$/.test(part) ? part : literal(part));
    key = part;
  }
  return { sql, key };
}

// select('*'), select('a, b'), select('jid:job->>id, details->documents')
function selectList(columns) {
  const items = String(columns || '*').split(',').map((s) => s.trim()).filter(Boolean);
  return items
    .map((item) => {
      if (item === '*') return '*';
      const alias = item.match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/);
      const { sql, key } = columnExpr(alias ? alias[2] : item);
      const name = alias ? alias[1] : key;
      return sql === ident(name) ? sql : `${sql} AS ${ident(name)}`;
    })
    .join(', ');
}

const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

// One condition as SQL. add(value) puts a value in the parameters and returns its $n.
function condition(column, op, value, add) {
  const col = columnExpr(column).sql;
  if (op === 'is') {
    const v = value === null || value === 'null' ? 'NULL' : value === true || value === 'true' ? 'TRUE' : value === false || value === 'false' ? 'FALSE' : null;
    if (!v) throw new DbError(`is() takes null, true or false`, '22023');
    return `${col} IS ${v}`;
  }
  if (op === 'in') {
    // .in(col, [..]) or the PostgREST string form "(a,b)" used inside not() / or()
    const list = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    return `${col} = ANY(${add(list)})`;
  }
  if (!OPS[op]) throw new DbError(`Filter "${op}" is not supported here`, '22023');
  // PostgREST lets * stand for % in like patterns
  const v = op === 'like' || op === 'ilike' ? String(value).replace(/\*/g, '%') : value;
  return `${col} ${OPS[op]} ${add(v)}`;
}

// or('closing_date.is.null,closing_date.gt.2026-11-26T00:00:00Z') → one OR group
function orGroup(text, add) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return `(${parts
    .map((part) => {
      const m = part.trim().match(/^([A-Za-z0-9_>-]+)\.(not\.)?([a-z]+)\.(.*)$/s);
      if (!m) throw new DbError(`or(): can't read "${part}"`, 'PGRST100');
      const sql = condition(m[1], m[3], m[4], add);
      return m[2] ? `NOT (${sql})` : sql;
    })
    .join(' OR ')})`;
}

// What PostgREST sends back: timestamps in UTC as "2026-11-26T06:26:35.123456+00:00", bigint and numeric as numbers.
// The database may send another time zone ("2026-11-26 14:26:35.123456+08"): turned into UTC here, keeping the
// microseconds, so it doesn't depend on the server's time zone setting.
export function isoTimestamp(v) {
  const m = v.match(/^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?(?:([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?)?$/);
  if (!m) return v; // infinity, BC dates: as the database wrote them
  const [, y, mo, d, h, mi, sec, frac = '', sign, oh, om = '0', os = '0'] = m;
  if (!sign) return `${y}-${mo}-${d}T${h}:${mi}:${sec}${frac}`; // timestamp without time zone
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60 + Number(os)) * 1000;
  const t = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) - offset);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}${frac}+00:00`;
}
const types = {
  getTypeParser(oid, format) {
    if (oid === 20 || oid === 1700) return (v) => Number(v);
    if (oid === 1184 || oid === 1114) return isoTimestamp;
    if (oid === 1082) return (v) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

export function createPool(url) {
  const { hostname, searchParams } = new URL(url);
  // Coolify's internal database (a host without dots) and localhost speak plain TCP; hosted ones need TLS
  const local = !hostname.includes('.') || hostname === 'localhost' || hostname === '127.0.0.1' || searchParams.get('sslmode') === 'disable';
  const pool = new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: Number(process.env.DB_POOL_SIZE) || 5, idleTimeoutMillis: 30_000, types });
  pool.on('error', (e) => console.error(`[db] idle connection: ${e.message}`));
  return pool;
}

// Column types (to send json as json and arrays as arrays) and primary keys (upsert's default target), per table
function tableInfo(pool) {
  const cache = new Map();
  return (table) => {
    if (!cache.has(table)) {
      const loading = Promise.all([
        pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]),
        pool.query(
          `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
           WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
          [`public.${ident(table)}`],
        ),
      ]).then(([cols, keys]) => {
        if (!cols.rows.length) throw new DbError(`relation "public.${table}" does not exist`, '42P01');
        return { types: new Map(cols.rows.map((r) => [r.column_name, r.data_type])), primaryKey: keys.rows.map((r) => r.attname) };
      });
      loading.catch(() => cache.delete(table));
      cache.set(table, loading);
    }
    return cache.get(table);
  };
}

function toParam(value, dataType) {
  if (value === undefined) return null;
  if (value !== null && (dataType === 'json' || dataType === 'jsonb')) return JSON.stringify(value);
  return value;
}

class Query {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.action = 'select';
    this.columns = '*';
    this.returning = false;
    this.filters = [];
    this.orders = [];
    this.limitTo = null;
    this.offset = 0;
    this.one = null;
    this.countMode = null;
    this.headOnly = false;
    this.payload = null;
    this.options = {};
    this.throws = false;
  }

  // --- what to do ---
  select(columns = '*', { count, head } = {}) {
    this.columns = columns;
    if (this.action === 'select') {
      this.countMode = count || null;
      this.headOnly = Boolean(head);
    } else this.returning = true;
    return this;
  }
  insert(rows, options = {}) {
    return this.#write('insert', rows, options);
  }
  upsert(rows, options = {}) {
    return this.#write('upsert', rows, options);
  }
  update(values, options = {}) {
    return this.#write('update', values, options);
  }
  delete(options = {}) {
    return this.#write('delete', null, options);
  }
  #write(action, payload, options) {
    this.action = action;
    this.payload = payload;
    this.options = options;
    this.countMode = options.count || null;
    return this;
  }

  // --- filters ---
  #filter(column, op, value) {
    this.filters.push((add) => condition(column, op, value, add));
    return this;
  }
  eq(c, v) {
    return this.#filter(c, 'eq', v);
  }
  neq(c, v) {
    return this.#filter(c, 'neq', v);
  }
  gt(c, v) {
    return this.#filter(c, 'gt', v);
  }
  gte(c, v) {
    return this.#filter(c, 'gte', v);
  }
  lt(c, v) {
    return this.#filter(c, 'lt', v);
  }
  lte(c, v) {
    return this.#filter(c, 'lte', v);
  }
  like(c, v) {
    return this.#filter(c, 'like', v);
  }
  ilike(c, v) {
    return this.#filter(c, 'ilike', v);
  }
  is(c, v) {
    return this.#filter(c, 'is', v);
  }
  in(c, v) {
    return this.#filter(c, 'in', v);
  }
  filter(c, op, v) {
    return op.startsWith('not.') ? this.not(c, op.slice(4), v) : this.#filter(c, op, v);
  }
  match(values) {
    for (const [c, v] of Object.entries(values)) this.eq(c, v);
    return this;
  }
  not(column, op, value) {
    this.filters.push((add) => {
      if (op === 'is') return condition(column, 'is', value, add).replace(/ IS /, ' IS NOT ');
      return `NOT (${condition(column, op, value, add)})`;
    });
    return this;
  }
  or(text) {
    this.filters.push((add) => orGroup(text, add));
    return this;
  }

  // --- shape of the answer ---
  order(column, { ascending = true, nullsFirst } = {}) {
    const nulls = nullsFirst === undefined ? '' : nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
    // Worked out when the query runs, so a wrong name comes back as { error } like Supabase, never as a throw
    this.orders.push(() => `${columnExpr(column).sql} ${ascending ? 'ASC' : 'DESC'}${nulls}`);
    return this;
  }
  limit(n) {
    this.limitTo = n;
    return this;
  }
  range(from, to) {
    this.offset = from;
    this.limitTo = to - from + 1;
    return this;
  }
  single() {
    this.one = 'single';
    return this;
  }
  maybeSingle() {
    this.one = 'maybe';
    return this;
  }
  throwOnError() {
    this.throws = true;
    return this;
  }

  then(resolve, reject) {
    return this.#run().then((result) => {
      if (this.throws && result.error) throw Object.assign(new Error(result.error.message), result.error);
      return result;
    }).then(resolve, reject);
  }
  catch(reject) {
    return this.then(undefined, reject);
  }

  async #run() {
    try {
      return await this.#execute();
    } catch (e) {
      return { data: null, error: asError(e), count: null, status: e.code === 'PGRST116' ? 406 : 400, statusText: 'Bad Request' };
    }
  }

  async #execute() {
    const params = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const table = ident(this.table);
    const where = () => {
      const parts = this.filters.map((f) => f(add));
      return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
    };
    const pool = this.client.pool;

    if (this.action === 'select') {
      const whereSql = where();
      let count = null;
      if (this.countMode) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}${whereSql}`, params);
        count = rows[0].n;
        if (this.headOnly) return { data: null, error: null, count, status: 200, statusText: 'OK' };
      }
      const limit = Math.min(this.limitTo ?? MAX_ROWS, MAX_ROWS);
      const orderSql = this.orders.length ? ` ORDER BY ${this.orders.map((o) => o()).join(', ')}` : '';
      const sql = `SELECT ${selectList(this.columns)} FROM ${table}${whereSql}${orderSql} LIMIT ${Number(limit)}${this.offset ? ` OFFSET ${Number(this.offset)}` : ''}`;
      const { rows } = await pool.query(sql, params);
      return this.#answer(rows, count, 200);
    }

    const info = await this.client.tableInfo(this.table);
    const returning = this.returning ? ` RETURNING ${selectList(this.columns)}` : '';

    if (this.action === 'delete' || this.action === 'update') {
      if (!this.filters.length) throw new DbError(`${this.action.toUpperCase()} requires a WHERE clause`, '21000');
      if (this.action === 'delete') {
        const result = await pool.query(`DELETE FROM ${table}${where()}${returning}`, params);
        return this.#answer(this.returning ? result.rows : null, this.countMode ? result.rowCount : null, this.returning ? 200 : 204);
      }
      const entries = Object.entries(this.payload || {}).filter(([, v]) => v !== undefined);
      if (!entries.length) throw new DbError('Nothing to update', 'PGRST100');
      const set = entries.map(([c, v]) => `${ident(c)} = ${add(toParam(v, info.types.get(c)))}`).join(', ');
      const result = await pool.query(`UPDATE ${table} SET ${set}${where()}${returning}`, params);
      return this.#answer(this.returning ? result.rows : null, this.countMode ? result.rowCount : null, this.returning ? 200 : 204);
    }

    // insert / upsert: one object or a list; the columns are all keys seen (missing ones are null, as Supabase does)
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
    if (!rows.length) return this.#answer(this.returning ? [] : null, null, 201);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const fill = this.options.defaultToNull === false ? 'DEFAULT' : 'NULL';
    const values = rows
      .map((r) => `(${columns.map((c) => (c in r && r[c] !== undefined ? add(toParam(r[c], info.types.get(c))) : fill)).join(', ')})`)
      .join(', ');
    let sql = `INSERT INTO ${table} (${columns.map(ident).join(', ')}) VALUES ${values}`;
    if (this.action === 'upsert') {
      const target = this.options.onConflict ? String(this.options.onConflict).split(',').map((s) => s.trim()) : info.primaryKey;
      if (!target.length) throw new DbError(`No conflict target for ${this.table}`, '42P10');
      const updates = columns.filter((c) => !target.includes(c));
      sql += ` ON CONFLICT (${target.map(ident).join(', ')}) `;
      sql += this.options.ignoreDuplicates || !updates.length ? 'DO NOTHING' : `DO UPDATE SET ${updates.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
    }
    const result = await pool.query(sql + returning, params);
    return this.#answer(this.returning ? result.rows : null, this.countMode ? result.rowCount : null, 201);
  }

  #answer(rows, count, status) {
    if (this.one && rows) {
      if (rows.length === 1) return { data: rows[0], error: null, count, status, statusText: 'OK' };
      if (rows.length === 0 && this.one === 'maybe') return { data: null, error: null, count, status, statusText: 'OK' };
      const error = new DbError('JSON object requested, multiple (or no) rows returned', 'PGRST116', `The result contains ${rows.length} rows`);
      return { data: null, error: asError(error), count, status: 406, statusText: 'Not Acceptable' };
    }
    return { data: rows, error: null, count, status, statusText: 'OK' };
  }
}

export function createPgClient(pool) {
  const client = {
    pool,
    tableInfo: tableInfo(pool),
    from: (table) => new Query(client, table),
    // rpc('fn', { a: 1 }): calls a database function with named arguments, returns its value (as Supabase does)
    async rpc(fn, args = {}) {
      try {
        const entries = Object.entries(args);
        const values = entries.map(([, v]) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v));
        const sql = `SELECT ${ident(fn)}(${entries.map(([k], i) => `${ident(k)} => $${i + 1}`).join(', ')}) AS r`;
        const { rows } = await pool.query(sql, values);
        return { data: rows[0]?.r ?? null, error: null, status: 200, statusText: 'OK' };
      } catch (e) {
        return { data: null, error: asError(e), status: 400, statusText: 'Bad Request' };
      }
    },
  };
  return client;
}
