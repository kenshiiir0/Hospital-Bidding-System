import { createClient } from '@supabase/supabase-js';

// Our products: table products (the B2B price list and the PRODUCT LIST, plus the dashboard's Add Molecule), the
// only source of what tenders are screened for. A tender counts as ours only when it asks for one of our
// molecules IN one of our dosages (user, 2026-10-23: "If the dosage is not correct then do not fetch it"):
// - the name: each row's generic name becomes the name matched in tender text ("Rocuronium [COLD CHAIN]*" ->
//   Rocuronium, "Cefazolin (as sodium)" -> Cefazolin, "Iodine (as Iohexol)" -> Iohexol, since a plain "iodine"
//   would also match povidone-iodine),
// - the dosage: numbers and units compared, not text. A line naming the molecule must state, on it or on the next
//   two lines (table rows wrap), one of our strengths: the same amount ("300 mg"), the same concentration
//   ("6 mg/ml"), or concentration x volume adding up to our amount ("6mg/ml, 50 ml" = 300 mg). g/mg/mcg, IU and
//   %, ml are converted. Products with no usable dosage ("-", "N/A") match by name only.
// Plain .mjs so the Syncs and the hourly update (no Next imports) use it too.

// ---------- names ----------

// Salt and form words after the molecule ("Enoxaparin sodium", "Palonosetron Hydrochloride")
const SALT = String.raw`(?:hydrochloride|hcl|sodium|potassium|carbonate|monohydrate|besilate|besylate|mesylate|citrate|phosphate|acetate|maleate|tartrate|trihydrate|dihydrate)`;
// "(as X)" starting with a salt ("as sodium", "as hydrochloride with arginine"): dropped. Otherwise X is the
// molecule itself ("Iodine (as Iohexol)")
const AS_SALT = new RegExp(`^${SALT}\\b`, 'i');

// Spelling fixes of names as written in the lists
const NAME_FIXES = { cisatractcurium: 'Cisatracurium' };

// Other ways tenders write a product on the list (abbreviations, spellings, shorter names), by matched name.
// Only helpers for products on the list: a product not on the list is never matched.
export const OTHER_NAMES = {
  anastrozole: ['anastrazole'],
  cisatracurium: ['cisatractcurium'],
  'ferrous sulfate': ['ferrous sulphate'],
  fluorouracil: ['5-fu'],
  hydroxyurea: ['hydroxycarbamide'],
  'zoledronic acid': ['zoledronic'],
  'epoetin alfa': ['epoetin', 'erythropoietin'],
  'polymyxin b': ['polymyxin', 'polymixin'],
  'blood transfusion set': ['blood set'],
  'single blood bag': ['blood bag'],
  'intravenous cannula set': ['intravenous cannula', 'iv cannula', 'iv catheter'],
  'intravenous infusion set': ['infusion set', 'iv set', 'macroset', 'microset'],
};

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());

// The name a product's generic name is matched by (and shown as), e.g. "Folic acid (Vitamin B9)" -> "Folic Acid"
export function matchName(generic) {
  let s = String(generic || '')
    .replace(/\*/g, '')
    .replace(/\[[^\]]*\]/g, ' ');
  const as = /\(\s*as\s+([^)]+)\)/i.exec(s);
  if (as && !AS_SALT.test(as[1].trim())) s = as[1];
  s = s
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // "Bupivacaine Hydrochloride in dextrose", "Docetaxel RTU" (ready to use)
    .replace(/\s+(?:in|with)\s+.*$/i, '')
    .replace(/\s+RTU$/i, '');
  // "+" joins combination products ("Sitagliptin + Metformin"); salts are only dropped at the end
  s = s.replace(new RegExp(`\\s+${SALT}$`, 'i'), '').trim();
  return NAME_FIXES[s.toLowerCase()] || titleCase(s);
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- dosages ----------

const UNIT = {
  mcg: ['mg', 0.001], µg: ['mg', 0.001], ug: ['mg', 0.001], mg: ['mg', 1], g: ['mg', 1000], gm: ['mg', 1000], gram: ['mg', 1000], grams: ['mg', 1000],
  iu: ['iu', 1], u: ['iu', 1], unit: ['iu', 1], units: ['iu', 1],
  mcl: ['ml', 0.001], µl: ['ml', 0.001], ml: ['ml', 1], cc: ['ml', 1], l: ['ml', 1000],
  '%': ['%', 1],
};
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|\.\d+)`;
const UNITS = String.raw`(mcg|µg|ug|mg|grams?|gm|g|iu|units?|u|mcl|µl|ml|cc|l|%)`;
const AMOUNT = new RegExp(`${NUM}\\s*${UNITS}(?![a-z])`, 'gi');
// "5 mg/ml", "5000 IU / ml", "2 MG/ML", "50 mcg/ ml": an amount per one unit of volume
const PER_UNIT = new RegExp(`${NUM}\\s*${UNITS}\\s*\\/\\s*${UNITS}(?![a-z])`, 'gi');
// "300 mg/50 ml", "20 mcg/80 mcL", "6000 IU/0.6 mL": an amount in a volume
const PER_VOLUME = new RegExp(`${NUM}\\s*${UNITS}\\s*\\/\\s*${NUM}\\s*${UNITS}(?![a-z])`, 'gi');
const GAUGE = /\bG\s?(\d{2})\b|\b(\d{2})\s?G\b|gauge\s*(\d{2})/gi;

const toNumber = (s) => Number(String(s).replace(/,/g, ''));
const norm = (value, unit) => {
  const u = UNIT[unit.toLowerCase()];
  return u ? { value: toNumber(value) * u[1], unit: u[0] } : null;
};
const same = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01;

// Every amount (mg, IU, %, ml), concentration (per ml) and gauge in a text
export function strengthsOf(text) {
  const s = String(text || '');
  const amounts = [];
  const concentrations = [];
  for (const m of s.matchAll(AMOUNT)) {
    const a = norm(m[1], m[2]);
    if (a) amounts.push(a);
  }
  for (const m of s.matchAll(PER_VOLUME)) {
    const a = norm(m[1], m[2]);
    const v = norm(m[3], m[4]);
    if (a && v && v.unit === 'ml' && v.value > 0 && a.unit !== 'ml') concentrations.push({ value: a.value / v.value, unit: `${a.unit}/ml` });
  }
  for (const m of s.matchAll(PER_UNIT)) {
    const a = norm(m[1], m[2]);
    const v = norm('1', m[3]);
    if (a && v && v.unit === 'ml' && a.unit !== 'ml') concentrations.push({ value: a.value / v.value, unit: `${a.unit}/ml` });
  }
  // A concentration and a volume elsewhere on the line: their product is the amount ("6mg/ml ... 50 ml")
  const volumes = amounts.filter((a) => a.unit === 'ml');
  for (const c of concentrations) for (const v of volumes) amounts.push({ value: c.value * v.value, unit: c.unit.split('/')[0], derived: true });
  const gauges = [...s.matchAll(GAUGE)].map((m) => Number(m[1] || m[2] || m[3]));
  return { amounts, concentrations, gauges };
}

// What a product row's dosage requires of a tender line, or null when it has no usable dosage (match by name)
export function dosageOf(product) {
  const pick = (text) => {
    const { amounts, concentrations, gauges } = strengthsOf(text);
    const doses = amounts.filter((a) => a.unit !== 'ml' && !a.derived);
    if (doses.length || concentrations.length) return { doses, concentrations, gauges: [], volumes: [] };
    if (gauges.length) return { doses: [], concentrations: [], gauges, volumes: [] };
    // A supply sold by volume ("450 ML" blood bag)
    const volumes = amounts.filter((a) => a.unit === 'ml');
    if (volumes.length) return { doses: [], concentrations: [], gauges: [], volumes };
    return null;
  };
  // Bleomycin's "15 Units" is in the Dosage Form column ("-" as its strength)
  return pick(product.dosage) || (/\d/.test(product.dosage || '') ? null : pick((product.dosage_form || '').match(/^[\d.,]+\s*\w+/)?.[0] || ''));
}

// Does a tender text (one line plus its next lines) ask for this dosage?
function dosageMatches(dosage, text) {
  const found = strengthsOf(text);
  if (dosage.gauges.length) return dosage.gauges.some((g) => found.gauges.includes(g));
  if (dosage.volumes.length) return dosage.volumes.some((v) => found.amounts.some((a) => a.unit === 'ml' && same(a.value, v.value)));
  return (
    dosage.doses.some((d) => found.amounts.some((a) => a.unit === d.unit && same(a.value, d.value))) ||
    dosage.concentrations.some((c) => found.concentrations.some((f) => f.unit === c.unit && same(f.value, c.value)))
  );
}

// ---------- the matcher ----------

// match(text) -> names of our products the text asks for in one of our dosages, e.g. ["Paclitaxel"]
// match.details(text) -> { matched, named, undosed }: named = our molecules mentioned at all; undosed = named with
//   no dosage given at all (e.g. only in the title), so the tender's documents can be checked for it
// match.line(line, next) -> names one line asks for (next: the following lines, where a wrapped dosage may be)
// match.names: every matched name
export function buildMatcher(products) {
  const byName = new Map();
  for (const p of products) {
    const name = matchName(p.generic_name);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { name, dosages: [], nameOnly: false });
    const dosage = dosageOf(p);
    if (dosage) byName.get(name).dosages.push(dosage);
    else byName.get(name).nameOnly = true;
  }
  const compiled = [...byName.values()].map((entry) => {
    const terms = [entry.name.toLowerCase(), ...(OTHER_NAMES[entry.name.toLowerCase()] || [])];
    return {
      ...entry,
      alternatives: terms.map((term) =>
        term.split('+').map((part) => new RegExp(`\\b${escapeRegex(part.trim()).replace(/\s+/g, '[\\s-]+')}\\b`, 'i'))
      ),
    };
  });
  const names = (text) => compiled.filter(({ alternatives }) => alternatives.some((parts) => parts.every((re) => re.test(text))));

  const line = (text, next = '') => {
    if (!text) return [];
    const window = `${text}\n${next}`;
    return names(text)
      .filter((p) => p.nameOnly || p.dosages.some((d) => dosageMatches(d, window)))
      .map((p) => p.name);
  };
  const details = (text) => {
    const lines = String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const matched = new Set();
    const named = new Set();
    const undosed = new Set();
    lines.forEach((l, i) => {
      const next = lines.slice(i + 1, i + 3).join('\n');
      const window = strengthsOf(`${l}\n${next}`);
      const hasDosage = window.amounts.length || window.concentrations.length || window.gauges.length;
      for (const p of names(l)) {
        named.add(p.name);
        if (!hasDosage) undosed.add(p.name);
      }
      for (const n of line(l, next)) matched.add(n);
    });
    // undosed: named somewhere with no dosage at all near it (e.g. only in the title): the documents may tell
    return { matched: [...matched], named: [...named], undosed: [...undosed].filter((n) => !matched.has(n)) };
  };
  const match = (text) => details(text).matched;
  match.details = details;
  match.line = line;
  match.names = compiled.map((p) => p.name);
  return match;
}

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Every product row, sorted by generic name. Archived products are left out (never screened for) unless
// includeArchived (the Product List page's Archived tab).
export async function loadProducts(supabase = admin(), { includeArchived = false } = {}) {
  let query = supabase.from('products').select('*');
  if (!includeArchived) query = query.is('archived_at', null);
  const { data, error } = await query.order('generic_name').order('brand_name');
  if (error) throw new Error(`Our product list could not be loaded: ${error.message}`);
  return data;
}

// The matcher for our product list. Throws when the list can't be loaded or is empty (never screens against nothing)
export async function loadMatcher(supabase) {
  const products = await loadProducts(supabase);
  if (!products.length) throw new Error('Our product list is empty.');
  return buildMatcher(products);
}
