// Dry run: which tender lines would a typo-tolerant name match find that the exact matcher misses?
import { createClient } from '@supabase/supabase-js';
import { loadProducts, matchName, OTHER_NAMES } from './products.mjs';

const s = createClient(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
const products = await loadProducts(s);
const names = [...new Set(products.map((p) => matchName(p.generic_name)))];

// Optimal string alignment distance (insert, delete, replace, swap two neighbours)
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}
const allowed = (len) => (len >= 9 ? 2 : len >= 6 ? 1 : 0);
const words = (text) => text.toLowerCase().replace(/(\d)([a-z])|([a-z])(\d)/g, '$1$3 $2$4').match(/[a-z]+/g) || [];

function fuzzyNames(line) {
  const w = words(line);
  const found = [];
  for (const name of names) {
    const terms = [name.toLowerCase(), ...(OTHER_NAMES[name.toLowerCase()] || [])].filter((t) => !t.includes('+'));
    for (const term of terms) {
      const parts = term.split(/[\s-]+/);
      const max = allowed(term.replace(/[\s-]/g, '').length);
      if (!max) continue;
      for (let i = 0; i + parts.length <= w.length; i++) {
        const got = w.slice(i, i + parts.length).join(' ');
        if (got[0] !== term[0]) continue;
        const dist = distance(got, parts.join(' '), max);
        if (dist > 0 && dist <= max) found.push({ name, got, dist });
      }
      // Split by a stray space ("amlo dipine")
      for (let i = 0; i + parts.length + 1 <= w.length; i++) {
        const got = w.slice(i, i + parts.length + 1).join('');
        if (got[0] !== term[0]) continue;
        const dist = distance(got, parts.join(''), max);
        if (dist <= max && got !== parts.join('')) found.push({ name, got: w.slice(i, i + parts.length + 1).join(' '), dist });
      }
    }
  }
  return found;
}

const { data } = await s.from('philgeps_opportunities').select('ref_no, title, items_text');
const hits = new Map();
for (const t of data) {
  for (const l of `${t.title}\n${t.items_text || ''}`.split('\n')) {
    for (const f of fuzzyNames(l)) {
      const key = `${f.name} <- "${f.got}"`;
      if (!hits.has(key)) hits.set(key, { count: 0, example: l.trim().slice(0, 110) });
      hits.get(key).count++;
    }
  }
}
console.log('tenders scanned', data.length, '| distinct fuzzy spellings', hits.size);
for (const [k, v] of [...hits].sort((a, b) => b[1].count - a[1].count)) console.log(`${v.count}\t${k}\t| ${v.example}`);
