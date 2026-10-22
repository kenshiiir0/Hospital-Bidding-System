require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { uploadTenderDocuments } = require('../documents-storage');

// Uploads every downloaded PhilGEPS document that is not in Storage yet (documents from before Sync
// uploaded them) and saves their Storage paths, so the dashboard opens them from any computer.
//   node tools/publish-philgeps-documents.js
async function main() {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await supabase.from('philgeps_opportunities').select('ref_no, details');
    if (error) throw new Error(error.message);

    let uploaded = 0;
    const failed = [];
    for (const row of data) {
        const documents = row.details?.documents || [];
        if (!documents.some((doc) => !doc.path)) continue;
        const result = await uploadTenderDocuments(supabase, row.ref_no, documents);
        uploaded += result.uploaded;
        failed.push(...result.failed);
        if (result.uploaded) {
            const { error: saveError } = await supabase.from('philgeps_opportunities')
                .update({ details: { ...row.details, documents } }).eq('ref_no', row.ref_no);
            if (saveError) failed.push(`${row.ref_no}: saving paths: ${saveError.message}`);
        }
        console.log(`${row.ref_no}: ${result.uploaded} uploaded${result.failed.length ? `, ${result.failed.length} failed` : ''}`);
    }
    console.log(`Done: ${uploaded} documents uploaded, ${failed.length} failed.`);
    for (const f of failed) console.log(`  failed ${f}`);
    if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
});
