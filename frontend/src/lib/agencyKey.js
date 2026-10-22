// Matches a hospital across PhilGEPS and PS-PhilGEPS, which spell names slightly differently:
// "Dr. Paulino J. Garcia Memorial..." and "DR PAULINO J GARCIA MEMORIAL..." -> "DR PAULINO J GARCIA MEMORIAL..."
export const agencyKey = (name = '') =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
