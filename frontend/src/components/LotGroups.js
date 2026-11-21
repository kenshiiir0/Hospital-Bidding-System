import { moleculeText } from '@/lib/opportunityWorkbook';

// A tender of several lots in the Molecule tracker: line items first, then Lot 1 and its molecules, Lot 2 and its
// molecules (user, 2026-10-31; psDocs.mjs tags each row with its lot). children(rows) draws one group's table,
// its molecules A to Z.
// leftOut: the lots not fetched because not all their molecules are ours (psDocs.mjs completeLots), said so they can
// be checked against the document
function LeftOut({ lots }) {
  if (!lots?.length) return null;
  return (
    <ul className="mt-3 space-y-0.5 text-xs text-black/62">
      {lots.map((l) => (
        <li key={l.lot}>
          {l.lot} left out: {l.ours} of {l.of} molecules are ours ({l.molecules.join(', ')})
        </li>
      ))}
    </ul>
  );
}

// Molecules A to Z by the name the Molecule column shows (user, 2026-11-21), within each lot
const byMolecule = (rows) => {
  const name = (item) => moleculeText(item.description || item.line, item.our_products || item.products).toLowerCase();
  return [...rows].sort((a, b) => name(a).localeCompare(name(b), 'en', { numeric: true }));
};

export default function LotGroups({ items, leftOut, children }) {
  if (!items.some((item) => item.lot)) {
    return (
      <>
        {children(byMolecule(items))}
        <LeftOut lots={leftOut} />
      </>
    );
  }
  const lots = [...new Set(items.map((item) => item.lot || ''))].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  return (
    <div className="space-y-4">
      {lots.map((lot) => {
        const rows = items.filter((item) => (item.lot || '') === lot);
        return (
          <section key={lot || 'line-items'}>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#3F6F2C]">
              {lot || 'Line items'} <span className="font-normal text-black/46">({rows.length})</span>
            </h4>
            {children(byMolecule(rows))}
          </section>
        );
      })}
      <LeftOut lots={leftOut} />
    </div>
  );
}
