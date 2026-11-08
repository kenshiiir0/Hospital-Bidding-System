// Builds frontend/src/lib/laptopKit.generated.mjs: the files a team laptop needs for the PS-PhilGEPS pop-up log-in
// (no keys, no password: see ps-philgeps-session.js connectLaptop). The dashboard hands them out to a signed-in
// team member's setup file (app/api/ps-philgeps/laptop). Run after changing any of them:
//   node tools/build-laptop-kit.mjs          (rebuild)
//   node tools/build-laptop-kit.mjs --check  (safety gate: fails when the built copy is out of date)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'frontend', 'src', 'lib', 'laptopKit.generated.mjs');
const SOURCES = ['ps-philgeps-session.js', 'Connect PS-PhilGEPS.vbs', 'tools/register-connect-link.js'];
const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const kitPackage = {
  name: 'ps-philgeps-connect',
  private: true,
  description: 'PS-PhilGEPS pop-up log-in for a team laptop (set up from the dashboard)',
  dependencies: { puppeteer: rootPackage.dependencies.puppeteer, dotenv: rootPackage.dependencies.dotenv },
};

const files = Object.fromEntries(SOURCES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')]));
files['package.json'] = `${JSON.stringify(kitPackage, null, 2)}\n`;
const text = `// Built by tools/build-laptop-kit.mjs from the project's own files. Do not edit: change the originals and rebuild.\nexport const LAPTOP_KIT = ${JSON.stringify(files, null, 1)};\n`;

if (process.argv.includes('--check')) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (now !== text) {
    console.error('Laptop kit: frontend/src/lib/laptopKit.generated.mjs is out of date. Run: node tools/build-laptop-kit.mjs');
    process.exit(1);
  }
  console.log('Laptop kit: up to date');
} else {
  fs.writeFileSync(OUT, text);
  console.log(`Laptop kit: ${Object.keys(files).length} files -> ${path.relative(ROOT, OUT)}`);
}
