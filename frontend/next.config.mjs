import { existsSync } from "node:fs";

// On a team computer the server-only settings (SUPABASE_KEY for the PS-PhilGEPS Sync, ...) live in the
// repo root's .env, next to the scraper. A deployed copy has no such file and uses its host's settings.
if (existsSync("../.env")) process.loadEnvFile("../.env");

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
  // Basic hardening: no framing (clickjacking of the scrape button), no MIME sniffing,
  // no referrer sent to PhilGEPS or other sites, no device APIs
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
