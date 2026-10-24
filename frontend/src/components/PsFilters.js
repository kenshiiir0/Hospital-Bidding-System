'use client';

import { useMemo, useState } from 'react';
import { CustomSelect, DateRangeDropdown, SearchPill, SegmentedTabs } from '@/components/FilterControls';
import { usePsPhilgeps } from '@/lib/psContext';

// Filters for a PS-PhilGEPS list (used with the search box from the layout):
// - selects: [{ label, column }] picks one value of a PhilGEPS column (options = the values in the list),
//   or [{ label, options, valuesOf(row) }] for values that aren't a column (e.g. our products);
//   tabs: true shows that one as a row of pill tabs with counts instead of a dropdown,
// - dates: [{ label, column }] from / to ranges on date columns ("22-Oct-2026 12:00 AM", "28-Sep-2026"),
// - sorts: [{ label, column, kind: 'date' | 'number', dir: 'asc' | 'desc' }], the first is the default.
// Returns { apply(rows), bar, chosen } where bar is the filter rows to show above the list and chosen the
// selected value of each select, by label ('' or missing = All).
// headTabs: tabs of the page itself (e.g. Our products / All) shown first in the tabs row (tier 1).
// The bar: tier 1 = tabs; tier 2 = the search (from the PS-PhilGEPS layout), dropdowns, Sort and one Date range.
export function usePsFilters(list, { selects = [], dates = [], sorts = [], headTabs = null }) {
  const { search = '', setSearch } = usePsPhilgeps() || {};
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
  // Two-column phone grid: with an odd number of dropdowns (sort included) the last one spans the row
  const dropdowns = selects.map((s, n) => (s.tabs ? null : n)).filter((n) => n !== null);
  const spanLast = (dropdowns.length + (sorts.length ? 1 : 0)) % 2 === 1;
  const lastDropdown = sorts.length ? -1 : dropdowns.at(-1);

  const tabSelects = selects.map((s, n) => (s.tabs ? n : null)).filter((n) => n !== null);
  const bar = list ? (
    <div className="space-y-3">
      {/* Tier 1: tabs */}
      {(headTabs || tabSelects.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {headTabs}
          {tabSelects.map((n) => (
            <SegmentedTabs
              key={selects[n].label}
              label={selects[n].label}
              value={chosen[selects[n].label] || ''}
              onChange={(v) => choose(selects[n].label, v)}
              options={[{ value: '', label: 'All', count: total }, ...options[n]]}
            />
          ))}
        </div>
      )}
      {/* Tier 2: search, dropdowns, Sort, Date range. Phones: an even two-column grid (a lone last dropdown
          spans the row; search and Date range get their own rows) */}
      <div className="grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:items-center">
        {setSearch && <SearchPill className="col-span-2" value={search} onChange={setSearch} label="Search PS-PhilGEPS" />}
        {selects.map((s, n) =>
          s.tabs ? null : (
            <CustomSelect
              key={s.label}
              label={s.label}
              value={chosen[s.label] || ''}
              onChange={(v) => choose(s.label, v)}
              options={[{ value: '', label: 'All' }, ...options[n]]}
              className={`w-full sm:w-auto sm:max-w-[18rem] ${spanLast && n === lastDropdown ? 'col-span-2' : ''}`}
            />
          )
        )}
        {sorts.length > 0 && (
          <CustomSelect
            label="Sort"
            value={sortIndex}
            defaultValue={0}
            onChange={setSortIndex}
            options={sorts.map((s, i) => ({ value: i, label: s.label }))}
            className={`w-full sm:w-auto ${spanLast ? 'col-span-2 sm:col-auto' : ''}`}
          />
        )}
        {dates.length > 0 && (
          <DateRangeDropdown
            className="col-span-2 w-full sm:col-auto sm:w-auto"
            fields={dates.map((d) => ({ key: d.label, label: d.label }))}
            ranges={ranges}
            onChange={(key, range) => setRanges((r) => ({ ...r, [key]: range }))}
          />
        )}
        {active && (
          <button
            type="button"
            onClick={() => {
              setChosen({});
              setRanges({});
            }}
            className="col-span-2 rounded-full px-3 py-1.5 text-xs font-medium text-[#12769F] hover:bg-[#1EA0DA]/6 sm:col-auto"
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

// "22-Oct-2026 12:00 AM" / "28-Sep-2026" -> "2026-10-22", the format DatePicker gives
function isoDay(text = '') {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(text);
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
}
