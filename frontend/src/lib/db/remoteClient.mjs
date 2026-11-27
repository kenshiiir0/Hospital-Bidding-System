// A database client with Supabase's interface (db.from('t').select().eq()...) whose queries run on the dashboard's
// server (/api/data, app/api/data/route.js) instead of reaching the database itself. Used where the database can't
// or shouldn't be reached directly:
// - the pages (lib/supabase.js, NEXT_PUBLIC_DATA_VIA_SERVER=1), signed in as the person,
// - programs outside the server (office log-in laptop, GitHub jobs: db/index.mjs DATA_BACKEND=dashboard), with
//   CRON_SECRET. The private database then stays closed to the internet.
// The query is written down step by step and sent when it is awaited; the server checks it against its rules.
// Plain .mjs without imports so the browser, the server and tools/ (CommonJS, via import()) can all use it.

const STEPS = ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
  'filter', 'match', 'not', 'or', 'order', 'limit', 'range', 'single', 'maybeSingle'];

const failure = (message, status = 0, code = '') => ({ data: null, error: { message, code, details: null, hint: null }, count: null, status, statusText: '' });

// The server's answer as Supabase's client hands it over: { data, error, count, status }
export async function readAnswer(res) {
  const body = await res.json().catch(() => null);
  if (body && 'data' in body) return { data: body.data, error: body.error, count: body.count, status: body.status ?? res.status, statusText: res.statusText };
  return failure(body?.error || `The server answered ${res.status}.`, res.status, String(res.status));
}

class RemoteQuery {
  constructor(send, table) {
    this.send = send;
    this.table = table;
    this.steps = [];
    this.throws = false;
    this.signal = undefined;
  }
  throwOnError() {
    this.throws = true;
    return this;
  }
  abortSignal(signal) {
    this.signal = signal;
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.send({ table: this.table, steps: this.steps }, this.signal))
      .catch((e) => failure(e.message))
      .then((result) => {
        if (this.throws && result.error) throw Object.assign(new Error(result.error.message), result.error);
        return result;
      })
      .then(resolve, reject);
  }
  catch(reject) {
    return this.then(undefined, reject);
  }
}
for (const name of STEPS) {
  RemoteQuery.prototype[name] = function step(...args) {
    this.steps.push([name, ...args]);
    return this;
  };
}

// send({ table, steps }, signal) -> Promise<{ data, error, count, status }>
export function createRemoteClient(send) {
  return {
    remote: true,
    from: (table) => new RemoteQuery(send, table),
    rpc: async () => failure('rpc() is not available through the dashboard.'),
  };
}
