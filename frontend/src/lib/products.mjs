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
  amikacin: ['amikacide'],
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

// ---------- typing errors ----------

// Hospitals misspell names ("Rocorunium", "Epoeitin", "Loratidine", "Suggammadex"), so a word close enough to one
// of our names counts as that name: one wrong, missing, extra or swapped letter in names of 6 to 8 letters, two
// from 9 letters on. Shorter names and names of three words or more must be exact. The first letter must be
// right, the dosage must still match, and a word at least as close to another real medicine (below) is that
// medicine, not ours ("Cefexime" is Cefixime, not Cefepime).
const LOOK_ALIKES = [
  'cefixime', 'cefuroxime', 'cefotaxime', 'ceftazidime', 'ceftriaxone', 'cefalexin', 'cephalexin', 'cefaclor',
  'cefdinir', 'cefpodoxime', 'cefoperazone', 'cefradine', 'cephradine', 'cefadroxil', 'ceftaroline',
  'daunorubicin', 'epirubicin', 'vinblastine', 'vinorelbine', 'cisplatin', 'dacarbazine',
  'desloratadine', 'levocetirizine', 'vecuronium', 'pancuronium', 'heparinoid', 'meropenem', 'imipenem', 'exemestane', 'midodrine', 'metolazone', 'methocarbamol', 'neomycin',
];
const typoLimit = (length) => (length >= 9 ? 2 : length >= 6 ? 1 : 0);

// Edit distance with swapped neighbours counted as one (optimal string alignment); stops early above max
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      next.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    before = row;
    row = next;
  }
  return row[b.length];
}

// The words of a line, letters only, with numbers split off ("Amlodipine5mg" -> amlodipine, mg)
const wordsOf = (text) => String(text).toLowerCase().replace(/(\d)(?=[a-z])|([a-z])(?=\d)/g, '$1$2 ').match(/[a-z]+/g) || [];

// Is `got` (one or more words) a misspelling of `term`, and not closer to another medicine?
function misspelling(got, term) {
  const limit = typoLimit(term.replace(/\s/g, '').length);
  if (!limit || got === term || got[0] !== term[0]) return false;
  const d = editDistance(got, term, limit);
  return d <= limit && !LOOK_ALIKES.some((other) => other !== term && editDistance(got, other, d) <= d);
}

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
  // "125mmg/ml" (a slip in a hospital's list) is 125 mg/ml
  // A scan that lost the slash ("PROPOFOL 10 mg ml.", PS 107166) is 10 mg/ml
  const s = String(text || '')
    .replace(/(\d)\s*mmg(?![a-z])/gi, '$1mg')
    .replace(/(\d\s*(?:mg|mcg|iu))\s+ml\b/gi, '$1/ml');
  const amounts = [];
  const concentrations = [];
  for (const m of s.matchAll(AMOUNT)) {
    const a = norm(m[1], m[2]);
    // "250 mg/mL": 250 mg in each mL (also a concentration, below); not a volume to multiply by
    const perUnit = new RegExp(`^\\s*\\/\\s*${UNITS}(?![a-z])`, 'i').test(s.slice(m.index + m[0].length));
    if (a) amounts.push(perUnit ? { ...a, perUnit: true } : a);
  }
  // perVolume: "250MG/2ML" as written (amount over volume), for hospitals' shorthand (dosageMatches)
  const perVolume = [];
  for (const m of s.matchAll(PER_VOLUME)) {
    const a = norm(m[1], m[2]);
    const v = norm(m[3], m[4]);
    if (a && v && v.unit === 'ml' && v.value > 0 && a.unit !== 'ml') {
      concentrations.push({ value: a.value / v.value, unit: `${a.unit}/ml` });
      perVolume.push({ amount: a.value, unit: a.unit, volume: v.value });
    }
  }
  for (const m of s.matchAll(PER_UNIT)) {
    const a = norm(m[1], m[2]);
    const v = norm('1', m[3]);
    if (a && v && v.unit === 'ml' && a.unit !== 'ml') concentrations.push({ value: a.value / v.value, unit: `${a.unit}/ml` });
  }
  // A concentration and a volume elsewhere on the line: their product is the amount ("6mg/ml ... 50 ml")
  const volumes = amounts.filter((a) => a.unit === 'ml' && !a.perUnit);
  for (const c of concentrations) for (const v of volumes) amounts.push({ value: c.value * v.value, unit: c.unit.split('/')[0], derived: true });
  const gauges = [...s.matchAll(GAUGE)].map((m) => Number(m[1] || m[2] || m[3]));
  return { amounts, concentrations, gauges, perVolume };
}

// What a product row's dosage requires of a tender line, or null when it has no usable dosage (match by name)
export function dosageOf(product) {
  const pick = (text) => {
    const { amounts, concentrations, gauges, perVolume } = strengthsOf(text);
    // Our amounts as written: "500mg" of "100mg/ml (500mg / 5ml)", not the 100 mg of its concentration
    const doses = amounts.filter((a) => a.unit !== 'ml' && !a.derived && !a.perUnit);
    // Our pack volumes: the 5 ml of "1000 IU / ml (25000 IU / 5ml)"
    const packVolumes = perVolume.map((pv) => pv.volume);
    if (doses.length || concentrations.length) return { doses, concentrations, gauges: [], volumes: [], packVolumes };
    if (gauges.length) return { doses: [], concentrations: [], gauges, volumes: [] };
    // A supply sold by volume ("450 ML" blood bag)
    const volumes = amounts.filter((a) => a.unit === 'ml');
    if (volumes.length) return { doses: [], concentrations: [], gauges: [], volumes };
    return null;
  };
  // Bleomycin's "15 Units" is in the Dosage Form column ("-" as its strength)
  const dosage = pick(product.dosage) || (/\d/.test(product.dosage || '') ? null : pick((product.dosage_form || '').match(/^[\d.,]+\s*\w+/)?.[0] || ''));
  // Atracurium's "10mg" on the Product List is 10 mg per mL (user, 2026-10-27), as tenders write it ("10mg/mL, 2.5mL")
  // (in any volume: "2.5mL" and "5mL" ampules)
  if (dosage && PER_ML_AS_AMOUNT.test(product.generic_name || '')) {
    return { ...dosage, concentrations: [...dosage.concentrations, ...dosage.doses.map((d) => ({ value: d.value, unit: `${d.unit}/ml` }))], anyVolume: true };
  }
  // The other way round (user, 2026-10-27): Epoetin's "4000 IU/ml" is 4000 IU a syringe ("4000 IU/0.4 mL"): the
  // amount counts in any volume
  if (dosage && AMOUNT_IN_ANY_VOLUME.test(product.generic_name || '')) {
    return { ...dosage, doses: [...dosage.doses, ...dosage.concentrations.map((c) => ({ value: c.value, unit: c.unit.split('/')[0] }))] };
  }
  return dosage;
}
const PER_ML_AS_AMOUNT = /^atracurium\b/i;
const AMOUNT_IN_ANY_VOLUME = /^epoetin\b/i;

// ---------- dosage forms ----------

// Strict in the form too (user, 2026-10-27: "the folic acid dosage form in ours is tablet but we are fetching not
// tablet"): each row's form from its Dosage Form and Unit, and a tender line that names a form must name ours
const FORMS = {
  tablet: /\b(?:tablets?|tabs?|film[\s-]*coated|caplets?)\b/i,
  capsule: /\b(?:capsules?|caps?)\b/i,
  'oral liquid': /\b(?:syrups?|suspensions?|susp|oral\s+solution|oral\s+drops|drops|elixirs?)\b/i,
  injection: /\b(?:inj\w*|vials?|vl|amp(?:ule|oule)?s?|infusion|pre[\s-]*filled|pfs|syringes?|lyophili[sz]ed|i\.?v\.?|i\.?m\.?|s\.?c\.?|intrathecal|emulsion\s+for)\b/i,
  topical: /\b(?:creams?|ointments?|gels?|lotions?)\b/i,
  inhalation: /\b(?:nebules?|inhalers?|inhalation|respules?)\b/i,
  sachet: /\b(?:sachets?)\b/i,
};
const formsIn = (text) => new Set(Object.entries(FORMS).filter(([, re]) => re.test(text || '')).map(([form]) => form));

/** A product row's forms ("Film-coated Tablet" -> tablet), none when its Dosage Form and Unit don't say */
export function formsOf(product) {
  return formsIn(`${product.dosage_form || ''} ${product.unit || ''}`);
}

// Kinds of a form a line asks for that only a product stated that way fits: our Loratadine is a plain "Tablet", so
// "Loratadine 10 mg Chewable Tablet" is not ours (user, 2026-10-27: "Do not include if not stated as chewable")
const SPECIAL_KINDS = { chewable: /\bchew(?:able)?s?\b/i };
const specialKinds = (text) => Object.keys(SPECIAL_KINDS).filter((kind) => SPECIAL_KINDS[kind].test(text || ''));
/** The special kinds our product row states (generic name, dosage, Dosage Form, Unit) */
export const kindsOf = (product) => new Set(specialKinds(`${product.generic_name || ''} ${product.dosage || ''} ${product.dosage_form || ''} ${product.unit || ''}`));

// A product "in" something is matched by the strength our Product List gives, nothing more: Bupidex "Bupivacaine
// Hydrochloride in dextrose" is 5mg/mL (0.5%), so "0.5%, 5ML ISOBARIC" is ours and "0.5%, 4ML W/ 8% DEXTROSE HEAVY"
// is not (user, 2026-10-27: "The 8% is the wrong one. Check the product list"; PhilGEPS 13309076).
// -> test(own part of a line): true when it asks for a percent strength that isn't ours; null for other products
const PERCENT = /(\d+(?:\.\d+)?)\s*%/g;
export function otherStrengthOf(product) {
  if (!/\bin\s+[a-z]+/i.test(String(product.generic_name || '').replace(/\(.*?\)/g, ' '))) return null;
  const ours = new Set([...String(product.dosage || '').matchAll(PERCENT)].map((m) => Number(m[1])));
  return (text) => [...String(text || '').matchAll(PERCENT)].some((m) => !ours.has(Number(m[1])));
}

// A tender text naming no form fits any; one naming forms fits when one of them is ours ("tablet/capsule" fits a tablet)
function formMatches(forms, text) {
  if (!forms?.size) return true;
  const named = formsIn(text);
  return !named.size || [...named].some((form) => forms.has(form));
}

// Does a tender text (one line plus its next lines) ask for this dosage?
function dosageMatches(dosage, text) {
  const found = strengthsOf(text);
  if (dosage.gauges.length) return dosage.gauges.some((g) => found.gauges.includes(g));
  // A row with only a volume ("450 ML" blood bag, Methotrexate "10ml"): that volume, and no strength on the line
  // ("METHOTREXATE 100 mg/mL, 10 mL" is a strength, not ours; PhilGEPS 13309534)
  if (dosage.volumes.length) {
    const strength = found.amounts.some((a) => a.unit !== 'ml') || found.concentrations.length;
    return !strength && dosage.volumes.some((v) => found.amounts.some((a) => a.unit === 'ml' && same(a.value, v.value)));
  }
  // Exact (user, 2026-10-27: "THE DOSAGE SHOULD BE EXACT"):
  // - one of our amounts written as such ("Methotrexate 500mg/5ml"); never a concentration read as an amount
  //   ("Cytarabine 100mg/mL" is not our 100 mg)
  if (dosage.doses.some((d) => found.amounts.some((a) => !a.derived && !a.perUnit && a.unit === d.unit && same(a.value, d.value)))) return true;
  // - our concentration; with a volume on the line, concentration x volume gives our amount ("100mg/ml, 5ml" = our
  //   100mg/ml (500mg / 5ml): "that is how we know we are compliant"), never another concentration whose product
  //   happens to equal one of our amounts ("Docetaxel 10mg/mL, 2mL" is not our 20 mg/0.5 ml)
  const volumes = found.amounts.filter((a) => a.unit === 'ml' && !a.perUnit);
  // Our pack volume: the one our dosage names ("1000 IU / ml (25000 IU / 5ml)": 5 ml, its 25000 ignored; user,
  // 2026-10-27: "When a tender have 1000 IU and 5ML indicated then we are compliant"), else the volume that with the
  // concentration gives our amount ("100mg/ml" x 5 ml = our 500 mg)
  const ourVolume = (volume, concentration) => {
    if (dosage.packVolumes?.length) return dosage.packVolumes.some((v) => same(v, volume));
    const ours = dosage.doses.filter((d) => d.unit === concentration.unit.split('/')[0]);
    // (a Bupivacaine "0.5%" gives no mg amount to check against)
    return !ours.length || ours.some((d) => same(concentration.value * volume, d.value));
  };
  const inOurVolume = (f) => dosage.anyVolume || !volumes.length || volumes.some((v) => ourVolume(v.value, f));
  if (dosage.concentrations.some((c) => found.concentrations.some((f) => f.unit === c.unit && same(f.value, c.value) && inOurVolume(f)))) return true;
  // - hospitals' shorthand: our concentration written over our pack volume ("AMIKACIN 250MG/2ML" for 250 mg/ml, 2 ml;
  //   "Rocuronium 10mg/5ml"; user, 2026-10-27: keep them)
  return dosage.concentrations.some((c) =>
    found.perVolume.some((pv) => `${pv.unit}/ml` === c.unit && same(pv.amount, c.value) && ourVolume(pv.volume, { value: pv.amount, unit: c.unit })),
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
    if (!byName.has(name)) byName.set(name, { name, dosages: [], nameOnly: false, generics: [] });
    // The full generic names ("Bupivacaine Hydrochloride in dextrose"): a "+ Dextrose" in a tender is then part of it
    byName.get(name).generics.push(String(p.generic_name || '').toLowerCase());
    const dosage = dosageOf(p);
    if (dosage) byName.get(name).dosages.push({ ...dosage, forms: formsOf(p), kinds: kindsOf(p), otherStrength: otherStrengthOf(p) });
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
  // Misspellings, word by word: every word of a name within its own limit ("IV infusion, SC" is not "infusion
  // set": "sc" is too short to be misspelled). Single and two-word names only (no "a+b" combinations or long
  // supplement names). Only names with the same first letter are compared, and each answer is kept, since
  // tender texts repeat the same words.
  const fuzzyTerms = [];
  for (const entry of compiled) {
    for (const term of [entry.name.toLowerCase(), ...(OTHER_NAMES[entry.name.toLowerCase()] || [])]) {
      const parts = term.split(/[\s-]+/);
      if (!term.includes('+') && !/\d/.test(term) && parts.length <= 2) fuzzyTerms.push({ entry, parts, whole: parts.join('') });
    }
  }
  const answers = new Map();
  const close = (word, part) => {
    if (word === part) return true;
    if (word[0] !== part[0]) return false;
    const key = `${word}|${part}`;
    if (!answers.has(key)) answers.set(key, misspelling(word, part));
    return answers.get(key);
  };
  const misspelledNames = (words, exact) => {
    const found = new Set();
    for (const { entry, parts, whole } of fuzzyTerms) {
      if (exact.includes(entry)) continue;
      for (let i = 0; i < words.length && !found.has(entry); i++) {
        if (words[i][0] !== whole[0]) continue;
        if (parts.every((part, k) => words[i + k] && close(words[i + k], part))) found.add(entry);
        // A stray space inside a one-word name ("Amlo dipine"): both pieces shorter than the name
        else if (parts.length === 1 && words[i + 1] && words[i].length < whole.length - 1 && words[i + 1].length < whole.length - 1 && close(words[i] + words[i + 1], whole)) found.add(entry);
      }
    }
    return found;
  };
  // Exact names first (also with numbers split off: "Amlodipine5mg"), then misspellings. The last line's answer
  // is kept (details() asks twice per line).
  let last = { text: null, found: [] };
  const names = (text) => {
    if (text === last.text) return last.found;
    const spaced = String(text).replace(/([a-z])(?=\d)/gi, '$1 ');
    const exact = compiled.filter(({ alternatives }) => alternatives.some((parts) => parts.every((re) => re.test(text)) || parts.every((re) => re.test(spaced))));
    const misspelled = misspelledNames(wordsOf(text), exact);
    last = { text, found: compiled.filter((entry) => exact.includes(entry) || misspelled.has(entry)) };
    return last.found;
  };

  // The part of a tender text that is about this product: from its name on, up to the next ingredient ("Vit E:
  // 4mg, Folic Acid: 65mcg, Niacin: 5mg" -> "Folic Acid: 65mcg"; "Ferrous sulfate 300mg + Folic Acid 400mcg"
  // -> "Folic Acid 400mcg"), so another ingredient's dosage never counts (user, 2026-10-26: only the exact
  // dosage we offer). A misspelled name (no exact place) keeps the whole text.
  const ownPart = (entry, text) => {
    let at = -1;
    for (const parts of entry.alternatives) {
      const m = parts[0].exec(text);
      if (m && (at < 0 || m.index < at)) at = m.index;
    }
    if (at < 0) return text;
    const rest = text.slice(at);
    // Ends at another ingredient ("+ Folic Acid", ", Niacin: ...") or at the next numbered row (not a strength on the
    // next line: "3 Paclitaxel" / "300 mg/50 ml vial"). Not at a route or form label (", Inj: 10mg/ml"), nor at a
    // "+ partner" that is part of our product's own name ("Bupivacaine + Dextrose" for "Bupivacaine ... in dextrose")
    // Any case ("Inj:", "ORAL:"): each letter as [xX]
    const anyCase = (word) => [...word].map((c) => `[${c}${c.toUpperCase()}]`).join('');
    // (a strength in capitals too: "57 Heparin (Unfractionated)" / "1000 IU/mL, 5 mL Solution", PhilGEPS 13299385)
    const nextRow = String.raw`\n(?=\s*\d+[.)]?\s+(?!(?:${['mcg', 'µg', 'ug', 'mg', 'grams?', 'gm', 'g', 'iu', 'units?', 'u', 'mcl', 'µl', 'ml', 'cc', 'l'].map((w) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)).join('|')}|%)\b)[A-Za-z])`;
    const label = `(?:${['injection', 'inj', 'oral', 'iv', 'im', 'sc', 'route', 'form', 'dosage', 'tablet', 'tab', 'capsule', 'cap', 'syrup', 'solution', 'suspension', 'for'].map(anyCase).join('|')})\\b`;
    // ("Folic Acid 20-65mcg, Niacin 1-5mg": Niacin's dose is not Folic Acid's, PS 102904)
    const ingredient = String.raw`[,;]\s*(?!${label})(?:[A-Z][A-Za-z .]{1,30}:|[A-Z][a-z]{2,}\s+\d)`;
    const boundary = new RegExp(entry.name.includes('+') ? `${ingredient}|${nextRow}` : String.raw`\s\+\s*([A-Za-z]+)|${ingredient}|${nextRow}`, 'g');
    const after = rest.slice(entry.name.length);
    for (const m of after.matchAll(boundary)) {
      if (m[1] && entry.generics.some((g) => g.includes(m[1].toLowerCase()))) continue;
      return rest.slice(0, entry.name.length + m.index);
    }
    return rest;
  };
  const line = (text, next = '') => {
    if (!text) return [];
    const window = `${text}\n${next}`;
    return names(text)
      .filter((p) => p.nameOnly || p.dosages.some((d) => dosageMatches(d, ownPart(p, window)) && formMatches(d.forms, window) && !d.otherStrength?.(ownPart(p, window)) && specialKinds(ownPart(p, window)).every((kind) => d.kinds.has(kind))))
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
  // Fingerprint of what is screened for (molecules and dosages). Saved document readings carry it, so adding,
  // archiving or restoring a product has the documents read again (psDocs documentsKey, philgepsSync readKey).
  match.key = fingerprint(JSON.stringify([...byName.values()].map((e) => [e.name, e.dosages.map((d) => JSON.stringify(d)).sort(), e.nameOnly]).sort()));
  return match;
}

// Short FNV-1a hash (no node:crypto: this file also runs in the browser)
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `list-${(h >>> 0).toString(16)}`;
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
