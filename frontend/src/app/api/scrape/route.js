import { execFile } from 'node:child_process';
import path from 'node:path';

// scraper.js lives in the repo root (one level above frontend/) with its own
// node_modules and .env, so run it as a child process instead of bundling Puppeteer.
const REPO_ROOT = path.resolve(process.cwd(), '..');

// Prevent overlapping Chrome sessions if the button is clicked repeatedly
let isRunning = false;

export async function POST() {
  if (isRunning) {
    return Response.json({ ok: false, error: 'A scrape is already running.' }, { status: 409 });
  }

  isRunning = true;
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['scraper.js'],
        { cwd: REPO_ROOT, timeout: 900000 }, // first run also opens every tender's detail page; later runs only new ones
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        }
      );
    });
    return Response.json({ ok: true, output });
  } catch (err) {
    console.error('Scrape failed:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  } finally {
    isRunning = false;
  }
}
