// Screened tenders that turn out to be bought as ONE lot are taken out of Screened Tenders by themselves, both portals
// (user, 2026-11-26: "Yes remove it from bid match and screened" / "If there are marked one lot it's not important if
// dashboard or document. Automatically remove them"). A tender is screened while it looks like an opportunity (Screen
// All, or before the Sync read its notice's Lot Type); once the website or its documents say one lot it is not one.
// One lot = lib/packageTender.js: the notice's "Lot Type: Single Lot" or a "1 Lot" line item, or the documents'
// reading (result.package / details.package) unless the website lists the tender as Multi Lot.
// Run after each Sync and update (psSync.mjs, philgepsUpdate.mjs). Plain .mjs: also run by hand and by the checks.
import { isPackageTender, noticeLotType, noticeOneLot } from './packageTender.js';
import { logActivity } from './activityLog.mjs';

/** A PS-PhilGEPS tender bought as one lot: by its notice, or by its documents unless the notice says Multi Lot */
export const psOneLot = (notice, documentsPackage) => noticeOneLot(notice) || (isPackageTender('', documentsPackage) && noticeLotType(notice) !== 'multi');

/** The screened tenders bought as one lot: [{ source, ref, title, why }]. Reads only the screened tenders' own fields. */
export async function screenedLots(supabase) {
  const { data: screened, error } = await supabase.from('screened_tenders').select('source, ref, title');
  if (error) throw new Error(error.message);
  const out = [];
  const ps = (screened || []).filter((s) => s.source === 'ps' && /^\d+$/.test(String(s.ref)));
  for (let i = 0; i < ps.length; i += 40) {
    const refs = ps.slice(i, i + 40).map((s) => String(s.ref));
    const [{ data: snap }, { data: readings }] = await Promise.all([
      supabase.from('ps_philgeps_snapshot').select(refs.map((ref) => `t${ref}:notices->"${ref}"->lot_type, m${ref}:notices->"${ref}"->matched_items`).join(',')).eq('id', 'latest').maybeSingle(),
      supabase.from('ps_tender_analysis').select('ref, package:result->package').in('ref', refs),
    ]);
    const packageOf = new Map((readings || []).map((r) => [String(r.ref), r.package]));
    for (const s of ps.slice(i, i + 40)) {
      const ref = String(s.ref);
      const notice = { lot_type: snap?.[`t${ref}`] ?? undefined, matched_items: snap?.[`m${ref}`] || [] };
      if (!psOneLot(notice, packageOf.get(ref))) continue;
      out.push({ source: 'ps', ref, title: s.title || '', why: noticeLotType(notice) === 'single' ? 'the notice says Lot Type: Single Lot' : noticeOneLot(notice) ? 'the notice lists it as 1 Lot' : 'its documents say one lot' });
    }
  }
  const old = (screened || []).filter((s) => s.source !== 'ps');
  for (let i = 0; i < old.length; i += 100) {
    const { data } = await supabase.from('philgeps_opportunities').select('ref_no, items_text, package:details->package').in('ref_no', old.slice(i, i + 100).map((s) => s.ref));
    const byRef = new Map((data || []).map((o) => [String(o.ref_no), o]));
    for (const s of old.slice(i, i + 100)) {
      const o = byRef.get(String(s.ref));
      if (o && isPackageTender(o.items_text, o.package)) out.push({ source: s.source, ref: String(s.ref), title: s.title || '', why: 'its documents or description say one lot or package' });
    }
  }
  return out;
}

/** Takes the one-lot tenders out of Screened Tenders; returns the ones removed. Each removal is written to the
 * activity log (which tender, why), so it can be looked up and screened again by hand. Never throws. */
export async function removeScreenedLots(supabase) {
  try {
    const lots = await screenedLots(supabase);
    const removed = [];
    for (const lot of lots) {
      const { error } = await supabase.from('screened_tenders').delete().eq('source', lot.source).eq('ref', lot.ref);
      if (!error) removed.push(lot);
    }
    if (removed.length) {
      await logActivity({
        event: 'screened',
        status: 'success',
        by: 'schedule',
        summary: `${removed.length} one-lot tender${removed.length === 1 ? '' : 's'} taken out of Screened Tenders: ${removed.map((l) => l.ref).join(', ')}`,
        details: { removed },
      }).catch(() => {});
    }
    return removed;
  } catch {
    return [];
  }
}
