'use client';

import { useMemo, useState } from 'react';
import { CustomSelect, DateRangePill, SegmentedTabs } from '@/components/FilterControls';

// Filters for a PS-PhilGEPS list (used with the search box from the layout):
// - selects: [{ label, column }] picks one value of a PhilGEPS column (options = the values in the list),
//   or [{ label, options, valuesOf(row) }] for values that aren't a column (e.g. our products);
//   tabs: true shows that one as a row of pill tabs with counts instead of a dropdown,
// - dates: [{ label, column }] from / to ranges on date columns ("22-Oct-2026 12:00 AM", "28-Sep-2026"),
// - sorts: [{ label, column, kind: 'date' | 'number', dir: 'asc' | 'desc' }], the first is the default.
// Returns { apply(rows), bar, chosen } where bar is the filter rows to show above the list and chosen the
// selected value of each select, by label ('' or missing = All).
export function usePsFilters(list, { selects = [], dates = [], sorts = [] }) {
  const [chosen, setChosen] = useState({});
  const [ranges, setRanges] = useState({});
  const [sortIndex, setSortIndex] = useState(0);

  const col = (name) => list?.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase()) ?? -1;
  const valuesOf = (s, row) => (s.valuesOf ? s.valuesOf(row) : [row.cells[col(s.column)]].filter(Boolean));

  // Options = the values present in the list, most common first, each with how many rows have it
  const options = useMemo(
    () =>
      selects.map((s) => {
        const counts = {};
        for (const row of list?.rows || []) for (const v of valuesOf(s, row)) counts[v] = (counts[v] || 0) + 1;
        const values = s.options || Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        return values.map((v) => ({ value: v, label: v, count: counts[v] || 0 }));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selects is a constant per page
    [list]
  );

  const apply = (rows) => {
    let out = rows.filter(
      (row) =>
        selects.every((s) => !chosen[s.label] || valuesOf(s, row).includes(chosen[s.label])) &&
        dates.every((d) => {
          const { from, to } = ranges[d.label] || {};
          if (!from && !to) return true;
          const day = isoDay(row.cells[col(d.column)]);
          return day && (!from || day >= from) && (!to || day <= to);
        })
    );
    const sort = sorts[sortIndex];
    if (sort) {
      const i = col(sort.column);
      const key = (row) => (sort.kind === 'number' ? Number(String(row.cells[i]).replace(/[^\d.]/g, '')) || 0 : isoDay(row.cells[i]) || '');
      out = [...out].sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        const order = x < y ? -1 : x > y ? 1 : 0;
        return sort.dir === 'desc' ? -order : order;
      });
    }
    return out;
  };

  const choose = (label, value) => setChosen((c) => ({ ...c, [label]: value }));
  const active = Object.values(chosen).some(Boolean) || Object.values(ranges).some((r) => r.from || r.to);
  const total = list?.rows.length || 0;

  const bar = list ? (
    <div className="space-y-3">
      {selects.map((s, n) =>
        s.tabs ? (
          <SegmentedTabs
            key={s.label}
            label={s.label}
            value={chosen[s.label] || ''}
            onChange={(v) => choose(s.label, v)}
            options={[{ value: '', label: 'All', count: total }, ...options[n]]}
          />
        ) : null
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        {selects.map((s, n) =>
          s.tabs ? null : (
            <CustomSelect
              key={s.label}
              label={s.label}
              value={chosen[s.label] || ''}
              onChange={(v) => choose(s.label, v)}
              options={[{ value: '', label: 'All' }, ...options[n]]}
              className="max-w-[18rem]"
            />
          )
        )}
        {dates.map((d) => (
          <DateRangePill
            key={d.label}
            label={d.label}
            from={ranges[d.label]?.from || ''}
            to={ranges[d.label]?.to || ''}
            onFrom={(from) => setRanges((r) => ({ ...r, [d.label]: { ...r[d.label], from } }))}
            onTo={(to) => setRanges((r) => ({ ...r, [d.label]: { ...r[d.label], to } }))}
          />
        ))}
        {sorts.length > 0 && (
          <CustomSelect
            label="Sort"
            value={sortIndex}
            defaultValue={0}
            onChange={setSortIndex}
            options={sorts.map((s, i) => ({ value: i, label: s.label }))}
          />
        )}
        {active && (
          <button
            type="button"
            onClick={() => {
              setChosen({});
              setRanges({});
            }}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-[#12769F] hover:bg-[#1EA0DA]/6"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  ) : null;

  return { apply, bar, chosen };
}


const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "22-Oct-2026 12:00 AM" / "28-Sep-2026" -> "2026-10-22", comparable with <input type="date"> values
function isoDay(text = '') {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
}
