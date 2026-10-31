// A tender of several lots in the Molecule tracker: line items first, then Lot 1 and its molecules, Lot 2 and its
// molecules (user, 2026-10-31; psDocs.mjs tags each row with its lot). children(rows) draws one group's table
export default function LotGroups({ items, children }) {
  if (!items.some((item) => item.lot)) return children(items);
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
            {children(rows)}
          </section>
        );
      })}
    </div>
  );
}
