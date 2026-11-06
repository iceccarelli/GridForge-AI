#!/usr/bin/env node
// Read-only cross-check of lib/capability-registry.ts against the code it describes.
//
//   node scripts/capability-audit.mjs [--json]
//
// No dependencies, no network, no writes. For every registry entry it verifies that each layer the entry names exists:
//
//   rest_endpoint            is served: a key of ROUTES or an entry of GET_ROUTES in gridforge/api/server.py ("/v1/*" must match a route)
//   mcp_tool                 is a tool in gridforge/api/tools.py, and that tool's endpoint is the entry's rest_endpoint
//   cli_command              is a subcommand of gridforge/cli.py ("gridforge calibration report" checks the nested one too)
//   web_route                resolves to an app/ page or route handler (dynamic segments: [token] matches a [x] directory)
//   stripe_product_or_price  metadata.kind / metadata.plan agree with lib/products.ts (PRODUCTS / INTELLIGENCE_PLANS); a kind that is
//                            not a catalogue product (pay-as-you-go) must at least be a kind the code handles
//   production_status        "live" needs the route in lib/engine-deployed.json; "not_deployed" needs it absent
//
// and the other direction: every non-internal ROUTES entry and every MCP tool must be named by some entry, so a capability added to the
// engine and forgotten here fails this audit instead of staying invisible.
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

/** { routes: Map<path, tier>, get: string[] } from gridforge/api/server.py. */
export function parseEngineRoutes(server) {
  const body = between(server, /^ROUTES\s*=\s*\{/m, "{", "}");
  const routes = new Map();
  for (const m of body.matchAll(/^\s*"(\/[^"]+)":\s*\(\s*\w+\s*,\s*Tier\.(\w+)\s*\)/gm)) routes.set(m[1], m[2]);
  const getBody = between(server, /^GET_ROUTES\s*=\s*\(/m, "(", ")");
  const get = [...getBody.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
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

/** { top: Set, nested: Set } of argparse subcommand names in gridforge/cli.py. */
export function parseCli(cli) {
  const groups = [...cli.matchAll(/(\w+)\s*=\s*\w+\.add_subparsers\(/g)].map((m) => m[1]);
  if (groups.length === 0) throw new Error("no add_subparsers() found in gridforge/cli.py");
  const topVar = groups[0];
  const top = new Set();
  const nested = new Set();
  for (const m of cli.matchAll(/(\w+)\.add_parser\(\s*"([\w-]+)"/g)) (m[1] === topVar ? top : nested).add(m[2]);
  // `for name, fn, helptext in (("screen", cmd_screen, "..."), ("study", cmd_study, "..."))` registers several through one add_parser(name, ...).
  for (const m of cli.matchAll(/\(\s*"([\w-]+)"\s*,\s*cmd_\w+/g)) top.add(m[1]);
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

export function webRouteResolves(route, routes) {
  if (typeof route !== "string" || !route.startsWith("/")) return false;
  const want = route.split("/").filter(Boolean);
  return routes.some((segs) => {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (/^\[\[?\.\.\./.test(s)) return want.length > i || /^\[\[/.test(s); // catch-all
      if (i >= want.length) return false;
      if (!(s === want[i] || /^\[[^.\]]+\]$/.test(s))) return false;
    }
    return segs.length === want.length;
  });
}

function codeFiles(root, dirs) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(rel); } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The audit.
// ---------------------------------------------------------------------------------------------------------------------------------

const MCP_ALL = "all gridforge_* tools";
const STATUSES = new Set(["commercial", "metered_only", "free", "internal_only"]);
const PRODUCTION = new Set(["live", "not_deployed", "unverified"]);

/**
 * Run every check. `sources` replaces the text of a file (registry, server, tools, cli, products, deployed) so a test can break exactly one
 * thing and prove the audit notices; anything not replaced is read from `root`.
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
  const pages = appRoutes(root);
  const served = new Set([...routes.keys(), ...get]);

  // The kinds the code handles, for a Stripe kind that is not a catalogue product (pay-as-you-go).
  let handled = null;
  const kindHandled = (kind) => {
    if (handled === null) {
      handled = codeFiles(root, ["lib", "app/api"])
        .filter((f) => f !== path.join("lib", "capability-registry.ts"))
        .map((f) => fs.readFileSync(path.join(root, f), "utf8"));
    }
    return handled.some((t) => t.includes(`"${kind}"`));
  };

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
    check("status", STATUSES.has(e.status), `status "${e.status}" is not one of ${[...STATUSES].join(", ")}`);
    check("production_status", PRODUCTION.has(e.production_status), `production_status "${e.production_status}" is not one of ${[...PRODUCTION].join(", ")}`);

    // rest_endpoint
    const rest = e.rest_endpoint;
    if (rest) {
      if (rest.includes("*")) {
        const prefix = rest.slice(0, rest.indexOf("*"));
        check("rest_endpoint", [...routes.keys()].some((r) => r.startsWith(prefix)), `${rest} matches no route in ROUTES`);
      } else {
        check("rest_endpoint", served.has(rest), `${rest} is in neither ROUTES nor GET_ROUTES of gridforge/api/server.py`);
        const inSnapshot = deployed.has(rest);
        if (e.production_status === "live") check("production_status", inSnapshot, `marked live but ${rest} is not in lib/engine-deployed.json`);
        if (e.production_status === "not_deployed") check("production_status", !inSnapshot, `marked not_deployed but ${rest} is in lib/engine-deployed.json`);
      }
    }

    // mcp_tool
    const mcp = e.mcp_tool;
    if (mcp && mcp !== MCP_ALL) {
      check("mcp_tool", tools.has(mcp), `${mcp} is not a tool in gridforge/api/tools.py`);
      if (tools.has(mcp) && rest && !rest.includes("*")) {
        check("mcp_tool", tools.get(mcp) === rest, `${mcp} calls ${tools.get(mcp)}, not ${rest}`);
      }
    } else if (mcp === MCP_ALL) {
      check("mcp_tool", rest != null && rest.includes("*"), `"${MCP_ALL}" only fits an entry whose rest_endpoint is a /v1/* wildcard`);
    }

    // cli_command
    if (e.cli_command) {
      const words = String(e.cli_command).split(/\s+/);
      const ok = words[0] === "gridforge" && cli.top.has(words[1]) && (words.length < 3 || cli.nested.has(words[2])) && words.length <= 3;
      check("cli_command", ok, `"${e.cli_command}" is not a subcommand of gridforge/cli.py`);
    }

    // web_route
    if (e.web_route) check("web_route", webRouteResolves(e.web_route, pages), `${e.web_route} resolves to no page or route under app/`);

    // stripe_product_or_price
    const stripe = e.stripe_product_or_price;
    if (e.product_id || e.intelligence_plan_id) {
      const kindM = typeof stripe === "string" ? /metadata\.kind=(\w+)/.exec(stripe) : null;
      if (e.product_id) {
        const p = products.get(e.product_id);
        check("product_id", Boolean(p), `${e.product_id} is not in PRODUCTS (lib/products.ts)`);
        if (p) {
          check("stripe_product_or_price", Boolean(kindM) && kindM[1] === p.kind, `claims kind ${kindM ? kindM[1] : "none"}, lib/products.ts says ${p.kind}`);
          const mode = typeof stripe === "string" && stripe.startsWith("subscription") ? "subscription" : "checkout.session";
          check("stripe_product_or_price", mode === (p.recurring ? "subscription" : "checkout.session"), `says ${mode}, but ${e.product_id} is ${p.recurring ? "recurring" : "one-time"} in lib/products.ts`);
        }
      }
      if (e.intelligence_plan_id) {
        const p = plans.get(e.intelligence_plan_id);
        const planM = typeof stripe === "string" ? /metadata\.plan=(\w+)/.exec(stripe) : null;
        check("intelligence_plan_id", Boolean(p), `${e.intelligence_plan_id} is not in INTELLIGENCE_PLANS (lib/products.ts)`);
        if (p) {
          check("stripe_product_or_price", Boolean(kindM) && kindM[1] === p.kind, `claims kind ${kindM ? kindM[1] : "none"}, lib/products.ts says ${p.kind}`);
          check("stripe_product_or_price", Boolean(planM) && planM[1] === e.intelligence_plan_id, `claims plan ${planM ? planM[1] : "none"}, expected ${e.intelligence_plan_id}`);
        }
      }
    } else if (stripe && stripe !== "none") {
      const kinds = [...String(stripe).matchAll(/metadata\.kind=(\w+)/g)].map((m) => m[1]);
      check("stripe_product_or_price", kinds.length > 0, `"${stripe}" names no metadata.kind`);
      for (const k of kinds) check("stripe_product_or_price", kindHandled(k), `kind ${k} is not handled anywhere in lib/ or app/api/`);
    } else {
      check("stripe_product_or_price", stripe === "none" || stripe === null, `expected "none" or null, found "${stripe}"`);
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
