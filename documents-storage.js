const fs = require('node:fs');
const path = require('node:path');

// PhilGEPS bid documents downloaded by Sync (documents/<ref>/<file>) are also kept in the private Supabase
// Storage bucket "philgeps-documents" at <ref>/<file>, so the dashboard can open them from any computer and
// from the deployed copy (signed links; see schema.sql). Mirrors tools/ps-publish.js for PS-PhilGEPS.
const BUCKET = 'philgeps-documents';
const DOCS_DIR = path.resolve(__dirname, 'documents');

const TYPES = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// Storage keys: keep letters, digits and . _ - ( ) ; anything else becomes _
const storageName = (name) => name.replace(/[^A-Za-z0-9._()-]/g, '_');

// Uploads the tender's documents that have no Storage path yet and sets doc.path on each uploaded one
// (a document whose upload failed keeps no path, so the dashboard falls back to this computer's copy).
// Returns { uploaded, failed: [messages] }. supabase: a client with the secret key.
async function uploadTenderDocuments(supabase, ref, documents) {
    let uploaded = 0;
    const failed = [];
    for (const doc of documents) {
        if (doc.path) continue;
        const file = path.join(DOCS_DIR, ref, doc.name);
        if (!fs.existsSync(file)) {
            failed.push(`${ref}/${doc.name}: not on this computer`);
            continue;
        }
        const key = `${ref}/${storageName(doc.name)}`;
        const { error } = await supabase.storage.from(BUCKET).upload(key, fs.readFileSync(file), {
            contentType: TYPES[path.extname(doc.name).toLowerCase()] || 'application/octet-stream',
            upsert: true
        });
        if (error) {
            failed.push(`${key}: ${error.message}`);
            continue;
        }
        doc.path = key;
        uploaded++;
    }
    return { uploaded, failed };
}

module.exports = { uploadTenderDocuments, BUCKET };
