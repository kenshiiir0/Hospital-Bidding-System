import { execFile } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd(), '..');

// Applies schema.sql to Supabase when it changed (see tools/apply-schema.js); the result goes to the log
export function applySchemaIfChanged() {
  execFile(process.execPath, ['tools/apply-schema.js', '--if-changed'], { cwd: REPO_ROOT, windowsHide: true }, (err, stdout, stderr) => {
    const message = (stdout + stderr).trim();
    if (err) console.error(`[schema] ${message || err.message}`);
    else if (message) console.log(`[schema] ${message}`);
  });
}
