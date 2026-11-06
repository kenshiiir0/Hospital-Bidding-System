// Who is told about an award notice waiting for our answer (awardNotify.mjs): every hospital on the
// "2MG Incorporated served list of hospitals" has one representative; the back-ups are copied on every email
// (they take over when the representative is away or has too many at once). A hospital not on the list goes
// to the back-ups. Sheet of 2026-10-24, with the changes the user gave: #15 Corazon Locsin to Hazel,
// #23 National Children's Hospital to Angel.
// Plain .mjs (no Next imports) so tools/check-award-routing.mjs can run it with node.

export const PEOPLE = {
  aljean: { name: 'Aljean Carno', email: 'gov5@getmeds.ph' },
  hazel: { name: 'Hazel Marie Balano', email: 'gov4@getmeds.ph' },
  angel: { name: 'Angelica Gollena', email: 'gov3@getmeds.ph' },
  jimmy: { name: 'Jimmy Boy Saturinas', email: 'gov1@getmeds.ph' },
};
export const BACKUPS = ['aljean', 'jimmy'];

// [sheet number, name as on the sheet, representative, other spellings seen on PhilGEPS]
export const HOSPITALS = [
  [1, 'Southern Philippines Medical Center', 'hazel'],
  [3, 'Dr. Jose Fabella Memorial Hospital', 'hazel'],
  [4, 'Jose B. Lingad Memorial General Hospital', 'hazel', ['Jose B. Lingad Memorial Regional Hospital', 'Jose B. Lingad Memorial']],
  [5, 'Dr. Paulino J. Garcia Memorial Research and Medical Center', 'hazel', ['Paulino J. Garcia Memorial']],
  [7, 'Baguio General Hospital and Medical Center', 'hazel'],
  [8, 'Dr. Jose N. Rodriguez Memorial Hospital', 'hazel', ['Jose N. Rodriguez Memorial']],
  [12, 'Bataan General Hospital and Medical Center', 'hazel'],
  [13, 'Mariano Marcos Memorial Hospital and Medical Center', 'hazel'],
  [14, 'Western Visayas Medical Center', 'hazel'],
  [15, 'Corazon Locsin Montelibano Memorial Regional Hospital', 'hazel', ['Corazon Locsin Montelibano']],
  [16, 'Southern Isabela Medical Center', 'hazel'],
  [25, 'Cotabato Sanitarium and General Hospital', 'hazel', ['Cotabato Sanitarium']],
  [31, 'Northern Mindanao Medical Center', 'hazel'],
  [32, 'Zamboanga City Medical Center', 'hazel'],
  [33, 'Cotabato Regional and Medical Center', 'hazel'],
  [34, 'West Visayas State University Medical Center', 'hazel'],
  [35, 'Cebu South Medical Center', 'hazel'],
  [38, 'Western Visayas Sanitarium and General Hospital', 'hazel', ['Western Visayas Sanitarium']],
  [39, 'National Center for Mental Health', 'hazel'],
  [40, 'Mayor Hilarion A. Ramiro Sr. Regional Medical Center', 'hazel', ['Hilarion A. Ramiro', 'Hilarion Ramiro']],
  [42, 'Vicente Sotto Memorial Medical Center', 'hazel'],
  [44, 'Philippine Heart Center', 'hazel'],
  [45, 'National Kidney and Transplant Institute', 'hazel'],
  [46, 'Lung Center of the Philippines', 'hazel'],
  [47, "Philippine Children's Medical Center", 'hazel'],

  [2, 'Bicol Medical Center', 'angel'],
  [6, 'East Avenue Medical Center', 'angel'],
  [9, 'Batangas Medical Center', 'angel'],
  [10, 'Jose R. Reyes Memorial Medical Center', 'angel'],
  [11, 'Amai Pakpak Medical Center', 'angel'],
  [17, 'Ilocos Training and Regional Medical Center', 'angel'],
  [18, 'Region II Trauma and Medical Center', 'angel', ['Region 2 Trauma and Medical Center']],
  [19, 'Tondo Medical Center', 'angel'],
  [20, 'Amang Rodriguez Memorial Medical Center', 'angel'],
  [21, 'Rizal Medical Center', 'angel'],
  [22, 'Bicol Regional Hospital and Medical Center', 'angel'],
  [23, "National Children's Hospital", 'angel'],
  [24, 'Gov. Celestino Gallares Memorial Hospital', 'angel', ['Celestino Gallares Memorial']],
  [26, 'Las Piñas General Hospital & Satellite Trauma Center', 'angel', ['Las Piñas General Hospital']],
  [27, 'Valenzuela Medical Center', 'angel'],
  [28, 'Southern Tagalog Regional Hospital', 'angel'],
  [29, 'Talavera General Hospital', 'angel'],
  [30, 'Eastern Visayas Medical Center', 'angel', ['Eastern Visayas Regional Medical Center']],
  [36, 'Bicol Region General Hospital and Geriatric Medical Center', 'angel'],
  [37, 'Cagayan Valley Medical Center', 'angel'],
  [41, 'Dr. Jose Rizal Memorial Hospital', 'angel', ['Jose Rizal Memorial Hospital']],
  [43, 'Luis Hora Memorial Regional Hospital', 'angel'],
];

// "Las Piñas General Hospital & Satellite…" / "LAS PINAS GENERAL HOSPITAL AND SATELLITE…" -> same words;
// "Children's" and "Childrens" both -> CHILDRENS
export const nameKey = (name = '') =>
  ` ${name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;

/**
 * The routing for a given list ({ people: {key: {name, email}}, backups: [key], hospitals: [[no, name, rep, aliases]] }).
 * The dashboard's Assigned Persons page edits that list (tables assigned_people and assigned_hospitals,
 * loadRouting below); the lists above are what those tables start from, and the fallback when they can't be read.
 * routeAward(agency): the hospital on the list whose name (or other spelling) is inside the agency name PhilGEPS
 * shows ("DOH - SOUTHERN PHILIPPINES MEDICAL CENTER"); the longest match wins, so "Bicol Regional Hospital and
 * Medical Center" is never taken for "Bicol Medical Center".
 * Returns { hospital: {no, name} | null, to: [{name, email}], cc: [{name, email}] }.
 * A hospital whose representative is missing goes to the back-ups.
 */
export function makeRouter({ people = PEOPLE, backups = BACKUPS, hospitals = HOSPITALS } = {}) {
  const backupList = backups.map((p) => people[p]).filter(Boolean);
  const keys = hospitals.flatMap(([no, name, rep, aliases = []]) => [name, ...(aliases || [])].map((n) => ({ key: nameKey(n), no, name, rep })));
  return function route(agency) {
    const key = nameKey(agency);
    const found = keys.filter((k) => k.key.trim() && key.includes(k.key)).sort((a, b) => b.key.length - a.key.length)[0];
    if (!found || !people[found.rep]) return { hospital: found ? { no: found.no, name: found.name } : null, to: backupList, cc: [] };
    return { hospital: { no: found.no, name: found.name }, to: [people[found.rep]], cc: backupList.filter((p) => p.email !== people[found.rep].email) };
  };
}

export const routeAward = makeRouter();

/** Defaults as table rows (what assigned_people / assigned_hospitals start from) */
export const defaultRows = () => ({
  people: Object.entries(PEOPLE).map(([key, p]) => ({ key, name: p.name, email: p.email, backup: BACKUPS.includes(key) })),
  hospitals: HOSPITALS.map(([no, name, rep, aliases = []]) => ({ no, name, rep, aliases })),
});

/** Table rows -> the shape makeRouter takes */
export const fromRows = ({ people, hospitals }) => ({
  people: Object.fromEntries(people.map((p) => [p.key, { name: p.name, email: p.email }])),
  backups: people.filter((p) => p.backup).map((p) => p.key),
  hospitals: hospitals.map((h) => [h.no, h.name, h.rep, h.aliases || []]),
});

/**
 * The list as edited on the Assigned Persons page (service-key Supabase client). Falls back to the lists above
 * when the tables are missing or empty, so an award email always goes somewhere.
 * Returns { ...fromRows, route, fromTables }.
 */
export async function loadRouting(supabase) {
  try {
    const [p, h] = await Promise.all([
      supabase.from('assigned_people').select('key, name, email, backup'),
      supabase.from('assigned_hospitals').select('no, name, rep, aliases'),
    ]);
    if (!p.error && !h.error && p.data?.length) {
      const list = fromRows({ people: p.data, hospitals: h.data || [] });
      return { ...list, route: makeRouter(list), fromTables: true };
    }
  } catch {
    // fall through to the built-in list
  }
  return { people: PEOPLE, backups: BACKUPS, hospitals: HOSPITALS, route: routeAward, fromTables: false };
}
