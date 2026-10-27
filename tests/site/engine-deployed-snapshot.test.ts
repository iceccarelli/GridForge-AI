/**
 * The site may call, and the capability registry may call "live", only what the DEPLOYED engine serves.
 *
 * lib/engine-deployed.json is a committed snapshot of the deployed engine's GET /v1/version `endpoints` (and the MCP
 * transport it declares). The repository's engine can be ahead of the one on Fly, so "implemented here" is not "deployed".
 * As of the 2026-10-27 redeploy the snapshot lists every route the repository serves (scripts/check-engine-drift.py: no
 * difference), so no concrete registry route is not_deployed; the invariants below are what stays true either way.
 *
 * UPDATING THAT SNAPSHOT IS PART OF AN ENGINE REDEPLOY. After the engine is redeployed:
 *   1. read https://gridforge-engine.fly.dev/v1/version and replace `endpoints` (and `snapshot_date`) in lib/engine-deployed.json;
 *   2. flip the matching lib/capability-registry.ts entries from production_status "not_deployed" to "live";
 *   3. these tests then pass in the other direction (a route now in the snapshot needs no routeMissing handling).
 * Leaving the snapshot stale is safe (the site reads the live engine at render time, see lib/engine-capabilities.ts); the
 * snapshot only stops the repository from CLAIMING a deployment it has not seen.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { routesFromVersion } from "@/lib/engine-capabilities";
import snapshot from "@/lib/engine-deployed.json";
import { STALE_ENGINE } from "./engine-stub";

const ROOT = process.cwd();
const deployed = routesFromVersion(snapshot)!;

describe("the deployed-engine snapshot", () => {
  it("is a well-formed read of /v1/version with a date", () => {
    expect(deployed).not.toBeNull();
    expect(snapshot.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.source).toBe("https://gridforge-engine.fly.dev/v1/version");
    expect(snapshot.endpoints.length).toBeGreaterThan(5);
    expect(new Set(snapshot.endpoints).size).toBe(snapshot.endpoints.length);
    for (const e of snapshot.endpoints) expect(e).toMatch(/^\//);
    // The free qualifier is the one operation every surface depends on.
    expect(deployed.has("/v1/qualify")).toBe(true);
    expect(deployed.has("/mcp")).toBe(true);
  });
});

describe("the capability registry never calls a route live that the deployed engine does not serve", () => {
  const concrete = CAPABILITY_REGISTRY.filter((c) => c.rest_endpoint && !c.rest_endpoint.includes("*"));

  it("has concrete engine routes to check", () => {
    expect(concrete.length).toBeGreaterThan(8);
  });

  it.each(concrete.map((c) => [c.capability_id, c.rest_endpoint!, c.production_status] as const))(
    "%s (%s) is %s",
    (id, endpoint, status) => {
      if (status === "live") {
        expect(
          deployed.has(endpoint),
          `${id} is marked live but ${endpoint} is not in lib/engine-deployed.json (snapshot ${snapshot.snapshot_date}). ` +
            `Either the engine has not been redeployed with it (mark it not_deployed), or it has and the snapshot is stale (update the snapshot).`
        ).toBe(true);
      }
    }
  );

  it("registry not_deployed IFF the route is absent from the snapshot (both directions, for every concrete route)", () => {
    const wrong = concrete
      .filter((c) => (c.production_status === "not_deployed") !== !deployed.has(c.rest_endpoint!))
      .map((c) => `${c.capability_id} ${c.rest_endpoint}: registry ${c.production_status}, snapshot ${deployed.has(c.rest_endpoint!) ? "serves" : "lacks"} it`);
    expect(wrong).toEqual([]);
  });

  it("today the snapshot serves every concrete registry route, so none of them is not_deployed", () => {
    expect(concrete.filter((c) => !deployed.has(c.rest_endpoint!)).map((c) => c.capability_id)).toEqual([]);
    expect(concrete.filter((c) => c.production_status === "not_deployed").map((c) => c.capability_id)).toEqual([]);
  });

  it("the invariant bites: against an injected stale engine exactly the four redeploy-added capabilities would be absent", () => {
    const stale = new Set(STALE_ENGINE);
    const absent = concrete.filter((c) => !stale.has(c.rest_endpoint!)).map((c) => c.capability_id).sort();
    expect(absent).toEqual(["btm_deploy_assess", "btm_deploy_spec", "btm_rfq_loop", "ttp_compare"]);
  });

  it("the tool catalogue (public/reference/tools.json) names only routes the deployed engine serves", () => {
    const tools = JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/tools.json"), "utf8")).tools as { endpoint: string }[];
    expect(tools.length).toBeGreaterThan(8);
    expect(tools.filter((t) => !deployed.has(t.endpoint)).map((t) => t.endpoint)).toEqual([]);
  });

  it("Hall Watch names the route it actually calls (lib/watches.ts re-solves through /v1/diff), not /v1/power/assess", () => {
    const watches = fs.readFileSync(path.join(ROOT, "lib/watches.ts"), "utf8");
    expect(watches).toContain("/v1/diff");
    const cap = CAPABILITY_REGISTRY.find((c) => c.capability_id === "hall_watch")!;
    expect(cap.rest_endpoint).toBe("/v1/diff");
    expect(cap.mcp_tool).toBe("gridforge_diff");
    expect(cap.cli_command).toBe("gridforge diff");
    expect(cap.production_status).toBe("live");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every engine route the site CODE calls.
// ---------------------------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

interface CallSite {
  file: string;
  fn: "callEngine" | "engineFetch";
  /** A literal route, or null when the route is computed (listed in DYNAMIC below). */
  route: string | null;
}

function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of [...walk("lib"), ...walk("app"), ...walk("components")]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const re = /\b(callEngine|engineFetch)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", m.index));
      if (/function\s+callEngine|const\s+(callEngine|engineFetch)\b|import\s|^\s*(\/\/|\*)/.test(line)) continue;
      const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 300);
      // callEngine(input) in lib/qualify.ts is a different, local function that takes a payload; the route call it makes is
      // an engineFetch with a literal in the same file. Only a call whose first argument is a path counts as a path.
      if (m[1] === "callEngine" && !/^\s*["'`]/.test(rest)) continue;
      // The first argument: up to the first ", {" or end of line.
      const end = rest.search(/,\s*\{|,\s*\n/);
      const arg = end === -1 ? rest : rest.slice(0, end);
      // The body of a local callEngine(path, ...) wrapper forwards its `path` parameter; its callers are the sites that count.
      if (m[1] === "engineFetch" && arg.includes("${path}")) continue;
      const literal = /(\/v1\/[A-Za-z0-9_\/-]*[A-Za-z0-9_]|\/mcp\b)/.exec(arg);
      sites.push({ file, fn: m[1] as CallSite["fn"], route: literal ? literal[1] : null });
    }
  }
  return sites;
}

/**
 * Call sites whose route is computed rather than written out. Each is resolved here to the routes it can reach, from the
 * same tables the code reads, so a new computed call site cannot slip past (the test below fails on any not listed).
 */
async function dynamicRoutes(file: string): Promise<string[]> {
  if (file === "lib/deliverables.ts") {
    const { PRODUCTS } = await import("@/lib/products");
    return [...new Set(Object.values(PRODUCTS).map((p) => p.endpoint).filter(Boolean).map((e) => `/v1/${e}`))];
  }
  if (file === "lib/ai/tools.ts") {
    const { TOOLS_BY_NAME } = await import("@/lib/ai/tools");
    return Object.values(TOOLS_BY_NAME).map((t) => t.endpoint);
  }
  throw new Error(`${file} calls the engine on a computed route that this test does not know how to resolve; add it to dynamicRoutes()`);
}

describe("every engine route the site calls is deployed or handled as 'route missing'", () => {
  const sites = callSites();

  it("finds the call sites it is meant to find (the scanner sees what it is meant to)", () => {
    const routes = new Set(sites.map((s) => s.route).filter(Boolean));
    for (const r of ["/v1/qualify", "/v1/diff", "/v1/bids", "/v1/study", "/v1/proposal", "/v1/compare", "/v1/power/deploy/assess", "/v1/power/deploy/spec", "/v1/power/deploy/bids"]) {
      expect(routes, r).toContain(r);
    }
    expect(sites.length).toBeGreaterThan(12);
  });

  const routeAwareCaller = (file: string) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    // callEngine in lib/power-deploy.ts turns the engine's own "not found" for a route into {status: 503, routeMissing: true}.
    return (
      file === "lib/power-deploy.ts" ||
      (/import\s*\{[^}]*\bcallEngine\b[^}]*\}\s*from\s*"@\/lib\/power-deploy"/.test(text) && /routeMissing/.test(text))
    );
  };

  it("every literal route is in the deployed snapshot, or is not_deployed in the registry AND its caller handles routeMissing", () => {
    const literal = sites.filter((s) => s.route !== null);
    const offenders: string[] = [];
    for (const s of literal) {
      if (deployed.has(s.route!)) continue;
      const cap = CAPABILITY_REGISTRY.find((c) => c.rest_endpoint === s.route);
      const routeAware = routeAwareCaller(s.file);
      if (!cap || cap.production_status !== "not_deployed" || !routeAware) {
        offenders.push(`${s.file}: ${s.route} (registry: ${cap?.production_status ?? "no entry"}, routeMissing handled: ${routeAware})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("against an injected stale engine, every route the site calls that it lacks is still handled as 'route missing' by its caller", () => {
    // The engine can fall behind this repository again; the handling must not rot while the real snapshot is complete.
    const stale = new Set(STALE_ENGINE);
    const lacking = sites.filter((s) => s.route !== null && !stale.has(s.route!));
    expect(lacking.map((s) => s.route)).toEqual(
      expect.arrayContaining(["/v1/compare", "/v1/power/deploy/assess", "/v1/power/deploy/spec", "/v1/power/deploy/bids"])
    );
    const offenders = lacking.filter((s) => !routeAwareCaller(s.file)).map((s) => `${s.file}: ${s.route}`);
    expect(offenders).toEqual([]);
  });

  it("every computed route resolves to deployed routes only", async () => {
    const files = [...new Set(sites.filter((s) => s.route === null).map((s) => s.file))];
    expect(files.sort()).toEqual(["lib/ai/tools.ts", "lib/deliverables.ts"]);
    for (const f of files) {
      const routes = await dynamicRoutes(f);
      expect(routes.length, f).toBeGreaterThan(0);
      for (const r of routes) expect(deployed.has(r), `${f} can call ${r}, which the deployed engine does not serve`).toBe(true);
    }
  });

  it("the engine-route-aware callEngine really does map the engine's own 404 to a 503 'route missing'", async () => {
    const { callEngine } = await import("@/lib/power-deploy");
    const real = globalThis.fetch;
    const env = { url: process.env.GRIDFORGE_API_URL, key: process.env.GRIDFORGE_API_KEY };
    process.env.GRIDFORGE_API_URL = "https://engine.test";
    process.env.GRIDFORGE_API_KEY = "k";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not found", endpoints: snapshot.endpoints }), { status: 404 })) as typeof fetch;
    try {
      const out = await callEngine("/v1/power/deploy/assess", {});
      expect(out).toMatchObject({ ok: false, status: 503, routeMissing: true });
      // A 404 that is not the engine's own "not found" is not reported as a missing route.
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: "case not found" }), { status: 404 })) as typeof fetch;
      expect(await callEngine("/v1/power/deploy/assess", {})).toMatchObject({ ok: false, status: 404 });
    } finally {
      globalThis.fetch = real;
      if (env.url === undefined) delete process.env.GRIDFORGE_API_URL;
      else process.env.GRIDFORGE_API_URL = env.url;
      if (env.key === undefined) delete process.env.GRIDFORGE_API_KEY;
      else process.env.GRIDFORGE_API_KEY = env.key;
    }
  });
});
