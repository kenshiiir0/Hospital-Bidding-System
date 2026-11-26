#!/bin/sh
# Runs before every push (installed as .git/hooks/pre-push by tools/install-safety-hook.js; also by hand:
# npm run safety). The push only goes through, and Vercel only deploys, when all three pass:
#   1. the Sync safety check (log-in / log-out against a stand-in PhilGEPS, tools/check-sync-safety.mjs), the
#      award Accept / Refuse check (tools/check-award-action.mjs), the award email routing check
#      (tools/check-award-routing.mjs) and the product matching check (molecule +
#      dosage, tools/check-matching.mjs) and the item line check (quantities, tools/check-item-lines.mjs),
#   2. the code check (ESLint) of the dashboard,
#   3. a full build of the dashboard (what Vercel will build).
cd "$(git rev-parse --show-toplevel)" || exit 1
echo "Safety gate: 1/3 Sync safety, award action and product matching checks"
node tools/check-sync-safety.mjs || { echo "Push blocked: the Sync safety check failed."; exit 1; }
node tools/check-award-action.mjs || { echo "Push blocked: the award Accept / Refuse check failed."; exit 1; }
node tools/check-award-routing.mjs || { echo "Push blocked: the award email routing check failed."; exit 1; }
node tools/check-matching.mjs || { echo "Push blocked: the product matching check failed."; exit 1; }
node tools/check-item-lines.mjs || { echo "Push blocked: the item line (quantity) check failed."; exit 1; }
node tools/check-accuracy.mjs || { echo "Push blocked: the reading accuracy check failed."; exit 1; }
node tools/check-document-text.mjs || { echo "Push blocked: the document text check (read each file once) failed."; exit 1; }
node tools/check-notice-lines.mjs || { echo "Push blocked: the notice line items check failed."; exit 1; }
node tools/check-read-again.mjs || { echo "Push blocked: the read-again check (no reading the same tender twice) failed."; exit 1; }
node tools/check-lot-notices.mjs || { echo "Push blocked: the one-lot notice check failed."; exit 1; }
node tools/check-open-search.mjs || { echo "Push blocked: the Open Opportunities search check failed."; exit 1; }
node tools/check-screened-lots.mjs || { echo "Push blocked: the screened one-lot check failed."; exit 1; }
node tools/build-laptop-kit.mjs --check || { echo "Push blocked: the laptop log-in files are out of date."; exit 1; }
echo "Safety gate: 2/3 code check"
(cd frontend && npx eslint src) || { echo "Push blocked: the code check (ESLint) failed."; exit 1; }
echo "Safety gate: 3/3 build"
(cd frontend && npm run build > ../.safety-build.log 2>&1) || { tail -30 .safety-build.log; echo "Push blocked: the dashboard does not build."; exit 1; }
echo "Safety gate passed."
