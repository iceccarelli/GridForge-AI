/**
 * The registry's mcp_tool, cli_command, web_route, rest_endpoint and Stripe fields are checked against the code they name.
 *
 * Until now tests/site/capability-registry.test.ts held only the registry's internal consistency (product ids exist, no duplicates), so
 * an entry could name a tool that was renamed, a CLI command that never existed or a page that was deleted, and every test stayed green.
 * scripts/capability-audit.mjs is the cross-checker (a plain node script, no dependencies, no network); these tests run it on the real
 * tree, prove its text parser agrees with the real TypeScript module, and then feed it deliberately wrong sources to prove that each
 * kind of mistake is caught. A check that cannot fail is not a check.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import {
  appRoutes,
  audit,
  parseCli,
  parseEngineRoutes,
  parseProducts,
  parseRegistry,
  parseTools,
  renderTable,
  webRouteResolves,
} from "../../scripts/capability-audit.mjs";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const REGISTRY = read("lib/capability-registry.ts");
const SERVER = read("gridforge/api/server.py");
const TOOLS = read("gridforge/api/tools.py");
const CLI = read("gridforge/cli.py");

/** Replace exactly one occurrence, and fail loudly if the text to break is not there (a mutation that changes nothing proves nothing). */
function mutate(src: string, from: string, to: string): string {
  expect(src.split(from).length - 1, `the text to mutate must occur exactly once: ${from}`).toBe(1);
  return src.replace(from, to);
}

function failuresWith(sources: Record<string, string>): string[] {
  return audit({ sources }).failures;
}

describe("the audit on the real tree", () => {
  const result = audit();

  it("finds nothing wrong", () => {
    expect(result.failures).toEqual([]);
  });

  it("read what it is meant to read (not an empty pass)", () => {
    expect(result.counts.entries).toBe(CAPABILITY_REGISTRY.length);
    expect(result.counts.routes).toBeGreaterThanOrEqual(16);
    expect(result.counts.tools).toBeGreaterThanOrEqual(14);
    expect(result.rows.every((r: { checks: unknown[] }) => r.checks.length >= 3)).toBe(true);
  });

  it("its text parser reads every entry exactly as the TypeScript module has it", () => {
    const parsed = parseRegistry(REGISTRY) as Record<string, string | null>[];
    expect(parsed.map((p) => p.capability_id)).toEqual(CAPABILITY_REGISTRY.map((c) => c.capability_id));
    const fields = ["family", "rest_endpoint", "mcp_tool", "cli_command", "web_route", "workspace_action", "stripe_product_or_price", "status", "production_status", "product_id", "intelligence_plan_id", "engine_capability", "entitlement", "name"] as const;
    for (const c of CAPABILITY_REGISTRY) {
      const p = parsed.find((x) => x.capability_id === c.capability_id)!;
      for (const f of fields) {
        const want = (c as unknown as Record<string, string | undefined>)[f];
        expect(p[f] ?? undefined, `${c.capability_id}.${f}`).toBe(want ?? undefined);
      }
    }
  });

  it("the layers it reads are the real ones", () => {
    const { routes, get } = parseEngineRoutes(SERVER);
    expect([...routes.keys()]).toEqual(expect.arrayContaining(["/v1/bids", "/v1/proposal", "/v1/deck", "/v1/power/assess", "/v1/estimate", "/v1/study"]));
    expect(get).toEqual(expect.arrayContaining(["/v1/calibration/residuals", "/v1/tools"]));
    expect(routes.get("/v1/revoke")).toBe("INTERNAL");
    const tools = parseTools(TOOLS) as Map<string, string | null>;
    expect(tools.size).toBe(14);
    expect(tools.get("gridforge_bids")).toBe("/v1/bids");
    const cli = parseCli(CLI);
    expect([...cli.top]).toEqual(expect.arrayContaining(["screen", "study", "bids", "deck", "proposal", "power-assess", "compare", "calibration"]));
    expect([...cli.nested]).toEqual(expect.arrayContaining(["report", "ingest"]));
    const { products, plans } = parseProducts(read("lib/products.ts"));
    expect(products.get("hall_watch")).toEqual({ kind: "hall_watch", recurring: true });
    expect(products.get("density_screen")).toEqual({ kind: "density_screen", recurring: false });
    expect(plans.get("team")).toEqual({ kind: "intelligence_subscription" });
  });

  it("names every MCP tool the engine's /v1/tools lists: the registry covers 14 of 14, not 10", () => {
    const named = new Set(CAPABILITY_REGISTRY.map((c) => c.mcp_tool));
    const tools = [...(parseTools(TOOLS) as Map<string, unknown>).keys()];
    expect(tools.filter((t) => !named.has(t))).toEqual([]);
  });

  it("the table lists every entry and the command-line script agrees (exit 0)", () => {
    const table = renderTable(result);
    for (const c of CAPABILITY_REGISTRY) expect(table).toContain(c.capability_id);
    const out = execFileSync("node", ["scripts/capability-audit.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(out).toContain("Every named layer exists");
    const json = JSON.parse(execFileSync("node", ["scripts/capability-audit.mjs", "--json"], { cwd: ROOT, encoding: "utf8" }));
    expect(json).toMatchObject({ ok: true, failures: [] });
  });
});

describe("web_route resolution", () => {
  const routes = appRoutes(ROOT) as string[][];
  it.each([
    ["/pricing", true],
    ["/watch/[token]", true],
    ["/watch/abc123", true],
    ["/p/[shareToken]", true],
    ["/power/deploy", true],
    ["/power/deploy/[token]", true],
    ["/pricing/nope", false],
    ["/does-not-exist", false],
    ["/watch", false],
    ["pricing", false],
    ["", false],
  ])("%s -> %s", (route, ok) => {
    expect(webRouteResolves(route, routes)).toBe(ok);
  });
});

describe("each kind of wrong field makes the audit fail (mutation checks)", () => {
  it("M1 an mcp_tool renamed in the registry", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_screeen",') });
    expect(f.join("\n")).toMatch(/density_screen: mcp_tool: gridforge_screeen is not a tool/);
  });

  it("M1b an mcp_tool that names a different route than the entry does", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_study",') });
    expect(f.join("\n")).toMatch(/density_screen: mcp_tool: gridforge_study calls \/v1\/study, not \/v1\/screen/);
  });

  it("M2 a web_route pointed at a page that does not exist", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'web_route: "/qualify",', 'web_route: "/qualify-gone",') });
    expect(f.join("\n")).toMatch(/qualify: web_route: \/qualify-gone resolves to no page/);
  });

  it("M2b a dynamic web_route whose directory is gone", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'web_route: "/watch/[token]",', 'web_route: "/watcher/[token]",') });
    expect(f.join("\n")).toMatch(/hall_watch: web_route/);
  });

  it("M3 a ROUTES entry deleted from the engine", () => {
    const f = failuresWith({ server: mutate(SERVER, '    "/v1/bids": (handle_bids, Tier.CLIENT),\n', "") });
    const text = f.join("\n");
    expect(text).toMatch(/procurement_bids: rest_endpoint: \/v1\/bids is in neither ROUTES nor GET_ROUTES/);
  });

  it("M3b a GET route deleted from the engine", () => {
    const f = failuresWith({ server: mutate(SERVER, '"/v1/calibration", "/v1/calibration/residuals",', '"/v1/calibration",') });
    expect(f.join("\n")).toMatch(/calibration_capture: rest_endpoint: \/v1\/calibration\/residuals/);
  });

  it("M4 a Stripe kind changed", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, "checkout.session, metadata.kind=density_screen\"", "checkout.session, metadata.kind=density_screens\"") });
    expect(f.join("\n")).toMatch(/density_screen: stripe_product_or_price: claims kind density_screens, lib\/products.ts says density_screen/);
  });

  it("M4b a Stripe mode changed (a subscription claimed for a one-time product)", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, "checkout.session, metadata.kind=procurement_spec\",\n    deliverable: \"Technical", "subscription, metadata.kind=procurement_spec\",\n    deliverable: \"Technical") });
    expect(f.join("\n")).toMatch(/procurement_spec: stripe_product_or_price: says subscription, but procurement_spec is one-time/);
  });

  it("M4c an Intelligence plan claimed under the wrong plan", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, "metadata.plan=team\"", "metadata.plan=enterprise\"") });
    expect(f.join("\n")).toMatch(/intelligence_team: stripe_product_or_price: claims plan enterprise, expected team/);
  });

  it("M4d a pay-as-you-go kind nothing handles", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, "metadata.kind=api_payg_enable", "metadata.kind=api_payg_enabled") });
    expect(f.join("\n")).toMatch(/payg_metering: stripe_product_or_price: kind api_payg_enabled is not handled/);
  });

  it("M5 a new entry dropped: the engine capability it described is now reported as missing", () => {
    const start = REGISTRY.indexOf('  {\n    capability_id: "procurement_bids",');
    const end = REGISTRY.indexOf('  {\n    capability_id: "hall_watch",');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const f = failuresWith({ registry: REGISTRY.slice(0, start) + REGISTRY.slice(end) });
    const text = f.join("\n");
    expect(text).toMatch(/coverage: route \/v1\/bids .* has no registry entry/);
    expect(text).toMatch(/coverage: MCP tool gridforge_bids .* has no registry entry/);
  });

  it("M5b an engine route added without an entry", () => {
    const f = failuresWith({ server: mutate(SERVER, '    "/v1/revoke":', '    "/v1/brand-new": (handle_qualify, Tier.CLIENT),\n    "/v1/revoke":') });
    expect(f.join("\n")).toMatch(/coverage: route \/v1\/brand-new/);
  });

  it("M5c an MCP tool added without an entry", () => {
    const f = failuresWith({ tools: mutate(TOOLS, 'TOOLS_BY_NAME = {', '_tool("gridforge_brand_new", "x", "/v1/screen", {}),\n]\n\nTOOLS_BY_NAME = {') });
    expect(f.join("\n")).toMatch(/coverage: MCP tool gridforge_brand_new/);
  });

  it("M6 a CLI subcommand that does not exist", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'cli_command: "gridforge bids",', 'cli_command: "gridforge bidz",') });
    expect(f.join("\n")).toMatch(/procurement_bids: cli_command: "gridforge bidz" is not a subcommand/);
  });

  it("M6b a CLI subcommand removed from the CLI", () => {
    const f = failuresWith({ cli: mutate(CLI, 's = sub.add_parser("deck",', 's = sub.add_parser("deck-renamed",') });
    expect(f.join("\n")).toMatch(/study_deck: cli_command: "gridforge deck" is not a subcommand/);
  });

  it("M6c a nested subcommand that does not exist", () => {
    const f = failuresWith({ registry: mutate(REGISTRY, 'cli_command: "gridforge calibration report",', 'cli_command: "gridforge calibration nonsense",') });
    expect(f.join("\n")).toMatch(/calibration_capture: cli_command/);
  });

  it("M7 production_status contradicting the deployed snapshot, in both directions", () => {
    const live = failuresWith({ registry: mutate(REGISTRY, 'engine_capability: "gridforge/reporting/spec.py",\n    rest_endpoint: "/v1/spec",', 'engine_capability: "gridforge/reporting/spec.py",\n    rest_endpoint: "/v1/spec-gone",') });
    expect(live.join("\n")).toMatch(/procurement_spec: rest_endpoint: \/v1\/spec-gone/);
    const snapshot = JSON.parse(read("lib/engine-deployed.json"));
    snapshot.endpoints = snapshot.endpoints.filter((e: string) => e !== "/v1/bids");
    expect(failuresWith({ deployed: JSON.stringify(snapshot) }).join("\n")).toMatch(/procurement_bids: production_status: marked live but \/v1\/bids is not in lib\/engine-deployed.json/);
    const withResiduals = { ...snapshot, endpoints: [...snapshot.endpoints, "/v1/bids", "/v1/calibration/residuals"] };
    expect(failuresWith({ deployed: JSON.stringify(withResiduals) }).join("\n")).toMatch(/calibration_capture: production_status: marked not_deployed but \/v1\/calibration\/residuals is in/);
  });

  it("M8 a wildcard that matches nothing, and an 'all tools' claim on a concrete route", () => {
    expect(failuresWith({ registry: mutate(REGISTRY, 'rest_endpoint: "/v1/*",\n    mcp_tool: "all gridforge_* tools",\n    cli_command: null,\n    web_route: "/developers",\n    workspace_action: null,\n    database_record: "api_accounts",\n    entitlement: "Stripe subscription -> signed API key (gridforge/api/keys.py)', 'rest_endpoint: "/x/*",\n    mcp_tool: "all gridforge_* tools",\n    cli_command: null,\n    web_route: "/developers",\n    workspace_action: null,\n    database_record: "api_accounts",\n    entitlement: "Stripe subscription -> signed API key (gridforge/api/keys.py)') }).join("\n")).toMatch(/api_triage: rest_endpoint: \/x\/\* matches no route/);
  });

  it("M9 a duplicate id and an unknown status", () => {
    const dup = failuresWith({ registry: mutate(REGISTRY, 'capability_id: "estimate",', 'capability_id: "qualify",') });
    expect(dup.join("\n")).toMatch(/missing or duplicate id "qualify"/);
    const bad = failuresWith({ registry: mutate(REGISTRY, 'status: "metered_only",\n    production_status: "live",\n    notes:\n      "There is deliberately NO MCP tool', 'status: "sellable",\n    production_status: "live",\n    notes:\n      "There is deliberately NO MCP tool') });
    expect(bad.join("\n")).toMatch(/study_deck: status: status "sellable"/);
  });

  it("M10 the command-line script exits non-zero on a wrong registry (a copy of the tree with one mutated field)", () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "capaudit-"));
    try {
      const copy = (rel: string, text?: string) => {
        const to = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, text ?? read(rel));
      };
      copy("scripts/capability-audit.mjs");
      copy("lib/capability-registry.ts", mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_screeen",'));
      for (const rel of ["lib/products.ts", "lib/engine-deployed.json", "gridforge/api/server.py", "gridforge/api/tools.py", "gridforge/cli.py"]) copy(rel);
      // The pages: empty stand-ins at the same paths are enough, the audit only asks whether a page exists.
      for (const segs of appRoutes(ROOT) as string[][]) copy(path.join("app", ...segs, "page.tsx"), "");
      // The Stripe kinds the code handles are read from lib/ and app/api; one file holding the pay-as-you-go kind is enough here.
      copy("lib/payg-billing.ts", '"api_payg_enable" "payg_settlement"');
      const r = spawnSync("node", [path.join(tmp, "scripts/capability-audit.mjs")], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/density_screen: mcp_tool: gridforge_screeen is not a tool/);
      expect(r.stdout).toMatch(/FAIL \(1\)/);
      // And the same copy, unmutated, passes: the failure above is the mutation and nothing else.
      copy("lib/capability-registry.ts");
      const ok = spawnSync("node", [path.join(tmp, "scripts/capability-audit.mjs")], { encoding: "utf8" });
      expect(ok.status, ok.stdout).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
