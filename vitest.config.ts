import { defineConfig } from "vitest/config";
import path from "node:path";

// The site layer had no executable test of any kind. Every assertion about a
// Next.js route was a regex over its source text, run from Python — which can see
// that a handler mentions `status: 403` and can never see whether it returns one.
// These tests import the real route modules and call them with real Request
// objects, so authorization, cross-tenant access, malformed input and duplicate
// delivery are exercised rather than described.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/site/**/*.test.ts"],
    // Each file installs its own fetch stub and environment; sharing a process
    // would let one file's stub answer another file's request.
    isolate: true,
    pool: "forks",
  },
});
