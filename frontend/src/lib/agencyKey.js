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
