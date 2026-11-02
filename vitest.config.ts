import { defineConfig } from "vitest/config";
import path from "node:path";

// The site layer had no executable test of any kind. Every assertion about a
// Next.js route was a regex over its source text, run from Python — which can see
// that a handler mentions `status: 403` and can never see whether it returns one.
// These tests import the real route modules and call them with real Request
// objects, so authorization, cross-tenant access, malformed input and duplicate
// delivery are exercised rather than described.
export default defineConfig({
  // Components are written for Next's automatic JSX runtime; render them the same way in tests.
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    environment: "node",
    include: ["tests/site/**/*.test.ts"],
    // Each file installs its own fetch stub and environment; sharing a process
    // would let one file's stub answer another file's request.
    isolate: true,
    pool: "forks",
    // The first test in a file imports a real route module (the Next route graph, the catalogue, the engine client) cold; on a loaded CI
    // runner that took longer than the 5 s default and failed two tests that pass in about a second on a warm import. A generous limit
    // changes nothing about what is asserted; it only stops a slow import from reading as a defect.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
