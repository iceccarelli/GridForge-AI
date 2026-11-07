/**
 * "What evidence could move the binding limit": the deterministic ladder built from a project's saved comparison.
 *
 * Three kinds of check. (1) The engine's own words: every document and every supplied class on the ladder is the engine's
 * (gridforge/intake/schema.py), and every input is one a saved comparison can carry. (2) The logic, over hand-built bases, including the
 * project with nothing assumed and the project whose files are already verified. (3) The whole path through the real routes and the REAL
 * Python engine (spawned, not stubbed): a comparison saved to a project, read back as the project's state, turned into a ladder.
 * The wording is held to the honesty gates: no promised gain, no review step the code does not enforce.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { EvidenceLadderCard } from "@/components/ai/EvidenceLadderCard";
import {
  LADDER_FAMILIES,
  LADDER_LIMITS,
  LADDER_PATHS,
  LADDER_STEPS,
  SPEC_RELIEF_IDS,
  evidenceLadder,
  ladderBasisFromComparison,
  type LadderBasis,
  type LadderFiles,
  type LadderInputState,
} from "@/lib/project-spec-relief";
import { EVIDENCE_MAX_BYTES } from "@/lib/project-evidence-upload";
import { HALL_PRESETS, presetFormState, presetById } from "@/lib/hall-presets";
import { buildCompareBody } from "@/components/TtpCompare";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NO_FILES: LadderFiles = { total: 0, verified: 0, unverified: 0, rejected: 0 };

// ------------------------------------------------------------------------------------------------ the engine's own words
describe("every document and class on the ladder is the engine's own", () => {
  const schema = read("gridforge/intake/schema.py");
  const specOf = (p: string) => {
    const start = schema.indexOf(`FieldSpec("${p}"`);
    expect(start, `FieldSpec for ${p}`).toBeGreaterThanOrEqual(0);
    const next = schema.indexOf("FieldSpec(\"", start + 10);
    return schema.slice(start, next === -1 ? undefined : next);
  };
  const defs = Object.entries(LADDER_FAMILIES).flatMap(([family, ds]) => (ds ?? []).map((d) => [family, d] as const));

  it.each(defs.map((d) => [d[1].path, d] as const))("%s: the document is the engine's how_to_get_it, and the supplied class is the engine's", (_p, [, d]) => {
    const spec = specOf(d.path);
    const how = /how_to_get_it="((?:[^"\\]|\\.)*)"/.exec(spec)?.[1];
    expect(how, `${d.path} how_to_get_it`).toBeDefined();
    expect(d.document).toBe(how);
    const cls = /supplied_evidence=EvidenceClass\.E(\d)/.exec(spec)?.[1] ?? "5";
    expect(d.suppliedClass).toBe(`E${cls}`);
  });

  it("the families are the engine's constraint ids, and none is empty", () => {
    for (const [id, ds] of Object.entries(LADDER_FAMILIES)) {
      expect(SPEC_RELIEF_IDS, id).toContain(id);
      expect(ds!.length, id).toBeGreaterThan(0);
    }
    // the two families with no input a saved comparison carries are the only ones left out, and for a stated reason
    const left = SPEC_RELIEF_IDS.filter((id) => !(id in LADDER_FAMILIES));
    expect([...left].sort()).toEqual(["architecture_capability", "cdu_capacity"]);
  });

  it("every input is one a saved comparison can carry: toIntakeDocument emits it when it is given", () => {
    const all = screenIntakeSchema.parse({
      siteName: "x", hallId: "h", contractedMW: 1, currentPeakMW: 1, currentItLoadMW: 1, buswayAmpacityA: 1, tapoffMaxA: 1,
      positionsAvailable: 1, plantSupplyC: 1, firmCapacityMVA: 1, floorLoadingKPa: 1, plantCapacityKW: 1, pumpFlowLPerMin: 2,
      existingFlowLPerMin: 1, existingNonItHeatKW: 1, designDrybulbC: 1, residualAirKWPerRack: 1,
      transformers: [{ unit_rating_MVA: 1, units: 1 }], ups: [{ unit_rating_kW: 1, units: 1 }],
    });
    const basis = ladderBasisFromComparison({ intake: toIntakeDocument(all) }, { scenarios: [{ id: "a", name: "A", as_found: { binding: null }, after_ladder: { binding: null } }] })!;
    for (const p of LADDER_PATHS) expect(basis.inputs.find((i) => i.path === p)?.supplied, p).toBe(true);
  });

  it("the unevaluated-limit wording quotes the engine's own warnings", () => {
    const loader = read("gridforge/intake/loader.py").replace(/"\s*\n\s*"/g, "");
    expect(loader).toContain("No transformer schedule supplied: transformer capacity is not evaluated and may be the true binding constraint.");
    expect(loader).toContain("No UPS schedule supplied: the load is treated as unprotected.");
  });

  it("the busway runs, LV voltage and power factor are not on the ladder, because the site always sends them", () => {
    for (const p of ["lv.busway_runs", "lv.voltage_V", "grid.power_factor"]) expect(LADDER_PATHS).not.toContain(p);
    const doc = toIntakeDocument(screenIntakeSchema.parse({ siteName: "x", hallId: "h", contractedMW: 1, currentPeakMW: 1, currentItLoadMW: 1, buswayAmpacityA: 1, tapoffMaxA: 1, positionsAvailable: 1, plantSupplyC: 1 })) as any;
    expect(doc.lv.busway_runs).toBe(6);
    expect(doc.lv.voltage_V).toBe(400);
    expect(doc.grid.power_factor).toBe(0.97);
  });
});

// ------------------------------------------------------------------------------------------------ the logic
const plain = (path: string): LadderInputState => ({ path, supplied: true, declared: null });
const missing = (path: string): LadderInputState => ({ path, supplied: false, declared: null });
const declared = (path: string, e: string): LadderInputState => ({ path, supplied: true, declared: e });
function basis(over: Partial<LadderBasis> & { states?: LadderInputState[] } = {}): LadderBasis {
  const states = new Map((over.states ?? []).map((s) => [s.path, s]));
  return {
    scenario: "Full liquid cooling",
    bindsNow: "rack_feed_tapoff",
    bindsNext: "grid_firm_capacity",
    ...over,
    inputs: LADDER_PATHS.map((p) => states.get(p) ?? plain(p)),
  };
}

describe("evidenceLadder", () => {
  it("is deterministic: the same basis and files give the same ladder", () => {
    const b = basis({ states: [missing("lv.tapoff_max_A")] });
    expect(evidenceLadder(b, NO_FILES)).toEqual(evidenceLadder(JSON.parse(JSON.stringify(b)), { ...NO_FILES }));
  });

  it("with no saved comparison there is no ladder, and it says so rather than inventing a limit", () => {
    const l = evidenceLadder(null, NO_FILES);
    expect(l.status).toBe("no_comparison");
    expect(l.rungs).toEqual([]);
    expect(l.scenario).toBeNull();
  });

  it("names the limit that binds now and the one that binds next, each with its own inputs", () => {
    const l = evidenceLadder(basis({ states: [missing("lv.tapoff_max_A")] }), NO_FILES);
    expect(l.status).toBe("has_assumed");
    expect(l.rungs.map((r) => [r.role, r.constraint, r.constraintName])).toEqual([
      ["binds_now", "rack_feed_tapoff", "Rack feed / tap-off rating"],
      ["binds_next", "grid_firm_capacity", "Firm supply (grid import and behind-the-meter)"],
    ]);
    expect(l.rungs[0].rows.map((r) => r.path)).toEqual(["lv.tapoff_max_A"]);
    expect(l.rungs[1].rows.map((r) => r.path).sort()).toEqual(["grid.contracted_MW", "grid.current_site_peak_MW", "grid.firm_capacity_MVA"]);
  });

  it("an input that is not supplied, or declared assumed, is assumed (E0) and says what a figure would be classed", () => {
    const l = evidenceLadder(basis({ states: [missing("lv.tapoff_max_A"), declared("grid.contracted_MW", "E0")] }), NO_FILES);
    const tap = l.rungs[0].rows[0];
    expect(tap).toMatchObject({ classNow: "E0", state: "not_supplied" });
    expect(tap.classIfEntered).toEqual({ code: "E5", verb: "supplied by the client (not measured or surveyed by us)" });
    expect(tap.document).toBe("Tap-off unit nameplate.");
    expect(tap.notProved).toMatch(/platform needs per rack is the engine's library figure/);
    const contracted = l.rungs[1].rows.find((r) => r.path === "grid.contracted_MW")!;
    expect(contracted).toMatchObject({ classNow: "E0", state: "assumed" });
  });

  it("an estimate-class input stays E3 when supplied: the ladder does not pretend a typed figure becomes E5", () => {
    const l = evidenceLadder(basis({ bindsNow: "hydraulic_flow", bindsNext: null, states: [plain("thermal.plant.pump_flow_capacity_l_per_min"), missing("thermal.plant.existing_flow_l_per_min")] }), NO_FILES);
    const pump = l.rungs[0].rows.find((r) => r.path === "thermal.plant.pump_flow_capacity_l_per_min")!;
    expect(pump).toMatchObject({ classNow: "E3", state: "estimated" });
    expect(pump.classIfEntered.code).toBe("E3");
    expect(l.status).toBe("has_assumed");
  });

  it("covers the constraint families the engine exposes: tap-off, busway, transformer, plant and non-IT heat, flow, trim-chiller ambient, residual air", () => {
    for (const id of ["rack_feed_tapoff", "busway_ampacity", "transformer_capacity", "plant_capacity", "hydraulic_flow", "tcs_supply_achievable", "residual_air_removal"]) {
      const l = evidenceLadder(basis({ bindsNow: id, bindsNext: null, states: LADDER_PATHS.map(missing) }), NO_FILES);
      expect(l.rungs[0].constraint).toBe(id);
      expect(l.rungs[0].rows.length).toBeGreaterThan(0);
      for (const r of l.rungs[0].rows) expect(r.state).not.toBe("stated");
    }
    const heat = evidenceLadder(basis({ bindsNow: "plant_capacity", bindsNext: null, states: LADDER_PATHS.map(missing) }), NO_FILES).rungs[0].rows.map((r) => r.path);
    expect(heat).toContain("thermal.plant.existing_non_it_heat_kW");
    const trim = evidenceLadder(basis({ bindsNow: "tcs_supply_achievable", bindsNext: null, states: LADDER_PATHS.map(missing) }), NO_FILES).rungs[0].rows.map((r) => r.path);
    expect(trim).toContain("site.design_drybulb_C");
  });

  it("lists a limit once when it binds both now and after relief", () => {
    const l = evidenceLadder(basis({ bindsNow: "grid_firm_capacity", bindsNext: "grid_firm_capacity" }), NO_FILES);
    expect(l.rungs.map((r) => r.role)).toEqual(["binds_now"]);
    expect(l.named).toHaveLength(1);
  });

  it("inputs that still need a document come before those already stated", () => {
    const l = evidenceLadder(basis({ bindsNow: "grid_firm_capacity", bindsNext: null, states: [missing("grid.current_site_peak_MW")] }), NO_FILES);
    expect(l.rungs[0].rows.map((r) => r.state)).toEqual(["not_supplied", "stated", "stated"]);
  });

  it("with no assumed input behind the limit, says so, and does not ask for a document to reach a class it already has", () => {
    const l = evidenceLadder(basis({ bindsNow: "rack_feed_tapoff", bindsNext: "floor_loading" }), NO_FILES);
    expect(l.status).toBe("all_stated");
    for (const rung of l.rungs) for (const row of rung.rows) expect(row).toMatchObject({ classNow: "E5", state: "stated" });
    const html = renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: l, projectToken: "tok" }));
    expect(html).toMatch(/No input behind the limits? named below is assumed/);
    expect(html).toMatch(/would not change the class/);
    expect(html).not.toMatch(/A figure you enter for it is classed/);
    // the document and what it would not prove are still shown: a stated figure can still have a reviewed file behind it
    expect(html).toContain("Tap-off unit nameplate.");
    expect(html).toContain("It would not prove");
  });

  it("when files are already verified, says how many, and that the record does not link a file to an input", () => {
    const l = evidenceLadder(basis({ states: [missing("lv.tapoff_max_A")] }), { total: 3, verified: 2, unverified: 1, rejected: 0 });
    expect(l.fileLine).toBe("Files on this project: 2 verified, 1 awaiting review. The record does not say which input a file supports, so a verified file changes no class on this page by itself.");
    // verified files do not turn an unsupplied input into a supplied one
    expect(l.rungs[0].rows[0].state).toBe("not_supplied");
    const none = evidenceLadder(basis(), NO_FILES);
    expect(none.fileLine).toBe("No file is attached to this project yet.");
    const waiting = evidenceLadder(basis(), { total: 1, verified: 0, unverified: 1, rejected: 0 });
    expect(waiting.fileLine).toBe("Files on this project: 1 awaiting review.");
    expect(evidenceLadder(basis(), { total: 2, verified: 0, unverified: 0, rejected: 2 }).fileLine).toBe("Files on this project: 2 rejected.");
  });

  it("a limit the engine named but could not evaluate is reported as unevaluated, never as the limit that binds", () => {
    const l = evidenceLadder(basis({ states: [missing("transformers"), missing("ups")] }), NO_FILES);
    expect(l.unevaluated.map((u) => u.path)).toEqual(["transformers", "ups"]);
    expect(l.unevaluated[0].text).toContain("may be the true binding constraint");
    expect(evidenceLadder(basis(), NO_FILES).unevaluated).toEqual([]);
    const html = renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: l, projectToken: "tok" }));
    expect(html).toContain("whether it then binds is the engine&#x27;s call");
  });

  it("a limit with no input a saved comparison carries, or none at all, is said plainly", () => {
    const arch = evidenceLadder(basis({ bindsNow: "architecture_capability", bindsNext: null }), NO_FILES);
    expect(arch.status).toBe("no_inputs");
    expect(arch.rungs).toEqual([]);
    expect(arch.named[0].constraintName).toBe("Cooling architecture per-rack capability");
    const none = evidenceLadder(basis({ bindsNow: null, bindsNext: null }), NO_FILES);
    expect(none.status).toBe("no_limit");
    expect(renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: none, projectToken: "tok" }))).toContain("names no binding limit");
    expect(renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: arch, projectToken: "tok" }))).toContain("Cooling architecture per-rack capability");
  });

  it("the no-comparison card links to the comparison page for this project, with the token escaped", () => {
    const html = renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: evidenceLadder(null, NO_FILES), projectToken: "a b&c" }));
    expect(html).toContain('href="/power/compare?project=a%20b%26c"');
    expect(html).toContain("Not yet created");
  });
});

describe("ladderBasisFromComparison", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    baseline: "retained_air",
    ranking: { leader: "full_dlc" },
    scenarios: [
      { id: "retained_air", name: "Retained air", as_found: { binding: "rack_feed_tapoff" }, after_ladder: { binding: "architecture_capability" } },
      { id: "full_dlc", name: "Full liquid cooling", as_found: { binding: "residual_air_removal" }, after_ladder: { binding: "grid_firm_capacity" } },
    ],
    ...over,
  });

  it("speaks about the scenario ranked first, else the baseline, else the first", () => {
    expect(ladderBasisFromComparison({}, result())).toMatchObject({ scenario: "Full liquid cooling", bindsNow: "residual_air_removal", bindsNext: "grid_firm_capacity" });
    expect(ladderBasisFromComparison({}, result({ ranking: { leader: null } }))).toMatchObject({ scenario: "Retained air", bindsNow: "rack_feed_tapoff" });
    expect(ladderBasisFromComparison({}, result({ ranking: {}, baseline: "gone" }))).toMatchObject({ scenario: "Retained air" });
  });

  it("reads plain numbers as supplied, annotated figures with their declared class, and absence as not supplied", () => {
    const b = ladderBasisFromComparison(
      { intake: { lv: { tapoff_max_A: 63, busway_ampacity_A: { value: 400, evidence: "e0", note: "n" } }, grid: { contracted_MW: { value: 12, evidence: "E0_ASSUMPTION" } }, transformers: [{ unit_rating_MVA: 5 }], ups: [] } },
      result()
    )!;
    const get = (p: string) => b.inputs.find((i) => i.path === p)!;
    expect(get("lv.tapoff_max_A")).toEqual({ path: "lv.tapoff_max_A", supplied: true, declared: null });
    expect(get("lv.busway_ampacity_A")).toEqual({ path: "lv.busway_ampacity_A", supplied: true, declared: "E0" });
    expect(get("grid.contracted_MW").declared).toBe("E0");
    expect(get("grid.firm_capacity_MVA")).toEqual({ path: "grid.firm_capacity_MVA", supplied: false, declared: null });
    expect(get("transformers").supplied).toBe(true);
    expect(get("ups").supplied).toBe(false);
  });

  it("never throws on a malformed row; it returns null or a basis that says nothing was supplied", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { scenarios: "no" }, { scenarios: [] }]) expect(ladderBasisFromComparison({}, bad)).toBeNull();
    const odd = ladderBasisFromComparison("not an object", { scenarios: [{}] })!;
    expect(odd.bindsNow).toBeNull();
    expect(odd.inputs.every((i) => !i.supplied)).toBe(true);
    const hostile = ladderBasisFromComparison({ intake: { lv: { tapoff_max_A: { value: "63", evidence: { e: 1 } } }, grid: [] } }, result())!;
    expect(hostile.inputs.find((i) => i.path === "lv.tapoff_max_A")).toEqual({ path: "lv.tapoff_max_A", supplied: false, declared: null });
  });
});

// ------------------------------------------------------------------------------------------------ the wording
describe("the ladder promises nothing the product does not do", () => {
  const worst = evidenceLadder(basis({ bindsNow: "plant_capacity", bindsNext: "tcs_supply_achievable", states: [...LADDER_PATHS.map(missing)] }), { total: 2, verified: 1, unverified: 1, rejected: 0 });
  const texts = [
    ...worst.steps, ...worst.limits, worst.fileLine,
    ...worst.rungs.flatMap((r) => r.rows.flatMap((x) => [x.stateText, x.document, x.notProved, x.label])),
    ...worst.unevaluated.map((u) => u.text),
    renderToStaticMarkup(React.createElement(EvidenceLadderCard, { ladder: worst, projectToken: "t" })),
    read("components/ai/EvidenceLadderCard.tsx").replace(/\/\*[\s\S]*?\*\//g, ""),
  ].join("\n");

  it("no promised gain, no prevalence claim, no ranking of how much more", () => {
    expect(texts).not.toMatch(/guarantee|\bwill (raise|increase|unlock|add|free|release|improve|relax)|\bunlock|boost|more racks|extra capacity|adds? \d|\bsavings?\b|\bsaves? (you|\d)/i);
    expect(texts).not.toMatch(/most halls|usually|typically|rarely|most operators|most owners|halls (typically|commonly|often)/i);
    expect(texts).not.toMatch(/calibrated accuracy|accurate to|validated by us|certified|(?<!no )approved/i);
  });

  it("says the engine decides, and that a documented figure may relax, hold or tighten the limit", () => {
    expect(LADDER_LIMITS.join(" ")).toMatch(/may relax the limit, leave it as it is, or tighten it\. The engine decides/);
  });

  it("describes only review steps that exist: attach, administrator review with a server-side hash, re-run; no two-person or independent-reviewer rule", () => {
    expect(LADDER_STEPS).toHaveLength(3);
    expect(LADDER_STEPS[0]).toContain(`up to ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB`);
    expect(LADDER_STEPS[1]).toMatch(/SHA-256/);
    expect(LADDER_STEPS[1]).toMatch(/recorded once and cannot be changed/);
    expect(LADDER_STEPS[1]).toMatch(/not an authenticated identity/);
    expect(texts).not.toMatch(/two-person|four-eyes|dual control|second reviewer|independent(ly)? (review|verif)|countersign|auto-?verif/i);
    // each claim in the steps is something the code enforces
    const review = read("lib/project-evidence-review.ts");
    expect(review).toContain('createHash("sha256")');
    expect(review).toContain("ALREADY_REVIEWED_MESSAGE");
    expect(review).toContain("gf_review_evidence");
    const mig = read("supabase/migrations/0048_evidence_verification.sql");
    expect(mig).toMatch(/the reviewer name is self-typed text under one shared admin\s+--\s*password|self-typed text under one shared admin/i);
    expect(mig).toContain("GF007");
    expect(mig).toContain("a decision is recorded once");
    const upload = read("components/ai/EvidenceUpload.tsx");
    expect(upload).toMatch(/Attach file/);
  });
});

// ------------------------------------------------------------------------------------------------ the whole path
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "evidence-ladder-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let db: PostgrestFake;
let restoreDb: () => void;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "procurement_packages", "procurement_responses",
  "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews",
  "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "deliverables", "watches", "watch_notes", "leads",
  "engagement_deposits", "project_comparisons", "project_shares", "rate_limit_windows",
];
const post = (p: string, body: unknown) =>
  new Request(siteUrl(p), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());
beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake(TABLES);
  db.appendOnly.add("project_comparisons");
  installProjectRpcs(db);
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    return ENGINE && url.startsWith(ENGINE) ? realFetch(i as RequestInfo, init) : dbFetch(i, init);
  }) as typeof fetch;
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function saveAndRead(compare: Record<string, unknown>) {
  const saved = await (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare, project: { project_name: "Ladder project" } }));
  expect(saved.status, await saved.clone().text()).toBeLessThan(300);
  const token = (await saved.json()).project_token as string;
  const state = await (await (await import("@/app/api/projects/[token]/route")).GET(new Request(siteUrl("/x")), ctx(token))).json();
  return state;
}

describe.runIf(hasPython)("a comparison saved to a project becomes a ladder, through the real routes and engine", () => {
  it("a reference-template comparison: its values are E0 in the saved request, so the inputs behind the binding limit are assumed", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const state = await saveAndRead(buildCompareBody({ ...presetFormState(p), siteName: "Edited name" }, [], p.objective, p));
    const item = state.comparisons.items[0];
    expect(item.ladder).not.toBeNull();
    const l = evidenceLadder(item.ladder, state.evidence);
    expect(l.status).toBe("has_assumed");
    const now = l.rungs.find((r) => r.role === "binds_now")!;
    const row = now.rows.find((r) => r.path === "lv.tapoff_max_A")!;
    expect(row).toMatchObject({ classNow: "E0", state: "assumed" });
    expect(l.unevaluated.map((u) => u.path)).toEqual(["transformers", "ups"]);
    // the same comparison, with the figures declared the visitor's own, is stated customer data and the ladder says nothing is assumed there
    const own = await saveAndRead({ ...buildCompareBody({ ...presetFormState(p), siteName: "Own hall" }, [], p.objective, p), assumed_fields: [] });
    const lo = evidenceLadder(own.comparisons.items[0].ladder, own.evidence);
    expect(lo.rungs.find((r) => r.role === "binds_now")!.rows.find((r) => r.path === "lv.tapoff_max_A")).toMatchObject({ classNow: "E5", state: "stated" });
  });

  it("the ladder's binding limits are the engine's: they match the saved result", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const state = await saveAndRead(buildCompareBody({ ...presetFormState(p), siteName: "Edited name" }, [], p.objective, p));
    const stored = db.rows("project_comparisons")[0] as any;
    const lead = stored.result.scenarios.find((s: any) => s.id === stored.result.ranking.leader) ?? stored.result.scenarios.find((s: any) => s.id === stored.result.baseline);
    expect(state.comparisons.items[0].ladder).toMatchObject({ scenario: lead.name, bindsNow: lead.as_found.binding, bindsNext: lead.after_ladder.binding });
    // classes only: no figure from the request is in the basis
    expect(JSON.stringify(state.comparisons.items[0].ladder)).not.toMatch(/"value"|3200|4500/);
  });

  it("a project with no saved comparison has no ladder to read", async () => {
    const created = await (await import("@/app/api/projects/route")).POST(post("/api/projects", { project_name: "Empty" }));
    const token = (await created.json()).project_token as string;
    const state = await (await (await import("@/app/api/projects/[token]/route")).GET(new Request(siteUrl("/x")), ctx(token))).json();
    expect(state.comparisons.items).toEqual([]);
    expect(evidenceLadder(state.comparisons.items[0]?.ladder ?? null, state.evidence).status).toBe("no_comparison");
  });
});

describe("the project panel shows the ladder and nothing else about it", () => {
  const panel = read("components/ai/ProjectPanel.tsx");
  it("renders the card from the state it already holds, with no request of its own", () => {
    expect(panel).toContain("WHAT EVIDENCE COULD MOVE THE BINDING LIMIT");
    expect(panel).toContain("evidenceLadder(state.comparisons.items[0]?.ladder ?? null");
    const card = read("components/ai/EvidenceLadderCard.tsx");
    expect(card).not.toMatch(/fetch\(|useEffect|useState|"use client"/);
  });
  it("does not treat an unreadable comparison store as an empty one", () => {
    expect(panel).toMatch(/state\.comparisons\.available \? \(/);
    expect(panel).toContain("so no ladder is shown (not");
  });
  void HALL_PRESETS;
});
