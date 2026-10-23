// Read-only report: how many open tenders have bid documents the system could not read (scanned PDFs),
// and whether the known examples now show our products.
//
//   node tools/check-document-gaps.js [extra PhilGEPS refs...]
require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { auth: { persistSession: false } });
const UNREADABLE = /No readable text/i;

// Tenders the team found by hand whose products were only in scanned PDFs (2026-10-23)
const PHILGEPS_EXAMPLES = ['13304378', ...process.argv.slice(2)];
const PS_EXAMPLES = ['109036'];

async function allPhilgeps() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
            .from('philgeps_opportunities')
            .select('ref_no, procuring_entity, closing_date, matched_molecules, details')
            .range(from, from + 999);
        if (error) throw new Error(error.message);
        rows.push(...data);
        if (data.length < 1000) return rows;
    }
}

(async () => {
    const rows = await allPhilgeps();
    const open = rows.filter((r) => r.closing_date && new Date(r.closing_date) > new Date());
    const withDocs = open.filter((r) => (r.details?.documents || []).length);
    const unreadable = withDocs.filter((r) => UNREADABLE.test(r.details?.documents_read_note || ''));
    const hidden = unreadable.filter((r) => !(r.matched_molecules || []).length);

    console.log('PhilGEPS (open tenders)');
    console.log(`  documents downloaded:        ${withDocs.length}`);
    console.log(`  products found in documents: ${withDocs.filter((r) => (r.details?.documents_products || []).length).length}`);
    console.log(`  documents unreadable:        ${unreadable.length}`);
    console.log(`  ...hidden from list/export:  ${hidden.length}`);

    const { data: analysis, error } = await supabase.from('ps_tender_analysis').select('ref, status, error, result');
    if (error) throw new Error(error.message);
    const psUnreadable = analysis.filter((a) => UNREADABLE.test(a.error || ''));
    console.log('PS-PhilGEPS');
    console.log(`  documents read:              ${analysis.filter((a) => a.status === 'done').length}`);
    console.log(`  documents unreadable:        ${psUnreadable.length}`);

    console.log('Known examples');
    for (const ref of PHILGEPS_EXAMPLES) {
        const r = rows.find((x) => x.ref_no === ref);
        if (!r) {
            console.log(`  PhilGEPS ${ref}: not in the system`);
            continue;
        }
        const products = r.matched_molecules || [];
        const note = r.details?.documents_read_note;
        console.log(`  PhilGEPS ${ref} (${r.procuring_entity}): ${products.length ? 'FOUND ' + products.join(', ') : 'no products'}${note ? ` | ${note}` : ''}`);
    }
    for (const ref of PS_EXAMPLES) {
        const a = analysis.find((x) => x.ref === ref);
        const products = [...new Set((a?.result?.items || []).flatMap((i) => i.our_products || []))];
        console.log(`  PS-PhilGEPS ${ref}: ${a ? (products.length ? 'FOUND ' + products.join(', ') : `no products in documents${a.error ? ` | ${a.error}` : ''}`) : 'documents not read yet'}`);
    }
})().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
