import { existsSync } from "node:fs";

// On a team computer the server-only settings (SUPABASE_KEY for the PS-PhilGEPS Sync, ...) live in the
// repo root's .env, next to the scraper. A deployed copy has no such file and uses its host's settings.
if (existsSync("../.env")) process.loadEnvFile("../.env");

// The dashboard's own pages and scripts, Supabase (data, sign-in, Storage, live updates) and
// pictures/files made in the browser (log-in pictures, Excel and ZIP downloads, Word previews)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // The PhilGEPS fetch progress ring sits bottom-left
  devIndicators: { position: "bottom-right" },
  // OCR of scanned bid documents (src/lib/ocr.mjs): tesseract.js starts a worker thread from its own files and
  // loads its WebAssembly and English model from disk, so it runs from node_modules (not bundled) and those
  // files are shipped with the API routes that read documents
  serverExternalPackages: ["tesseract.js", "@tesseract.js-data/eng"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/tesseract.js/src/**/*",
      "./node_modules/tesseract.js-core/*.{js,wasm,json}",
      "./node_modules/@tesseract.js-data/eng/package.json",
      "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/*",
    ],
  },
  // PS-PhilGEPS Bid Match is part of the merged Bid Match at / (user, 2026-11-06): old links and bookmarks go there
  async redirects() {
    return [{ source: "/ps-philgeps", destination: "/", permanent: false }];
  },
  // Basic hardening: no framing (clickjacking of the scrape button), no MIME sniffing,
  // no referrer sent to PhilGEPS or other sites, no device APIs, never listed by search engines.
  // The Content-Security-Policy only reports for now (browser console): it is enforced once a few days
  // of normal use show no page needs more than it allows
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
