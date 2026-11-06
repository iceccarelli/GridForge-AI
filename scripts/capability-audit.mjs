#!/usr/bin/env node
// Read-only cross-check of lib/capability-registry.ts against the code it describes.
//
//   node scripts/capability-audit.mjs [--json]
//
// No dependencies, no network, no writes. For every registry entry it verifies that each layer the entry names exists:
//
//   rest_endpoint            is served: a key of ROUTES or an entry of GET_ROUTES in gridforge/api/server.py ("/v1/*" must match a route)
//   mcp_tool                 is a tool in gridforge/api/tools.py, and that tool's endpoint is the entry's rest_endpoint
//   cli_command              is a subcommand of gridforge/cli.py; "gridforge calibration report" needs `report` under `calibration` itself
//   web_route                is spelled exactly like an app/ page or route handler (so /watch/[token], never /watch/abc), no trailing slash
//   stripe_product_or_price  metadata.kind / metadata.plan / mode agree with lib/products.ts (PRODUCTS / INTELLIGENCE_PLANS); a kind that is
//                            not a catalogue product must be one the Stripe webhook (or lib/payg-billing.ts) actually compares `kind` to
//   database_record          every table or view it names is created in supabase/migrations
//   engine_capability        every file it cites exists (and `file:name` names something defined in it)
//   production_status        live: concrete rest_endpoint listed in lib/engine-deployed.json. not_deployed: concrete and NOT listed.
//                            unverified: anything else (its note must say so). A missing or other value fails.
//   status                   a commercial entry says what it is sold under: product_id, intelligence_plan_id or included_in
//
// and the other direction: every non-internal ROUTES entry, every GET_ROUTES entry (bar a short list of documented non-capabilities) and
// every MCP tool must be named by some entry, so a capability added to the engine and forgotten here fails this audit instead of staying
// invisible. The ROUTES / GET_ROUTES parser throws on any entry shape it cannot read (3-tuples, lambdas, comments, single quotes, a
// variable tier, a later assignment to the dict); it never skips what it does not understand.
//
// Exit 0: every check passed. Exit 1: at least one mismatch (the table says which). The same functions are imported by
// tests/site/capability-registry-fields.test.ts, which also feeds them deliberately broken sources to prove each check can fail.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------------------------------------------------------------
// The registry: a small lexer for the object literals in lib/capability-registry.ts. It reads the file as text because the module
// imports "@/lib/products" (a path alias plain node cannot resolve) and is TypeScript.
// ---------------------------------------------------------------------------------------------------------------------------------

function lex(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { out += src[j + 1] === "n" ? "\n" : src[j + 1]; j += 2; } else out += src[j++];
      }
      toks.push({ t: "str", v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      toks.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      toks.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    toks.push({ t: "p", v: c });
    i++;
  }
  return toks;
}

/** Parse one value starting at toks[i]: string literals joined by "+", null, or an opaque expression skipped to the next top-level , or }. */
function readValue(toks, i) {
  if (toks[i].t === "str") {
    let v = toks[i].v;
    i++;
    while (toks[i] && toks[i].t === "p" && toks[i].v === "+" && toks[i + 1] && toks[i + 1].t === "str") { v += toks[i + 1].v; i += 2; }
    return [v, i];
  }
  if (toks[i].t === "id" && toks[i].v === "null") return [null, i + 1];
  let depth = 0;
  const start = i;
  while (i < toks.length) {
    const p = toks[i];
    if (p.t === "p" && "([{".includes(p.v)) depth++;
    else if (p.t === "p" && ")]}".includes(p.v)) { if (depth === 0) break; depth--; }
    else if (p.t === "p" && p.v === "," && depth === 0) break;
    i++;
  }
  return [toks.slice(start, i).map((x) => x.v).join(" "), i];
}

/** Every top-level object literal in `export const CAPABILITY_REGISTRY: Capability[] = [ ... ]`, as { key: string | null }. */
export function parseRegistry(src) {
  const toks = lex(src);
  let i = toks.findIndex((t) => t.t === "id" && t.v === "CAPABILITY_REGISTRY");
  if (i < 0) throw new Error("CAPABILITY_REGISTRY not found");
  while (i < toks.length && !(toks[i].t === "p" && toks[i].v === "=")) i++;
  i++;
  if (!(toks[i] && toks[i].v === "[")) throw new Error("CAPABILITY_REGISTRY is not an array literal");
  i++;
  const entries = [];
  while (i < toks.length && !(toks[i].t === "p" && toks[i].v === "]")) {
    if (toks[i].v === ",") { i++; continue; }
    if (toks[i].v !== "{") throw new Error(`unexpected token in the registry array: ${toks[i].v}`);
    i++;
    const obj = {};
    while (!(toks[i].t === "p" && toks[i].v === "}")) {
      if (toks[i].v === ",") { i++; continue; }
      const key = toks[i].v;
      if (!(toks[i + 1] && toks[i + 1].v === ":")) throw new Error(`malformed property near "${key}"`);
      const [value, next] = readValue(toks, i + 2);
      obj[key] = value;
      i = next;
    }
    i++; // }
    entries.push(obj);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The layers it is checked against.
// ---------------------------------------------------------------------------------------------------------------------------------

function between(src, startRe, openCh, closeCh) {
  const m = startRe.exec(src);
  if (!m) throw new Error(`${startRe} not found`);
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

/** Split on top-level commas, honouring quotes and brackets. */
function splitTop(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === "\\") cur += body[++i] ?? ""; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** { routes: Map<path, tier>, get: string[] } from gridforge/api/server.py. Throws on anything it cannot read exactly. */
export function parseEngineRoutes(server) {
  for (const name of ["ROUTES", "GET_ROUTES"]) {
    const defs = server.match(new RegExp(`^${name}\\s*(?::[^=\\n]+)?=`, "gm")) ?? [];
    if (defs.length !== 1) throw new Error(`${name} must be assigned exactly once at module level in gridforge/api/server.py (found ${defs.length})`);
  }
  const mutation = /\b(?:GET_)?ROUTES\s*(?:\[[^\]\n]*\]\s*=(?!=)|\.\s*(?:update|setdefault|pop|popitem|clear)\s*\(|(?:\|=|\+=|-=))/.exec(server);
  if (mutation) throw new Error(`ROUTES / GET_ROUTES is changed after its definition (${JSON.stringify(mutation[0])}); the audit cannot see that route`);
  const body = between(server, /^ROUTES\s*(?::[^=\n]+)?=\s*\{/m, "{", "}");
  if (body.includes("#")) throw new Error("ROUTES contains a comment; the audit does not guess whether it hides an entry");
  const routes = new Map();
  for (const entry of splitTop(body)) {
    const m = /^"(\/[^"]*)"\s*:\s*\(\s*(\w+)\s*,\s*Tier\.(\w+)\s*\)$/.exec(entry);
    if (!m) throw new Error(`cannot parse the ROUTES entry ${JSON.stringify(entry)}; expected "/path": (handler, Tier.NAME)`);
    if (routes.has(m[1])) throw new Error(`ROUTES lists ${m[1]} twice`);
    routes.set(m[1], m[3]);
  }
  const getBody = between(server, /^GET_ROUTES\s*(?::[^=\n]+)?=\s*\(/m, "(", ")");
  if (getBody.includes("#")) throw new Error("GET_ROUTES contains a comment; the audit does not guess whether it hides an entry");
  const get = [];
  for (const entry of splitTop(getBody)) {
    const m = /^"(\/[^"]*)"$/.exec(entry);
    if (!m) throw new Error(`cannot parse the GET_ROUTES entry ${JSON.stringify(entry)}; expected a double-quoted path`);
    get.push(m[1]);
  }
  if (routes.size === 0 || get.length === 0) throw new Error("could not read ROUTES / GET_ROUTES from gridforge/api/server.py");
  return { routes, get };
}

/** Map<tool name, endpoint> from gridforge/api/tools.py. */
export function parseTools(tools) {
  const start = tools.indexOf("TOOLS: list[dict] = [");
  const end = tools.indexOf("TOOLS_BY_NAME");
  if (start < 0 || end < 0) throw new Error("could not find the TOOLS list in gridforge/api/tools.py");
  const out = new Map();
  for (const chunk of tools.slice(start, end).split("_tool(").slice(1)) {
    const name = /"(gridforge_\w+)"/.exec(chunk);
    // The endpoint is the one string literal that is exactly a route; a summary that merely mentions a route is longer than that.
    const endpoint = /"(\/(?:v1\/[\w/]+|mcp))"/.exec(chunk);
    if (name) out.set(name[1], endpoint ? endpoint[1] : null);
  }
  if (out.size === 0) throw new Error("no tools read from gridforge/api/tools.py");
  return out;
}

/** { top: Set<name>, nested: Map<parent name, Set<name>> } of argparse subcommands in gridforge/cli.py. */
export function parseCli(cli) {
  const top = new Set();
  const nested = new Map();
  const parserOf = new Map(); // variable -> the subcommand name it was last assigned from
  const groupOf = new Map(); // subparsers variable -> parent subcommand name, or null for the top level
  let topVar = null;
  for (const line of cli.split("\n")) {
    let m = /^\s*(\w+)\s*=\s*(\w+)\.add_subparsers\(/.exec(line);
    if (m) {
      if (topVar === null) { topVar = m[1]; groupOf.set(m[1], null); } else groupOf.set(m[1], parserOf.get(m[2]) ?? `?${m[2]}`);
      continue;
    }
    m = /^\s*(?:(\w+)\s*=\s*)?(\w+)\.add_parser\(\s*"([\w-]+)"/.exec(line);
    if (m) {
      const [, assignedTo, group, name] = m;
      if (!groupOf.has(group)) continue;
      const parent = groupOf.get(group);
      if (parent === null) top.add(name);
      else { if (!nested.has(parent)) nested.set(parent, new Set()); nested.get(parent).add(name); }
      if (assignedTo) parserOf.set(assignedTo, name);
      continue;
    }
    // `s = sub.add_parser(name, ...)` inside `for name, fn, help in (("screen", cmd_screen, ...), ...)`: one add_parser, several names.
    for (const t of line.matchAll(/\(\s*"([\w-]+)"\s*,\s*cmd_\w+/g)) top.add(t[1]);
  }
  if (topVar === null) throw new Error("no add_subparsers() found in gridforge/cli.py");
  return { top, nested };
}

/** { products: Map<id, {kind, recurring}>, plans: Map<id, {kind}> } from lib/products.ts. */
export function parseProducts(src) {
  const blockOf = (re) => between(src, re, "{", "}");
  const products = new Map();
  const pBody = blockOf(/export const PRODUCTS:[^=]*=\s*\{/);
  const heads = [...pBody.matchAll(/^ {2}(\w+):\s*\{/gm)];
  heads.forEach((h, n) => {
    const text = pBody.slice(h.index, n + 1 < heads.length ? heads[n + 1].index : pBody.length);
    const kind = /\bkind:\s*"(\w+)"/.exec(text);
    products.set(h[1], { kind: kind ? kind[1] : null, recurring: /\brecurring:\s*\{/.test(text) });
  });
  const plans = new Map();
  const iBody = blockOf(/export const INTELLIGENCE_PLANS:[^=]*=\s*\{/);
  const iheads = [...iBody.matchAll(/^ {2}(\w+):\s*\{/gm)];
  iheads.forEach((h, n) => {
    const text = iBody.slice(h.index, n + 1 < iheads.length ? iheads[n + 1].index : iBody.length);
    const kind = /\bkind:\s*"(\w+)"/.exec(text);
    plans.set(h[1], { kind: kind ? kind[1] : null });
  });
  if (products.size === 0 || plans.size === 0) throw new Error("could not read PRODUCTS / INTELLIGENCE_PLANS from lib/products.ts");
  return { products, plans };
}

/** Every app/ route as an array of segments (route groups removed). */
export function appRoutes(root) {
  const out = [];
  const walk = (dir, segs) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), /^\(.*\)$/.test(e.name) ? segs : [...segs, e.name]);
      else if (/^(page|route)\.(tsx|ts|jsx|js)$/.test(e.name)) out.push(segs);
    }
  };
  walk("app", []);
  return out;
}

/** The route must be spelled exactly like an app/ path: `/watch/[token]`, not `/watch/abc`, and no trailing slash, query or fragment. */
export function webRouteResolves(route, routes) {
  if (typeof route !== "string" || !route.startsWith("/")) return false;
  if ((route !== "/" && route.endsWith("/")) || route.includes("//") || /[?#\s]/.test(route)) return false;
  const want = route === "/" ? [] : route.slice(1).split("/");
  return routes.some((segs) => segs.length === want.length && segs.every((s, i) => s === want[i]));
}

/** Names of tables and views created in supabase/migrations (text given, or every .sql file there). */
export function migrationRelations(text) {
  const out = new Set();
  for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)) out.add(m[1]);
  return out;
}

/** The relation names a database_record string claims: parentheses dropped, split on commas and "then", first word of each part. */
export function databaseRelations(text) {
  let t = String(text);
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(/\([^()]*\)/g, " "); }
  return t.split(/,|\bthen\b/).map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
}

function listFiles(root, dir, re) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(rel); } else if (re.test(e.name)) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The audit.
// ---------------------------------------------------------------------------------------------------------------------------------

const MCP_ALL = "all gridforge_* tools";
const STATUSES = new Set(["commercial", "metered_only", "free", "internal_only"]);
const FAMILIES = new Set(["engagement", "recurring", "api", "intelligence", "btm", "free_tier", "project"]);
const PRODUCTION = new Set(["live", "not_deployed", "unverified"]);
const REQUIRED_KEYS = ["capability_id", "family", "name", "description", "engine_capability", "rest_endpoint", "mcp_tool", "cli_command", "web_route", "workspace_action", "database_record", "entitlement", "stripe_product_or_price", "deliverable", "status", "production_status"];

/** GET routes that are not capabilities anyone buys or calls for a result. A route here that is not in GET_ROUTES fails (the list cannot rot). */
export const NON_CAPABILITY_GET = {
  "/health": "liveness probe",
  "/v1/version": "the public list of routes, rates and provenance",
  "/v1/platforms": "the platform catalogue, a reference table",
  "/v1/intake/template": "a blank intake document",
  "/v1/tools": "the tool catalogue (reference for gridforge_* tools)",
  "/v1/usage": "the caller's own metering counters",
  "/v1/calibration": "the public accuracy statement; the read model of the ledger calibration_capture feeds",
};

/**
 * Run every check. `sources` replaces the text of a file (registry, server, tools, cli, products, deployed, migrations, webhook) so a test can
 * break exactly one thing and prove the audit notices; anything not replaced is read from `root`.
 * Returns { rows: [{ id, checks: [{ field, ok, detail }] }], failures: string[] }.
 */
export function audit({ root = REPO_ROOT, sources = {} } = {}) {
  const read = (key, rel) => (sources[key] !== undefined ? sources[key] : fs.readFileSync(path.join(root, rel), "utf8"));
  const registry = parseRegistry(read("registry", "lib/capability-registry.ts"));
  const { routes, get } = parseEngineRoutes(read("server", "gridforge/api/server.py"));
  const tools = parseTools(read("tools", "gridforge/api/tools.py"));
  const cli = parseCli(read("cli", "gridforge/cli.py"));
  const { products, plans } = parseProducts(read("products", "lib/products.ts"));
  const deployed = new Set(JSON.parse(read("deployed", "lib/engine-deployed.json")).endpoints);
  const relations = migrationRelations(
    sources.migrations !== undefined ? sources.migrations : listFiles(root, "supabase/migrations", /\.sql$/).map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n")
  );
  const pages = appRoutes(root);
  const served = new Set([...routes.keys(), ...get]);

  // The Stripe kinds that exist: every catalogue kind, and every kind the webhook (or the pay-as-you-go handlers it calls) compares `kind` to.
  // Comments are stripped first: a kind mentioned in a comment is not a kind the code compares.
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const handledText = [read("webhook", "app/api/stripe/webhook/route.ts"), fs.readFileSync(path.join(root, "lib/payg-billing.ts"), "utf8")].map(code).join("\n");
  const knownKinds = new Set([...[...products.values()].map((p) => p.kind), ...[...plans.values()].map((p) => p.kind)]);
  for (const m of handledText.matchAll(/\bkind\s*[!=]==\s*"(\w+)"/g)) knownKinds.add(m[1]);

  const rows = [];
  const failures = [];
  const seen = new Set();

  for (const e of registry) {
    const id = e.capability_id ?? "(no capability_id)";
    const checks = [];
    const check = (field, ok, detail) => {
      checks.push({ field, ok, detail: ok ? "" : detail });
      if (!ok) failures.push(`${id}: ${field}: ${detail}`);
    };

    check("capability_id", typeof e.capability_id === "string" && e.capability_id !== "" && !seen.has(e.capability_id), `missing or duplicate id "${e.capability_id}"`);
    seen.add(e.capability_id);
    for (const k of REQUIRED_KEYS) check(k, Object.hasOwn(e, k) && e[k] !== undefined, `the field ${k} is missing`);
    for (const k of ["name", "description", "engine_capability", "entitlement"]) check(k, typeof e[k] === "string" && e[k].trim() !== "", `${k} must be a non-empty string`);
    check("family", FAMILIES.has(e.family), `family "${e.family}" is not one of ${[...FAMILIES].join(", ")}`);
    check("status", STATUSES.has(e.status), `status "${e.status}" is not one of ${[...STATUSES].join(", ")}`);
    check("production_status", PRODUCTION.has(e.production_status), `production_status "${e.production_status}" is not one of ${[...PRODUCTION].join(", ")}`);

    // rest_endpoint
    const rest = e.rest_endpoint;
    const wildcard = typeof rest === "string" && rest.includes("*");
    const concrete = typeof rest === "string" && rest !== "" && !wildcard;
    if (rest) {
      if (wildcard) {
        const prefix = rest.slice(0, rest.indexOf("*"));
        check("rest_endpoint", [...routes.keys()].some((r) => r.startsWith(prefix)), `${rest} matches no route in ROUTES`);
      } else {
        check("rest_endpoint", served.has(rest), `${rest} is in neither ROUTES nor GET_ROUTES of gridforge/api/server.py`);
      }
    }

    // production_status: machine-proven or not claimed.
    const inSnapshot = concrete && deployed.has(rest);
    if (e.production_status === "live") {
      if (!concrete) check("production_status", false, `marked live but its rest_endpoint is ${rest == null ? "null" : "a wildcard"}; only a concrete route listed in lib/engine-deployed.json can be live`);
      else check("production_status", inSnapshot, `marked live but ${rest} is not in lib/engine-deployed.json`);
    } else if (e.production_status === "not_deployed") {
      if (!concrete) check("production_status", false, `marked not_deployed but its rest_endpoint is ${rest == null ? "null" : "a wildcard"}; not_deployed means a concrete route absent from lib/engine-deployed.json`);
      else check("production_status", !inSnapshot, `marked not_deployed but ${rest} is in lib/engine-deployed.json (the entry is stale)`);
    } else if (e.production_status === "unverified") {
      check("notes", typeof e.notes === "string" && /production state is unverified/.test(e.notes), `an unverified entry's notes must say plainly that its "production state is unverified"`);
    }

    // mcp_tool
    const mcp = e.mcp_tool;
    if (mcp && mcp !== MCP_ALL) {
      check("mcp_tool", tools.has(mcp), `${mcp} is not a tool in gridforge/api/tools.py`);
      if (tools.has(mcp) && concrete) check("mcp_tool", tools.get(mcp) === rest, `${mcp} calls ${tools.get(mcp)}, not ${rest}`);
    } else if (mcp === MCP_ALL) {
      check("mcp_tool", wildcard, `"${MCP_ALL}" only fits an entry whose rest_endpoint is a /v1/* wildcard`);
    }

    // cli_command: nested names belong to their own parent.
    if (e.cli_command) {
      const words = String(e.cli_command).split(/\s+/);
      const ok = words[0] === "gridforge" && cli.top.has(words[1]) && words.length <= 3 && (words.length < 3 || Boolean(cli.nested.get(words[1])?.has(words[2])));
      check("cli_command", ok, `"${e.cli_command}" is not a subcommand of gridforge/cli.py`);
    }

    // web_route
    if (e.web_route) check("web_route", webRouteResolves(e.web_route, pages), `${e.web_route} is not spelled like any page or route handler under app/ (use the directory names, e.g. /watch/[token])`);

    // database_record: every relation it names is created by a migration.
    if (e.database_record != null) {
      const names = databaseRelations(e.database_record);
      check("database_record", names.length > 0, `"${e.database_record}" names no table`);
      for (const n of names) check("database_record", relations.has(n), `${n} is not a table or view created in supabase/migrations`);
    }

    // engine_capability: every file it cites exists, and `file:name` is defined there.
    {
      const text = String(e.engine_capability ?? "");
      const cited = [...text.matchAll(/\b((?:gridforge|lib|app)\/[\w./\[\]-]*?\.(?:py|tsx|ts))(?::(\w+))?/g)];
      if (cited.length === 0) check("engine_capability", /^\s*(n\/a|none)\b/i.test(text), `"${text.slice(0, 60)}" cites no file and does not say n/a or none`);
      for (const [, file, fn] of cited) {
        const full = path.join(root, file);
        const exists = fs.existsSync(full);
        check("engine_capability", exists, `${file} does not exist`);
        if (exists && fn) check("engine_capability", new RegExp(`\\b(?:def|class|function|const)\\s+${fn}\\b`).test(fs.readFileSync(full, "utf8")), `${fn} is not defined in ${file}`);
      }
    }

    // stripe_product_or_price
    const stripe = e.stripe_product_or_price;
    const claimedKinds = typeof stripe === "string" ? [...stripe.matchAll(/metadata\.kind=(\w+)/g)].map((m) => m[1]) : [];
    if (e.product_id || e.intelligence_plan_id) {
      if (e.product_id) {
        const p = products.get(e.product_id);
        check("product_id", Boolean(p), `${e.product_id} is not in PRODUCTS (lib/products.ts)`);
        if (p) {
          check("stripe_product_or_price", claimedKinds[0] === p.kind, `claims kind ${claimedKinds[0] ?? "none"}, lib/products.ts says ${p.kind}`);
          const mode = typeof stripe === "string" && stripe.startsWith("subscription") ? "subscription" : "checkout.session";
          check("stripe_product_or_price", mode === (p.recurring ? "subscription" : "checkout.session"), `says ${mode}, but ${e.product_id} is ${p.recurring ? "recurring" : "one-time"} in lib/products.ts`);
        }
      }
      if (e.intelligence_plan_id) {
        const p = plans.get(e.intelligence_plan_id);
        const planM = typeof stripe === "string" ? /metadata\.plan=(\w+)/.exec(stripe) : null;
        check("intelligence_plan_id", Boolean(p), `${e.intelligence_plan_id} is not in INTELLIGENCE_PLANS (lib/products.ts)`);
        if (p) {
          check("stripe_product_or_price", claimedKinds[0] === p.kind, `claims kind ${claimedKinds[0] ?? "none"}, lib/products.ts says ${p.kind}`);
          check("stripe_product_or_price", planM !== null && planM[1] === e.intelligence_plan_id, `claims plan ${planM ? planM[1] : "none"}, expected ${e.intelligence_plan_id}`);
          check("stripe_product_or_price", typeof stripe === "string" && stripe.startsWith("subscription"), `an Intelligence plan is a subscription; this says "${String(stripe).split(",")[0]}"`);
        }
      }
    } else if (stripe && stripe !== "none") {
      check("stripe_product_or_price", claimedKinds.length > 0, `"${stripe}" names no metadata.kind`);
    } else {
      check("stripe_product_or_price", stripe === "none" || stripe === null, `expected "none" or null, found "${stripe}"`);
    }
    for (const k of claimedKinds) check("stripe_product_or_price", knownKinds.has(k), `kind ${k} is neither in lib/products.ts nor compared against \`kind\` by the Stripe webhook or lib/payg-billing.ts`);

    // commercial means "sold under something"; included_in names what a mechanism is included in.
    const included = e.included_in == null ? [] : String(e.included_in).match(/\w+/g) ?? [];
    for (const inc of included) check("included_in", products.has(inc) || plans.has(inc), `${inc} is in neither PRODUCTS nor INTELLIGENCE_PLANS`);
    if (e.status === "commercial") {
      check("status", Boolean(e.product_id || e.intelligence_plan_id) || included.length > 0, "commercial but sold under nothing: set product_id, intelligence_plan_id or included_in");
    }

    rows.push({ id, e, checks });
  }

  // The other direction: engine capabilities nobody wrote down.
  const named = new Set(registry.map((e) => e.rest_endpoint).filter(Boolean));
  const namedTools = new Set(registry.map((e) => e.mcp_tool).filter(Boolean));
  const coverage = [];
  for (const [route, tier] of routes) {
    if (tier === "INTERNAL") continue;
    if (!named.has(route)) coverage.push(`route ${route} (gridforge/api/server.py ROUTES) has no registry entry`);
  }
  for (const route of get) {
    if (!named.has(route) && !(route in NON_CAPABILITY_GET)) coverage.push(`GET route ${route} (gridforge/api/server.py GET_ROUTES) has no registry entry and is not a listed non-capability`);
  }
  for (const route of Object.keys(NON_CAPABILITY_GET)) {
    if (!get.includes(route)) coverage.push(`NON_CAPABILITY_GET lists ${route}, which is not in GET_ROUTES`);
  }
  for (const [tool] of tools) {
    if (!namedTools.has(tool)) coverage.push(`MCP tool ${tool} (gridforge/api/tools.py) has no registry entry`);
  }
  for (const c of coverage) failures.push(`coverage: ${c}`);

  return { rows, coverage, failures, counts: { entries: registry.length, routes: routes.size, tools: tools.size } };
}

export function renderTable(result) {
  const cols = ["capability_id", "rest", "mcp", "cli", "web", "stripe", "prod", "result"];
  const cell = (v) => (v == null || v === "" ? "-" : String(v));
  const short = (v, n) => (cell(v).length > n ? cell(v).slice(0, n - 1) + "~" : cell(v));
  const lines = result.rows.map((r) => {
    const bad = r.checks.filter((c) => !c.ok);
    const kind = r.e.stripe_product_or_price && r.e.stripe_product_or_price !== "none" ? /metadata\.kind=(\w+)/.exec(r.e.stripe_product_or_price)?.[1] : null;
    return [r.id, short(r.e.rest_endpoint, 26), short(r.e.mcp_tool, 30), short(r.e.cli_command?.replace(/^gridforge /, ""), 20), short(r.e.web_route, 22), short(kind, 24), short(r.e.production_status, 12), bad.length ? `FAIL (${bad.length})` : "ok"];
  });
  const widths = cols.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i].length)));
  const fmt = (l) => l.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(cols), fmt(widths.map((w) => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}

function main() {
  const json = process.argv.includes("--json");
  let result;
  try {
    result = audit();
  } catch (err) {
    console.error(`capability-audit: could not read the sources: ${err.message}`);
    process.exit(2);
  }
  if (json) {
    console.log(JSON.stringify({ ok: result.failures.length === 0, counts: result.counts, failures: result.failures }, null, 2));
  } else {
    console.log(renderTable(result));
    console.log(`\n${result.counts.entries} registry entries, ${result.counts.routes} engine routes, ${result.counts.tools} MCP tools.`);
    if (result.failures.length) {
      console.log(`\n${result.failures.length} mismatch(es):`);
      for (const f of result.failures) console.log(`  - ${f}`);
    } else {
      console.log("Every named layer exists and every engine route and MCP tool is in the registry.");
    }
  }
  process.exit(result.failures.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
