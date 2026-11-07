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
  databaseRelations,
  migrationRelations,
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
const WEBHOOK = read("app/api/stripe/webhook/route.ts");

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
    expect(routes.size).toBe(16);
    expect(get.length).toBe(8);
    expect(routes.get("/v1/revoke")).toBe("INTERNAL");
    const tools = parseTools(TOOLS) as Map<string, string | null>;
    expect(tools.size).toBe(14);
    expect(tools.get("gridforge_bids")).toBe("/v1/bids");
    const cli = parseCli(CLI);
    expect([...cli.top]).toEqual(expect.arrayContaining(["screen", "study", "bids", "deck", "proposal", "power-assess", "compare", "calibration"]));
    expect([...(cli.nested.get("calibration") as Set<string>)]).toEqual(expect.arrayContaining(["report", "ingest", "review", "pending"]));
    expect(cli.nested.has("compare")).toBe(false);
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
    ["/", true],
    ["/watch/[token]", true],
    ["/p/[shareToken]", true],
    ["/power/deploy", true],
    ["/power/deploy/[token]", true],
    ["/observatory/presenter/[...rest]", true],
    // spelled like the directory or not at all: a literal value that merely matches a [dynamic] segment is not the route
    ["/watch/abc123", false],
    ["/watch/[tok]", false],
    ["/p/[token]", false],
    ["/pricing/", false],
    ["/watch/[token]/", false],
    ["/pricing?x=1", false],
    ["/pricing#a", false],
    ["//pricing", false],
    ["/pricing/nope", false],
    ["/does-not-exist", false],
    ["/watch", false],
    ["pricing", false],
    ["", false],
  ])("%s -> %s", (route, ok) => {
    expect(webRouteResolves(route, routes)).toBe(ok);
  });
});

describe("database_record parsing", () => {
  it("reads the table names out of the registry's prose", () => {
    expect(databaseRelations("engagement_deposits (the payment lands here first, 0019), then deliverables (the engagement opened)")).toEqual(["engagement_deposits", "deliverables"]);
    expect(databaseRelations("projects, project_links, project_events (append-only, trigger-enforced)")).toEqual(["projects", "project_links", "project_events"]);
    expect(databaseRelations("project_observations, project_observation_reviews (0017, 0038), calibration_ledger_rows view")).toEqual(["project_observations", "project_observation_reviews", "calibration_ledger_rows"]);
  });
  it("reads the relations a migration creates", () => {
    expect([...migrationRelations('create table if not exists public.a (x int);\nCREATE OR REPLACE VIEW public.b with (security_invoker = true) as select 1;\ncreate table "c" ();')].sort()).toEqual(["a", "b", "c"]);
  });
  it("finds every named table in the real migrations", () => {
    const sql = fs.readdirSync(path.join(ROOT, "supabase/migrations")).map((f) => read(`supabase/migrations/${f}`)).join("\n");
    const have = migrationRelations(sql);
    for (const c of CAPABILITY_REGISTRY) for (const n of c.database_record ? (databaseRelations(c.database_record) as string[]) : []) expect(have.has(n), `${c.capability_id}: ${n}`).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Mutation checks: each kind of wrong field, wrong engine source or wrong status makes the audit fail.
// ------------------------------------------------------------------------------------------------------------------------------

/** Replace `from` with `to` inside one registry entry only, and require that it occurs there exactly once. */
function inEntry(src: string, id: string, from: string, to: string): string {
  const a = src.indexOf(`    capability_id: "${id}",`);
  expect(a, `entry ${id}`).toBeGreaterThan(0);
  const b = src.indexOf("\n  },\n", a);
  const block = src.slice(a, b);
  expect(block.split(from).length - 1, `"${from}" must occur exactly once in ${id}`).toBe(1);
  return src.slice(0, a) + block.replace(from, to) + src.slice(b);
}

const caught = (sources: Record<string, string>, re: RegExp) => expect(failuresWith(sources).join("\n")).toMatch(re);

describe("each kind of wrong field makes the audit fail (mutation checks)", () => {
  it("M1 an mcp_tool renamed in the registry", () => {
    caught({ registry: mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_screeen",') }, /density_screen: mcp_tool: gridforge_screeen is not a tool/);
  });

  it("M1b an mcp_tool that names a different route than the entry does", () => {
    caught({ registry: mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_study",') }, /density_screen: mcp_tool: gridforge_study calls \/v1\/study, not \/v1\/screen/);
  });

  it("M1c two entries' rest_endpoints swapped", () => {
    let r = inEntry(REGISTRY, "density_screen", 'rest_endpoint: "/v1/screen"', 'rest_endpoint: "/v1/study"');
    r = inEntry(r, "envelope_study", 'rest_endpoint: "/v1/study"', 'rest_endpoint: "/v1/screen"');
    const text = failuresWith({ registry: r }).join("\n");
    expect(text).toMatch(/density_screen: mcp_tool: gridforge_screen calls \/v1\/screen, not \/v1\/study/);
    expect(text).toMatch(/envelope_study: mcp_tool: gridforge_study calls \/v1\/study, not \/v1\/screen/);
  });

  it("M2 a web_route pointed at a page that does not exist", () => {
    caught({ registry: mutate(REGISTRY, 'web_route: "/qualify",', 'web_route: "/qualify-gone",') }, /qualify: web_route: \/qualify-gone is not spelled like any page/);
  });

  it("M2b a dynamic web_route whose directory is gone", () => {
    caught({ registry: mutate(REGISTRY, 'web_route: "/watch/[token]",', 'web_route: "/watcher/[token]",') }, /hall_watch: web_route/);
  });

  it("M2c a literal value that merely matches a [dynamic] segment", () => {
    caught({ registry: mutate(REGISTRY, 'web_route: "/watch/[token]",', 'web_route: "/watch/abc",') }, /hall_watch: web_route: \/watch\/abc is not spelled like/);
  });

  it("M2d a trailing slash, and a dynamic segment with the wrong parameter name", () => {
    caught({ registry: mutate(REGISTRY, 'web_route: "/qualify",', 'web_route: "/qualify/",') }, /qualify: web_route: \/qualify\/ is not spelled like/);
    caught({ registry: mutate(REGISTRY, 'web_route: "/p/[shareToken]",', 'web_route: "/p/[token]",') }, /project_buyer_page: web_route: \/p\/\[token\]/);
  });

  it("M3 a ROUTES entry deleted from the engine", () => {
    caught({ server: mutate(SERVER, '    "/v1/bids": (handle_bids, Tier.CLIENT),\n', "") }, /procurement_bids: rest_endpoint: \/v1\/bids is in neither ROUTES nor GET_ROUTES/);
  });

  it("M3b a GET route deleted from the engine", () => {
    caught({ server: mutate(SERVER, '"/v1/calibration", "/v1/calibration/residuals",', '"/v1/calibration",') }, /calibration_capture: rest_endpoint: \/v1\/calibration\/residuals/);
  });

  it("M4 a Stripe kind changed", () => {
    caught({ registry: mutate(REGISTRY, "checkout.session, metadata.kind=density_screen\"", "checkout.session, metadata.kind=density_screens\"") }, /density_screen: stripe_product_or_price: claims kind density_screens, lib\/products.ts says density_screen/);
  });

  it("M4b a Stripe mode changed (a subscription claimed for a one-time product)", () => {
    caught({ registry: inEntry(REGISTRY, "procurement_spec", '"checkout.session, metadata.kind=procurement_spec"', '"subscription, metadata.kind=procurement_spec"') }, /procurement_spec: stripe_product_or_price: says subscription, but procurement_spec is one-time/);
  });

  it("M4c an Intelligence plan claimed under the wrong plan, and under the wrong mode", () => {
    caught({ registry: mutate(REGISTRY, "metadata.plan=team\"", "metadata.plan=enterprise\"") }, /intelligence_team: stripe_product_or_price: claims plan enterprise, expected team/);
    caught({ registry: inEntry(REGISTRY, "intelligence_team", '"subscription, metadata.kind=intelligence_subscription, metadata.plan=team"', '"checkout.session, metadata.kind=intelligence_subscription, metadata.plan=team"') }, /intelligence_team: stripe_product_or_price: an Intelligence plan is a subscription/);
  });

  it("M4d a kind nothing handles: an invented one, and a word that merely appears in the webhook ('month')", () => {
    caught({ registry: mutate(REGISTRY, "metadata.kind=api_payg_enable", "metadata.kind=api_payg_enabled") }, /payg_metering: stripe_product_or_price: kind api_payg_enabled is neither in lib\/products.ts nor compared/);
    expect(read("lib/products.ts")).toMatch(/"month"/); // the word is quoted in the code, so a plain 'quoted somewhere in lib/' search would have accepted it
    caught({ registry: mutate(REGISTRY, "metadata.kind=api_payg_enable", "metadata.kind=month") }, /payg_metering: stripe_product_or_price: kind month is neither/);
  });

  it("M4e the webhook stops comparing a kind the registry names", () => {
    caught({ webhook: mutate(WEBHOOK, 'kind === "api_payg_enable"', 'kind === "api_payg_enable_removed"') }, /payg_metering: stripe_product_or_price: kind api_payg_enable is neither/);
  });

  it("M5 an entry dropped: the engine capability it described is reported as missing", () => {
    const start = REGISTRY.indexOf('  {\n    capability_id: "procurement_bids",');
    const end = REGISTRY.indexOf('  {\n    capability_id: "hall_watch",');
    expect(end).toBeGreaterThan(start);
    const text = failuresWith({ registry: REGISTRY.slice(0, start) + REGISTRY.slice(end) }).join("\n");
    expect(text).toMatch(/coverage: route \/v1\/bids .* has no registry entry/);
    expect(text).toMatch(/coverage: MCP tool gridforge_bids .* has no registry entry/);
  });

  it("M5b an engine route added without an entry", () => {
    caught({ server: mutate(SERVER, '    "/v1/revoke":', '    "/v1/brand-new": (handle_qualify, Tier.CLIENT),\n    "/v1/revoke":') }, /coverage: route \/v1\/brand-new/);
  });

  it("M5c an MCP tool added without an entry", () => {
    caught({ tools: mutate(TOOLS, "TOOLS_BY_NAME = {", '_tool("gridforge_brand_new", "x", "/v1/screen", {}),\n]\n\nTOOLS_BY_NAME = {') }, /coverage: MCP tool gridforge_brand_new/);
  });

  it("M5d a GET route added without an entry or a listed reason; a listed non-capability that no longer exists", () => {
    caught({ server: mutate(SERVER, '"/v1/tools", "/v1/usage")', '"/v1/tools", "/v1/usage", "/v1/brand-new-get")') }, /coverage: GET route \/v1\/brand-new-get .* has no registry entry and is not a listed non-capability/);
    caught({ server: mutate(SERVER, '"/v1/tools", "/v1/usage")', '"/v1/tools")') }, /coverage: NON_CAPABILITY_GET lists \/v1\/usage, which is not in GET_ROUTES/);
  });

  it("M6 a CLI subcommand that does not exist, was removed, or is nested under the wrong parent", () => {
    caught({ registry: mutate(REGISTRY, 'cli_command: "gridforge bids",', 'cli_command: "gridforge bidz",') }, /procurement_bids: cli_command: "gridforge bidz" is not a subcommand/);
    caught({ cli: mutate(CLI, 's = sub.add_parser("deck",', 's = sub.add_parser("deck-renamed",') }, /study_deck: cli_command: "gridforge deck" is not a subcommand/);
    caught({ registry: mutate(REGISTRY, 'cli_command: "gridforge calibration report",', 'cli_command: "gridforge calibration nonsense",') }, /calibration_capture: cli_command/);
    // `report` exists, but under `calibration`; `compare report` must not pass.
    caught({ registry: mutate(REGISTRY, 'cli_command: "gridforge compare",', 'cli_command: "gridforge compare report",') }, /ttp_compare: cli_command: "gridforge compare report" is not a subcommand/);
    caught({ registry: mutate(REGISTRY, 'cli_command: "gridforge calibration report",', 'cli_command: "gridforge calibration report extra",') }, /calibration_capture: cli_command/);
  });

  it("M7 production_status is machine-proven (live needs a concrete snapshot route; not_deployed needs a concrete absent one)", () => {
    const snapshot = JSON.parse(read("lib/engine-deployed.json"));
    // live, but the snapshot loses the route
    const without = { ...snapshot, endpoints: snapshot.endpoints.filter((e: string) => e !== "/v1/bids") };
    caught({ deployed: JSON.stringify(without) }, /procurement_bids: production_status: marked live but \/v1\/bids is not in lib\/engine-deployed.json/);
    // not_deployed, but the snapshot lists the route (stale)
    caught({ registry: inEntry(REGISTRY, "procurement_bids", 'production_status: "live"', 'production_status: "not_deployed"') }, /procurement_bids: production_status: marked not_deployed but \/v1\/bids is in lib\/engine-deployed.json \(the entry is stale\)/);
    // the reverse direction: a not_deployed entry whose route the snapshot later lists
    const withRoute = { ...snapshot, endpoints: [...snapshot.endpoints, "/v1/calibration/residuals"] };
    caught({ deployed: JSON.stringify(withRoute), registry: inEntry(REGISTRY, "calibration_capture", 'production_status: "unverified"', 'production_status: "not_deployed"') }, /calibration_capture: production_status: marked not_deployed but \/v1\/calibration\/residuals is in/);
    // a missing or unknown production_status
    caught({ registry: inEntry(REGISTRY, "qualify", 'production_status: "live",', 'production_status: "mostly",') }, /qualify: production_status: production_status "mostly" is not one of/);
    caught({ registry: inEntry(REGISTRY, "qualify", '\n    production_status: "live",', "") }, /qualify: production_status: the field production_status is missing/);
  });

  it("M7b live cannot be claimed without a concrete route: wildcard plans, site-only flows, a null route", () => {
    caught({ registry: inEntry(REGISTRY, "payg_metering", 'production_status: "unverified"', 'production_status: "live"') }, /payg_metering: production_status: marked live but its rest_endpoint is a wildcard/);
    caught({ registry: inEntry(REGISTRY, "api_triage", 'production_status: "unverified"', 'production_status: "live"') }, /api_triage: production_status: marked live but its rest_endpoint is a wildcard/);
    caught({ registry: inEntry(REGISTRY, "project_buyer_page", 'production_status: "unverified"', 'production_status: "live"') }, /project_buyer_page: production_status: marked live but its rest_endpoint is null/);
    caught({ registry: inEntry(REGISTRY, "cost_evidence_runs", 'production_status: "unverified"', 'production_status: "live"') }, /cost_evidence_runs: production_status: marked live but its rest_endpoint is null/);
    caught({ registry: inEntry(REGISTRY, "intelligence_team", 'production_status: "unverified"', 'production_status: "live"') }, /intelligence_team: production_status: marked live but its rest_endpoint is null/);
    // a concrete route the snapshot lacks is not live either
    const withoutResiduals = { ...snapshot, endpoints: snapshot.endpoints.filter((e: string) => e !== "/v1/calibration/residuals") };
    caught({ deployed: JSON.stringify(withoutResiduals), registry: inEntry(REGISTRY, "calibration_capture", 'production_status: "unverified"', 'production_status: "live"') }, /calibration_capture: production_status: marked live but \/v1\/calibration\/residuals is not in lib\/engine-deployed.json/);
  });

  it("M7c not_deployed cannot be claimed without a concrete absent route", () => {
    caught({ registry: inEntry(REGISTRY, "api_triage", 'production_status: "unverified"', 'production_status: "not_deployed"') }, /api_triage: production_status: marked not_deployed but its rest_endpoint is a wildcard/);
    caught({ registry: inEntry(REGISTRY, "intelligence_team", 'production_status: "unverified"', 'production_status: "not_deployed"') }, /intelligence_team: production_status: marked not_deployed but its rest_endpoint is null/);
    caught({ registry: inEntry(inEntry(REGISTRY, "calibration_capture", 'rest_endpoint: "/v1/calibration/residuals"', "rest_endpoint: null"), "calibration_capture", 'production_status: "unverified"', 'production_status: "not_deployed"') }, /calibration_capture: production_status: marked not_deployed but its rest_endpoint is null/);
  });

  it("M7d an unverified entry whose notes do not say so", () => {
    caught({ registry: inEntry(REGISTRY, "intelligence_team", "production state is unverified", "production state is fine") }, /intelligence_team: notes: an unverified entry's notes must say plainly/);
  });

  it("M8 a wildcard that matches nothing", () => {
    caught({ registry: inEntry(REGISTRY, "api_triage", 'rest_endpoint: "/v1/*"', 'rest_endpoint: "/x/*"') }, /api_triage: rest_endpoint: \/x\/\* matches no route/);
  });

  it("M9 a duplicate id, an unknown status and a missing required field", () => {
    caught({ registry: mutate(REGISTRY, 'capability_id: "estimate",', 'capability_id: "qualify",') }, /missing or duplicate id "qualify"/);
    caught({ registry: inEntry(REGISTRY, "study_deck", 'status: "metered_only"', 'status: "sellable"') }, /study_deck: status: status "sellable"/);
    caught({ registry: inEntry(REGISTRY, "study_deck", '\n    deliverable: "Walkthrough deck (HTML) for the 90-minute session with the client\'s engineers",', "") }, /study_deck: deliverable: the field deliverable is missing/);
  });

  it("M11 a database_record naming a table no migration creates", () => {
    caught({ registry: inEntry(REGISTRY, "hall_watch", 'database_record: "watches"', 'database_record: "no_such_table"') }, /hall_watch: database_record: no_such_table is not a table or view created in supabase\/migrations/);
    caught({ registry: inEntry(REGISTRY, "project_buyer_page", "project_shares (hash of the link only)", "project_shared_links (hash of the link only)") }, /project_buyer_page: database_record: project_shared_links/);
    caught({ migrations: "create table public.something_else (a int);" }, /hall_watch: database_record: watches is not a table or view/);
  });

  it("M12 an engine_capability citing a file that does not exist, or a function that is not in it", () => {
    caught({ registry: inEntry(REGISTRY, "proposal", "gridforge/reporting/proposal.py", "gridforge/reporting/nonexistent.py") }, /proposal: engine_capability: gridforge\/reporting\/nonexistent.py does not exist/);
    caught({ registry: inEntry(REGISTRY, "qualify", "payloads.py:qualify_payload", "payloads.py:qualify_nothing") }, /qualify: engine_capability: qualify_nothing is not defined in gridforge\/api\/payloads.py/);
    caught({ registry: inEntry(REGISTRY, "qualify", 'engine_capability: "gridforge/api/payloads.py:qualify_payload (via gridforge/api/server.py handle_qualify)"', 'engine_capability: "the qualifier module"') }, /qualify: engine_capability: "the qualifier module" cites no file/);
    // the pre-existing wrong citation this change fixed
    expect(REGISTRY).not.toContain("gridforge/reporting/qualify.py");
    expect(fs.existsSync(path.join(ROOT, "gridforge/reporting/qualify.py"))).toBe(false);
  });

  it("M13 a free entry made commercial with nothing it is sold under; a product_id removed; an unknown included_in", () => {
    caught({ registry: inEntry(REGISTRY, "ttp_compare", 'status: "free"', 'status: "commercial"') }, /ttp_compare: status: commercial but sold under nothing/);
    caught({ registry: inEntry(REGISTRY, "density_screen", '    product_id: "density_screen",\n', "") }, /density_screen: status: commercial but sold under nothing/);
    caught({ registry: inEntry(REGISTRY, "intelligence_team", '    intelligence_plan_id: "team",\n', "") }, /intelligence_team: status: commercial but sold under nothing/);
    caught({ registry: inEntry(REGISTRY, "intelligence_team_seats", 'included_in: ["team", "enterprise"]', 'included_in: ["gold"]') }, /intelligence_team_seats: included_in: gold is in neither PRODUCTS nor INTELLIGENCE_PLANS/);
  });

  it("M14 a fully fake live commercial entry fails on every layer it invents", () => {
    const fake = `  {
    capability_id: "fake_widget",
    family: "engagement",
    name: "Fake",
    description: "d",
    engine_capability: "gridforge/reporting/fake.py:build",
    rest_endpoint: "/v1/fake",
    mcp_tool: "gridforge_fake",
    cli_command: "gridforge fake",
    web_route: "/fake",
    workspace_action: null,
    database_record: "fake_table",
    entitlement: "e",
    stripe_product_or_price: "checkout.session, metadata.kind=fake_kind",
    deliverable: null,
    status: "commercial",
    production_status: "live",
  },
`;
    const text = failuresWith({ registry: mutate(REGISTRY, "];\n\nexport function capabilityById", `${fake}];\n\nexport function capabilityById`) }).join("\n");
    for (const re of [/rest_endpoint: \/v1\/fake is in neither/, /mcp_tool: gridforge_fake is not a tool/, /cli_command: "gridforge fake"/, /web_route: \/fake is not spelled/, /database_record: fake_table/, /engine_capability: gridforge\/reporting\/fake.py does not exist/, /kind fake_kind is neither/, /commercial but sold under nothing/, /production_status: marked live but \/v1\/fake is not in lib\/engine-deployed.json/])
      expect(text).toMatch(re);
  });

  it("M15 the engine route table is never silently half-read: every shape the parser cannot read throws", () => {
    const withEntry = (line: string) => mutate(SERVER, '    "/v1/revoke":', `${line}\n    "/v1/revoke":`);
    const bad: [string, string, RegExp][] = [
      ["a 3-tuple", '    "/v1/x": (handle_qualify, Tier.CLIENT, 3),', /cannot parse the ROUTES entry/],
      ["a lambda handler", '    "/v1/x": (lambda b, t: {}, Tier.CLIENT),', /cannot parse the ROUTES entry/],
      ["a single-quoted path", "    '/v1/x': (handle_qualify, Tier.CLIENT),", /cannot parse the ROUTES entry/],
      ["a variable tier", '    "/v1/x": (handle_qualify, tier_var),', /cannot parse the ROUTES entry/],
      ["a commented-out entry", '    # "/v1/x": (handle_qualify, Tier.CLIENT),', /contains a comment/],
      ["a trailing comment", '    "/v1/x": (handle_qualify, Tier.CLIENT),  # hidden', /contains a comment/],
      ["a duplicate", '    "/v1/qualify": (handle_qualify, Tier.PUBLIC),', /lists \/v1\/qualify twice/],
    ];
    for (const [what, line, re] of bad) expect(() => audit({ sources: { server: withEntry(line) } }), what).toThrow(re);
    const after = (stmt: string) => mutate(SERVER, "#: Routes whose result depends on prices", `${stmt}\n\n#: Routes whose result depends on prices`);
    for (const [what, stmt] of [
      ["an item assigned after the dict", 'ROUTES["/v1/late"] = (handle_qualify, Tier.CLIENT)'],
      ["ROUTES.update", 'ROUTES.update({"/v1/late": (handle_qualify, Tier.CLIENT)})'],
      ["ROUTES |=", 'ROUTES |= {"/v1/late": (handle_qualify, Tier.CLIENT)}'],
      ["GET_ROUTES +=", 'GET_ROUTES += ("/v1/late-get",)'],
      ["ROUTES defined twice", "ROUTES = {}"],
    ] as const) expect(() => audit({ sources: { server: after(stmt) } }), what).toThrow(/ROUTES/);
    // GET_ROUTES entries
    expect(() => audit({ sources: { server: mutate(SERVER, '"/v1/tools", "/v1/usage")', "'/v1/tools', \"/v1/usage\")") } }), "a single-quoted GET path").toThrow(/cannot parse the GET_ROUTES entry/);
    expect(() => audit({ sources: { server: mutate(SERVER, '"/v1/tools", "/v1/usage")', '"/v1/tools", # not this one\n "/v1/usage")') } }), "a GET comment").toThrow(/GET_ROUTES contains a comment/);
    expect(() => audit({ sources: { server: mutate(SERVER, '"/v1/tools", "/v1/usage")', '"/v1/tools", ("/v1/usage", 1))') } }), "a GET tuple").toThrow(/cannot parse the GET_ROUTES entry/);
  });

  it("M16 the command-line script exits non-zero on a wrong registry (a copy of the tree with one mutated field)", () => {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "capaudit-"));
    try {
      // The sources the audit reads, copied as they are; the pages, which it only asks to exist, are empty stand-ins.
      const copyDir = (dir: string, ext: RegExp) => {
        fs.cpSync(path.join(ROOT, dir), path.join(tmp, dir), { recursive: true, filter: (src) => (fs.statSync(src).isDirectory() ? !/node_modules|\.next/.test(src) : ext.test(src)) });
      };
      copyDir("gridforge", /\.py$/);
      copyDir("lib", /\.(ts|tsx|json)$/);
      copyDir("supabase/migrations", /\.sql$/);
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "scripts/capability-audit.mjs"), path.join(tmp, "scripts/capability-audit.mjs"));
      for (const segs of appRoutes(ROOT) as string[][]) {
        const to = path.join(tmp, "app", ...segs, "page.tsx");
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, "");
      }
      fs.mkdirSync(path.join(tmp, "app/api/stripe/webhook"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "app/api/stripe/webhook/route.ts"), WEBHOOK);
      const script = path.join(tmp, "scripts/capability-audit.mjs");
      const regPath = path.join(tmp, "lib/capability-registry.ts");

      const ok = spawnSync("node", [script], { encoding: "utf8" });
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);

      fs.writeFileSync(regPath, mutate(REGISTRY, 'mcp_tool: "gridforge_screen",', 'mcp_tool: "gridforge_screeen",'));
      const bad = spawnSync("node", [script], { encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toMatch(/density_screen: mcp_tool: gridforge_screeen is not a tool/);
      expect(bad.stdout).toMatch(/FAIL \(1\)/);

      // An unreadable engine source is exit 2 (could not read), never a quiet pass.
      fs.writeFileSync(regPath, REGISTRY);
      fs.writeFileSync(path.join(tmp, "gridforge/api/server.py"), mutate(SERVER, '    "/v1/revoke":', '    # "/v1/hidden": (handle_qualify, Tier.CLIENT),\n    "/v1/revoke":'));
      const unreadable = spawnSync("node", [script], { encoding: "utf8" });
      expect(unreadable.status).toBe(2);
      expect(unreadable.stderr).toMatch(/could not read the sources: ROUTES contains a comment/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
