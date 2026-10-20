import { readFile } from 'node:fs/promises';
import path from 'node:path';

// molecules.json lives in the repo root next to scraper.js (one level above frontend/),
// outside what the bundler can import, so read it from disk.
const MOLECULES_FILE = path.resolve(process.cwd(), '..', 'molecules.json');

// Names of all our registered products, for the dashboard's exclusion filter
export async function GET() {
  const molecules = JSON.parse(await readFile(MOLECULES_FILE, 'utf8'));
  return Response.json(molecules.map((m) => m.name).sort((a, b) => a.localeCompare(b)));
}
