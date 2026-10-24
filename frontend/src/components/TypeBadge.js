// The tender type (lib/tenderType.js) as a small pill: ITB, RFQ, RFP, Negotiated. Hover shows the full
// notice type and mode of procurement.
const TONES = {
  ITB: 'border-[#1EA0DA]/30 bg-[#1EA0DA]/8 text-[#12769F]',
  RFQ: 'border-[#61A644]/30 bg-[#61A644]/10 text-[#3F6F2C]',
  RFP: 'border-[#7C5CC4]/30 bg-[#7C5CC4]/8 text-[#5B3FA0]',
  Negotiated: 'border-[#D9822B]/30 bg-[#D9822B]/10 text-[#9A5A16]',
};

export default function TypeBadge({ type }) {
  if (!type?.code) return <span className="text-black/46">—</span>;
  return (
    <span
      title={type.title}
      // A type with no abbreviation ("Request for Quotation") wraps inside a narrow column instead of spilling out
      className={`inline-block max-w-full border px-2 py-0.5 text-[11px] font-semibold leading-snug ${type.code.length > 10 ? 'rounded-lg' : 'whitespace-nowrap rounded-full'} ${TONES[type.code] || 'border-[#CBD5E1] bg-white text-black/62'}`}
    >
      {type.code}
    </span>
  );
}
