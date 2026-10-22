require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// Publishes a PS-PhilGEPS Sync result to Supabase so every computer and the deployed dashboard see it:
// - each downloaded document (documents/ps/<ref>/<file>) → Storage bucket "ps-documents" at <ref>/<file>
//   (files already there are skipped),
// - the lists and notices → table ps_philgeps_snapshot, row 'latest' (documents carry their Storage path).
// ps-philgeps-sync.js calls publish() after every Sync; run it alone to re-publish the last result:
//   node tools/ps-publish.js
const ROOT = path.join(__dirname, '..');
const RESULT_FILE = path.join(ROOT, '.ps-philgeps', 'latest.json');
const DOCS_DIR = path.join(ROOT, 'documents', 'ps');
const BUCKET = 'ps-documents';
const UPLOADS_AT_ONCE = 4;

const TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// Storage keys: keep letters, digits and . _ - ( ) ; anything else becomes _
const storageName = (name) => name.replace(/[^A-Za-z0-9._()-]/g, '_');

async function publish(result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')), log = console.log) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    // Every document of every notice, with its Storage path
    const jobs = [];
    for (const [ref, notice] of Object.entries(result.notices || {})) {
        for (const doc of notice.documents || []) {
            doc.path = `${ref}/${storageName(doc.name)}`;
            jobs.push({ ref, doc, file: path.join(DOCS_DIR, ref, doc.name) });
        }
    }

    // Skip what's already uploaded (one listing per notice folder)
    const existing = new Set();
    for (const ref of new Set(jobs.map((j) => j.ref))) {
        const { data, error } = await supabase.storage.from(BUCKET).list(ref, { limit: 1000 });
        if (error) throw new Error(`Storage list ${ref}: ${error.message}`);
        for (const f of data) existing.add(`${ref}/${f.name}`);
    }
    const pending = jobs.filter((j) => !existing.has(j.doc.path) && fs.existsSync(j.file));

    let uploaded = 0;
    const failed = [];
    for (let i = 0; i < pending.length; i += UPLOADS_AT_ONCE) {
        await Promise.all(pending.slice(i, i + UPLOADS_AT_ONCE).map(async ({ doc, file }) => {
            const { error } = await supabase.storage.from(BUCKET).upload(doc.path, fs.readFileSync(file), {
                contentType: TYPES[path.extname(doc.name).toLowerCase()] || 'application/octet-stream',
                upsert: false
            });
            if (error && !/exists/i.test(error.message)) failed.push(`${doc.path}: ${error.message}`);
            else uploaded++;
        }));
        log(`Uploaded ${Math.min(i + UPLOADS_AT_ONCE, pending.length)} of ${pending.length} new documents`);
    }

    // A document whose upload failed has no path, so the dashboard won't offer a broken link
    for (const f of failed) {
        const p = f.split(':')[0];
        for (const j of jobs) if (j.doc.path === p) delete j.doc.path;
    }

    const { error } = await supabase.from('ps_philgeps_snapshot').upsert({
        id: 'latest',
        synced_at: result.syncedAt,
        lists: result.lists,
        notices: result.notices,
        updated_at: new Date().toISOString()
    });
    if (error) throw new Error(`Saving the snapshot: ${error.message}`);
    return { uploaded, skipped: jobs.length - pending.length, failed };
}

module.exports = { publish };

if (require.main === module) {
    publish()
        .then(({ uploaded, skipped, failed }) => {
            console.log(`Published: ${uploaded} documents uploaded, ${skipped} already there, ${failed.length} failed.`);
            for (const f of failed) console.log(`  failed ${f}`);
        })
        .catch((e) => {
            console.error(`ERROR: ${e.message}`);
            process.exit(1);
        });
}
