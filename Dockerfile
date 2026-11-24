# The dashboard (frontend/, Next.js) for a Coolify (or any Docker) deployment. Build context: the repo root.
#
# Laid out like the repo: the app runs from /app/frontend and finds schema.sql and tools/apply-schema.js one
# level up (/app), as on a team computer (lib/schema.js). Like the Vercel copy it has no scraper.js and no
# puppeteer, so it never runs PhilGEPS fetches itself (lib/fetchJobs.js CAN_RUN_FETCHES): the office PC and
# the Supabase schedules (tools/setup-schedules.js -> /api/...) keep doing that, nothing fetches twice.
#
# NEXT_PUBLIC_* values are baked into the browser code at build time: in Coolify tick "Build Variable" for
# NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. See docs/COOLIFY.md.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Dashboard packages (incl. build tools) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- Build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app/frontend
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/frontend/node_modules ./node_modules
COPY frontend/ ./
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" || (echo "NEXT_PUBLIC_SUPABASE_URL is not set (Coolify: mark it as a Build Variable)" && exit 1)
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf .next/cache

# ---- Run ----
FROM ${NODE_IMAGE} AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

# Root packages for the two tools below (pg, dotenv, supabase-js), not the scraper's puppeteer/Chrome
RUN echo '{"private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock pg@^8.23.1 dotenv@^18.0.8 @supabase/supabase-js@^2.118.0 \
 && npm cache clean --force
COPY schema.sql ./
# apply-schema.js: run on start (lib/schema.js). add-user.js: create a dashboard account or reset its password
# from Coolify's terminal: node ../tools/add-user.js <username or email> [password] (uses SUPABASE_URL/SUPABASE_KEY)
COPY tools/apply-schema.js tools/add-user.js ./tools/
COPY --from=build /app/frontend ./frontend

# Next writes its runtime cache under .next; apply-schema writes /app/.schema-applied
RUN chown -R node:node /app
USER node
WORKDIR /app/frontend

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# next start, listening on all interfaces (package.json's start script binds 127.0.0.1 for team computers)
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
