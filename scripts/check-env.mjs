#!/usr/bin/env node
// Production environment validation. Reports missing or weak REQUIRED variables BY NAME ONLY: no value, no prefix, no length of
// a value other than "shorter than N" is ever printed. Exit 0 = every check passed, 1 = at least one failed, 2 = bad usage.
//
//   node scripts/check-env.mjs                      # validate process.env (e.g. in a deploy step, with the secrets injected)
//   node scripts/check-env.mjs path/to/prod.env     # validate a dotenv-style file (KEY=VALUE, `export `, quotes, # comments)
//   node scripts/check-env.mjs --json [file]        # machine-readable result (names and reasons only)
//
// It reads; it never contacts Stripe, Supabase or the engine, and it never writes a file. The rules mirror docs/10_PAYG_LAUNCH_CHECKLIST.md
// section 1 step 5 and .env.example; a check here is a floor, not proof the credential is live (that is production-smoke's job).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = /^(changeme|change-me|change_me|replace[-_ ]?me|todo|tbd|xxx+|your[-_ ].*|example.*|test|secret|password|<.*>|\$\{.*\})$/i;

/** @returns {Record<string,string>} KEY -> value from dotenv text. */
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, "");
    env[m[1]] = v;
  }
  return env;
}

const isHttps = (v) => { try { const u = new URL(v); return u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname); } catch { return false; } };

/**
 * Each rule returns null when the value is acceptable, else a short reason. Reasons never contain the value.
 * `env` is the whole environment so a rule can compare two variables.
 */
const RULES = [
  ["ADMIN_SESSION_SECRET", (v, env) => (v.length < 32 ? "shorter than 32 characters" : env.ADMIN_PASSWORD && v.includes(env.ADMIN_PASSWORD) ? "equal to or containing ADMIN_PASSWORD (must be a separate value; the site refuses admin sessions otherwise)" : null)],
  ["CRON_SECRET", (v) => (v.length < 16 ? "shorter than 16 characters" : null)],
  ["STRIPE_WEBHOOK_SECRET", (v) => (!v.startsWith("whsec_") ? "does not start with whsec_" : v.length < 20 ? "too short to be a signing secret" : null)],
  ["STRIPE_SECRET_KEY", (v) => (!/^(sk|rk)_(live|test)_/.test(v) ? "not an sk_/rk_ Stripe key" : null)],
  ["SUPABASE_URL", (v) => (!isHttps(v) ? "not a public https URL" : null)],
  ["SUPABASE_SERVICE_ROLE_KEY", (v) => (v.length < 40 ? "shorter than 40 characters" : null)],
  ["GRIDFORGE_API_URL", (v) => (!isHttps(v) ? "not a public https URL (a production site cannot reach localhost)" : null)],
  ["NEXT_PUBLIC_SITE_URL", (v) => (!isHttps(v) ? "not a public https URL" : /\/$/.test(v) ? "has a trailing slash" : null)],
  ["GRIDFORGE_KEY_SECRET", (v) => (v.length < 32 ? "shorter than 32 characters" : null)],
  ["FUNNEL_REF_KEY", (v) => (v.length < 16 ? "shorter than 16 characters" : null)],
];

/** Cross-variable checks that need more than one value. Reasons name variables only. */
const PAIRS = [
  (env) => (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12 ? ["ADMIN_PASSWORD", "shorter than 12 characters"] : null),
  (env) => (env.GRIDFORGE_KEY_SECRET && env.ADMIN_SESSION_SECRET && env.GRIDFORGE_KEY_SECRET === env.ADMIN_SESSION_SECRET ? ["ADMIN_SESSION_SECRET", "identical to GRIDFORGE_KEY_SECRET (one secret must not serve two purposes)"] : null),
];

/** @returns {{ok:boolean, problems:{name:string, reason:string}[], warnings:{name:string, reason:string}[], checked:number}} */
export function checkEnv(env) {
  const problems = [];
  const warnings = [];
  for (const [name, rule] of RULES) {
    const v = env[name];
    if (v === undefined || v === "") { problems.push({ name, reason: "missing" }); continue; }
    if (PLACEHOLDER.test(v.trim())) { problems.push({ name, reason: "looks like a placeholder" }); continue; }
    const why = rule(v, env);
    if (why) problems.push({ name, reason: why });
  }
  for (const pair of PAIRS) {
    const p = pair(env);
    if (p) problems.push({ name: p[0], reason: p[1] });
  }
  if (/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY ?? "")) warnings.push({ name: "STRIPE_SECRET_KEY", reason: "is a TEST-mode key (expected only before go-live)" });
  if (!env.ADMIN_PASSWORD) warnings.push({ name: "ADMIN_PASSWORD", reason: "unset: /admin is disabled" });
  return { ok: problems.length === 0, problems, warnings, checked: RULES.length };
}

function main(argv) {
  const json = argv.includes("--json");
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length > 1 || argv.some((a) => a.startsWith("--") && a !== "--json")) {
    console.error("usage: node scripts/check-env.mjs [--json] [env-file]");
    return 2;
  }
  let env = process.env;
  if (files[0]) {
    try { env = parseEnv(readFileSync(files[0], "utf8")); } catch (e) { console.error(`cannot read ${files[0]}: ${e.code ?? "error"}`); return 2; }
  }
  const r = checkEnv(env);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const p of r.problems) console.log(`FAIL  ${p.name}: ${p.reason}`);
    for (const w of r.warnings) console.log(`WARN  ${w.name}: ${w.reason}`);
    console.log(r.ok ? `ok: ${r.checked} required variables present and strong enough` : `${r.problems.length} problem(s)`);
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
