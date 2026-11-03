import type { NextConfig } from "next";
import { securityHeaderRules } from "./lib/security-headers";

const nextConfig: NextConfig = {
  images: {
    // AVIF first, WebP as the fallback: the browser's Accept header picks. Optimised variants are cached for a year (the sources are
    // content-addressed by file name and never change in place).
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31536000,
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
  async headers() {
    return securityHeaderRules();
  },
  // The Observatory routes are rendered per request and read the generated scenario file from disk
  // (lib/observatory/scenario-data.ts builds the path at run time, which file tracing cannot see). Without this, the
  // serverless function ships without the file and the page can only say "the demonstration data cannot be shown".
  outputFileTracingIncludes: {
    "/observatory": ["./public/observatory/scenarios.json"],
    "/observatory/presenter": ["./public/observatory/scenarios.json"],
  },
};

export default nextConfig;
