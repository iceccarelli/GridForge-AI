#!/usr/bin/env node
// Read-only smoke check of a DEPLOYED site: public GETs only, no credentials, nothing written.
//
//   node scripts/production-smoke.mjs [--base URL] [--attempts N] [--interval SECONDS] [--summary-file F]
//
// After a merge to main the new deployment takes a minute or two to go live, so the whole suite is retried until it passes or
// the attempts run out (default 12 x 30 s). The exit code is 0 only when every check passes in one attempt. The checks are in
// scripts/production-smoke-checks.mjs.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./production-smoke-checks.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
export function parseArgs(argv, env = process.env) {
  const o = { base: env.SMOKE_BASE_URL || "https://timetopower.ai", attempts: 12, interval: 30, summary: env.GITHUB_STEP_SUMMARY || "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--base") o.base = v();
    else if (a === "--attempts") o.attempts = Number(v());
    else if (a === "--interval") o.interval = Number(v());
    else if (a === "--summary-file") o.summary = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^https?:\/\//.test(o.base)) throw new Error("--base must be an http(s) URL");
  if (!Number.isInteger(o.attempts) || o.attempts < 1 || o.attempts > 60) throw new Error("--attempts must be 1..60");
  if (!(o.interval >= 0) || o.interval > 300) throw new Error("--interval must be 0..300 seconds");
  o.base = o.base.replace(/\/$/, "");
  return o;
}

async function fetchOne(base, p) {
  const res = await fetch(base + p, { redirect: "follow", signal: AbortSignal.timeout(25_000), headers: { "user-agent": "gridforge-production-smoke/1" } });
  const headers = Object.fromEntries(res.headers.entries());
  return { status: res.status, headers, body: await res.text() };
}

export async function main(argv, io = {}) {
  const o = parseArgs(argv);
  const sleep = io.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const get = io.fetchOne ?? ((p) => fetchOne(o.base, p));
  let last = [];
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    last = await runChecks(get);
    const failed = last.filter((c) => c.problems.length);
    console.log(`attempt ${attempt}/${o.attempts}: ${last.length - failed.length}/${last.length} checks pass`);
    if (!failed.length) break;
    if (attempt < o.attempts) await sleep(o.interval);
  }
  const failed = last.filter((c) => c.problems.length);
  const lines = [`## Production smoke: ${o.base}`, "", ...last.map((c) => `- ${c.problems.length ? "FAIL" : "ok"}: ${c.name} (${c.path})${c.problems.length ? "\n" + c.problems.map((x) => `    - ${x}`).join("\n") : ""}`)];
  console.log(lines.join("\n"));
  if (o.summary) appendFileSync(o.summary, lines.join("\n") + "\n");
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
}
