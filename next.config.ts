import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
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
