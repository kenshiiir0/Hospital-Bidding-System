import { createClient } from '@supabase/supabase-js';

// Our products: table products (the team's PRODUCT LIST plus the dashboard's Add Molecule), the only source
// of what tenders are screened for. Each row's generic name becomes the name matched in tender text:
// "Rocuronium [COLD CHAIN]*" -> Rocuronium, "Cefazolin (as sodium)" -> Cefazolin, "Iodine (as Iohexol)" ->
// Iohexol (a plain "iodine" would also match povidone-iodine), "Sevelamer carbonate*" -> Sevelamer.
// Plain .mjs so the Syncs and the hourly update (no Next imports) use it too.

// Salt and form words after the molecule ("Enoxaparin sodium", "Palonosetron Hydrochloride")
const SALT = String.raw`(?:hydrochloride|hcl|sodium|potassium|carbonate|monohydrate|besilate|besylate|mesylate|citrate|phosphate|acetate|maleate|tartrate|trihydrate|dihydrate)`;
// "(as X)" where X is a salt: dropped. Otherwise X is the molecule itself ("Iodine (as Iohexol)")
const AS_SALT = new RegExp(`^${SALT}(?:\\s+${SALT})*$`, 'i');

// Spelling fixes of names as written in the list
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
    .trim();
  // "+" joins combination products ("Sitagliptin + Metformin"): keep it; salts are only dropped at the end
  s = s.replace(new RegExp(`\\s+${SALT}$`, 'i'), '').trim();
  return NAME_FIXES[s.toLowerCase()] || titleCase(s);
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// (text) -> names of our products the text mentions, e.g. ["Paclitaxel", "Carboplatin"]. Each name or other
// name is a word or phrase; "a + b" requires every part (combination products).
export function buildMatcher(products) {
  const names = [...new Set(products.map((p) => matchName(p.generic_name)).filter(Boolean))];
  const compiled = names.map((name) => {
    const terms = [name.toLowerCase(), ...(OTHER_NAMES[name.toLowerCase()] || [])];
    return {
      name,
      alternatives: terms.map((term) =>
        term.split('+').map((part) => new RegExp(`\\b${escapeRegex(part.trim()).replace(/\s+/g, '[\\s-]+')}\\b`, 'i'))
      ),
    };
  });
  const match = (text) => (text ? compiled.filter(({ alternatives }) => alternatives.some((parts) => parts.every((re) => re.test(text)))).map(({ name }) => name) : []);
  match.names = names;
  return match;
}

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are not set on this server.');
  return createClient(url, process.env.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Every product row, sorted by generic name
export async function loadProducts(supabase = admin()) {
  const { data, error } = await supabase.from('products').select('*').order('generic_name').order('brand_name');
  if (error) throw new Error(`Our product list could not be loaded: ${error.message}`);
  return data;
}

// The matcher for our product list. Throws when the list can't be loaded or is empty (never screens against nothing)
export async function loadMatcher(supabase) {
  const products = await loadProducts(supabase);
  if (!products.length) throw new Error('Our product list is empty.');
  return buildMatcher(products);
}
