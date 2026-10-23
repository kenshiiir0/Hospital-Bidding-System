// Installs the safety gate (tools/safety-gate.sh) as this clone's git pre-push hook, so no push (and so no
// Vercel deploy) happens unless the Sync safety check, the code check and the build pass. Run once per clone:
//   node tools/install-safety-hook.js
const fs = require('node:fs');
const path = require('node:path');

const hook = path.join(__dirname, '..', '.git', 'hooks', 'pre-push');
fs.writeFileSync(hook, '#!/bin/sh\n# Installed by tools/install-safety-hook.js\nexec sh "$(git rev-parse --show-toplevel)/tools/safety-gate.sh"\n');
fs.chmodSync(hook, 0o755);
console.log(`Safety gate installed: ${hook}`);
