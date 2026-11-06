// Matches a hospital across PhilGEPS, PS-PhilGEPS and the Hospital List, which spell names slightly differently:
// "Dr. Paulino J. Garcia Memorial Research & Medical..." and "DR PAULINO J GARCIA MEMORIAL RESEARCH AND MEDICAL..."
// -> "DR PAULINO J GARCIA MEMORIAL RESEARCH AND MEDICAL..."; "Las Piñas" -> "LAS PINAS"; "Children's" -> "CHILDRENS".
export const agencyKey = (name = '') =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// A tender's agency against the Hospital List (keys: agency_key of each hospital): the same name, or the name
// with the region / DOH suffix the portals add ("VICENTE SOTTO MEMORIAL MEDICAL CENTER - REGION VII",
// "CORAZON LOCSIN MONTELIBANO MEMORIAL REGIONAL HOSPITAL-DOH R6", "WESTERN VISAYAS SANITARIUM - DOH" for
// "WESTERN VISAYAS SANITARIUM AND GENERAL HOSPITAL"). A shortened name counts only when the portal
// added such a suffix, and needs at least 3 words ("WEST VISAYAS STATE UNIVERSITY" alone is the university).
const SUFFIX = / (?:DOH|CHD|REGION|R ?\d+)\b.*$/;
export function hospitalMatcher(keys) {
  const list = [...keys];
  const seen = new Map();
  return (name) => {
    const key = agencyKey(name || '');
    if (!key) return false;
    if (seen.has(key)) return seen.get(key);
    const base = key.replace(SUFFIX, '');
    const hit =
      keys.has(key) ||
      keys.has(base) ||
      list.some((k) => key.startsWith(`${k} `) || (base !== key && base.split(' ').length >= 3 && k.startsWith(`${base} `)));
    seen.set(key, hit);
    return hit;
  };
}
