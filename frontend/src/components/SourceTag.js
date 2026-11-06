// Which portal a tender is from: PhilGEPS (notices.philgeps.gov.ph) outlined grey, PS-PhilGEPS (philgeps.gov.ph)
// soft blue. Used by the merged Bid Match and Screened Tenders.
export const SOURCES = { philgeps: 'PhilGEPS', ps: 'PS-PhilGEPS' };

export default function SourceTag({ source }) {
  const tone = source === 'ps' ? 'border-[#1EA0DA]/30 bg-[#1EA0DA]/8 text-[#12769F]' : 'border-[#CBD5E1] bg-white text-black/62';
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{SOURCES[source] || source}</span>;
}
