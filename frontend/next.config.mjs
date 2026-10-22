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
