#!/usr/bin/env node
// A page rendered per request that reads a file with a path built at run time (path.join(process.cwd(), ...)) cannot be
// seen by Next's file tracing, so its serverless function ships WITHOUT the file. Locally `next start` reads from disk and
// everything works; in production the page can only say its data is missing. This checks the build's own trace output
// (.next/server/**/page.js.nft.json) for each route below, after `npm run build`.
//
//   node scripts/check-runtime-files.mjs
//
// Add a row when a dynamic route starts reading a file from the repository at run time.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const REQUIRED = [
  { route: "app/observatory/page.js.nft.json", file: "public/observatory/scenarios.json" },
  { route: "app/observatory/presenter/page.js.nft.json", file: "public/observatory/scenarios.json" },
];

export function missing(root = ".next/server", required = REQUIRED) {
  const problems = [];
  for (const { route, file } of required) {
    const manifest = path.join(root, route);
    if (!existsSync(manifest)) {
      problems.push(`${route}: no trace manifest (was the build run, and is the route still dynamic?)`);
      continue;
    }
    const files = JSON.parse(readFileSync(manifest, "utf8")).files ?? [];
    if (!files.some((f) => f.replace(/\\/g, "/").endsWith(file))) problems.push(`${route}: the trace does not include ${file}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const problems = missing();
  if (problems.length) {
    console.error("A route would ship without a file it reads:\n  " + problems.join("\n  ") + "\nAdd it to outputFileTracingIncludes in next.config.ts.");
    process.exit(1);
  }
  console.log(`runtime files are traced for ${REQUIRED.length} routes`);
}
