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
echo "Safety gate: 2/3 code check"
(cd frontend && npx eslint src) || { echo "Push blocked: the code check (ESLint) failed."; exit 1; }
echo "Safety gate: 3/3 build"
(cd frontend && npm run build > ../.safety-build.log 2>&1) || { tail -30 .safety-build.log; echo "Push blocked: the dashboard does not build."; exit 1; }
echo "Safety gate passed."
