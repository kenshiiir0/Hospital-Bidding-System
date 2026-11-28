// The asking half of lib/live.js, without the browser client (so tools can test it): every call to ask() looks for
// the table's changes since the last call and hands each changed row to onChange({ new: row }).
const DEFAULT_EVERY_MS = 10_000;
const BATCH = 200;

export function createAsker(client, { table, onChange, since, select = '*', filter = (q) => q, everyMs = DEFAULT_EVERY_MS }) {
  let last = null;
  let started = false;
  let busy = false;
  let lastAsked = 0;
  return {
    everyMs,
    async ask(force = false) {
      if (busy || (!force && Date.now() - lastAsked < everyMs)) return;
      busy = true;
      lastAsked = Date.now();
      try {
        if (since) {
          if (!started) {
            // Where to start: the newest row now (the page has loaded everything up to it)
            const { data, error } = await filter(client.from(table).select(since)).order(since, { ascending: false }).limit(1);
            if (error) return;
            last = data?.[0]?.[since] ?? null;
            started = true;
            return;
          }
          let query = filter(client.from(table).select(select));
          if (last != null) query = query.gt(since, last);
          const { data, error } = await query.order(since, { ascending: true }).limit(BATCH);
          if (error || !data?.length) return;
          last = data[data.length - 1][since] ?? last;
          for (const row of data) onChange({ new: row, eventType: 'UPDATE', table });
          return;
        }
        const { data, error } = await filter(client.from(table).select(select));
        if (error) return;
        const print = JSON.stringify(data);
        if (started && print !== last) for (const row of data || []) onChange({ new: row, eventType: 'UPDATE', table });
        last = print;
        started = true;
      } finally {
        busy = false;
      }
    },
  };
}

