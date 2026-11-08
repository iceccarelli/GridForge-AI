/**
 * The reference hall templates: input values only, validated against the real intake schema and run through the REAL engine
 * (spawned, not stubbed) via the real comparison route and the real /v1/screen route. A template is shown to a visitor only as inputs;
 * this file is where it is proved that each one is solved by the engine, and that the "assumed (E0)" label reaches the engine and comes
 * in the Density Screen's basis text for the same intake document. (The comparison result itself carries no per-input classes, and the marking
 * changes only its request digest; this file does not claim otherwise.) Nothing here asserts a figure the engine should return: the
 * expectations are about what was asked. The real-engine suites use describe.runIf(hasPython); the guard test at the end FAILS when
 * GRIDFORGE_REQUIRE_ENGINE=1 or CI=true and python3 is missing, so CI cannot skip them silently.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { screenIntakeSchema } from "@/lib/engagement-intake";
import { ASSUMABLE_HALL_FIELDS, compareRequestSchema, toEngineBody, type CompareResult } from "@/lib/ttp-compare";
import {
  HALL_PRESETS,
  PRESET_DISCLOSURE,
  PRESET_VALUE_KEYS,
  editedTemplateValues,
  isUntouchedTemplate,
  templateLoadState,
  templateSupplyUnchanged,
  presetById,
  presetFormState,
  stillTemplateValues,
  type HallPreset,
} from "@/lib/hall-presets";
import { TtpCompare, buildCompareBody } from "@/components/TtpCompare";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { ComparisonResults } from "@/components/TtpCompare";
import { engineAvailable } from "./_engine-guard";

const ROOT = path.resolve(__dirname, "../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "hall-presets-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;

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

/**
 * The request a visitor's click-then-compare sends, built by the form's own function from the form state a click loads. `form` replaces
 * the loaded state (an edited form); by default every value is still the template's.
 */
function requestFor(p: HallPreset, form: Record<string, string> = presetFormState(p)) {
  return buildCompareBody(form, p.supply.map((o) => ({ ...o })), p.objective, p) as { hall: Record<string, string>; btm_options: unknown[]; objective: string; assumed_fields?: string[] };
}

const post = async (body: unknown) =>
  (await import("@/app/api/power/compare/route")).POST(
    new Request(siteUrl("/api/power/compare"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const screen = async (intake: unknown) =>
  realFetch(`${ENGINE}/v1/screen`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ intake }) });

beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());
beforeEach(() => {
  resetMemoryLimiter();
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("the templates are intake input values the real schema accepts", () => {
  it("there are three, with distinct ids, and every one validates against compareRequestSchema", () => {
    expect(HALL_PRESETS.map((p) => p.id)).toEqual(["legacy_air_to_dlc", "busway_colocation", "grid_capped_onsite"]);
    expect(new Set(HALL_PRESETS.map((p) => p.name)).size).toBe(3);
    for (const p of HALL_PRESETS) {
      const parsed = compareRequestSchema.safeParse(requestFor(p));
      expect(parsed.success, `${p.id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("every value a template sets is a real field of the intake schema and one the request can declare assumed", () => {
    const shape = (screenIntakeSchema as unknown as { shape: Record<string, unknown> }).shape;
    for (const k of PRESET_VALUE_KEYS) {
      expect(Object.keys(shape), k).toContain(k);
      expect(Object.keys(ASSUMABLE_HALL_FIELDS), k).toContain(k);
    }
    for (const p of HALL_PRESETS) expect(Object.keys(p.values).sort(), p.id).toEqual([...PRESET_VALUE_KEYS].sort());
  });

  it("a template holds input values only: no result, no rack count, no date, no capital figure", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/hall-presets.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*"?racks?"?\s*:|after_ladder|as_found|capex_total|time_to_power/);
    // no template text claims a figure is measured, verified, calibrated or "physics-solved"
    expect(src).not.toMatch(/measured|verified|calibrated|physics-solved/i);
  });

  it("on-site supply is declared only by the template that is about on-site supply, and a battery carries its energy", () => {
    expect(presetById("legacy_air_to_dlc")!.supply).toEqual([]);
    expect(presetById("busway_colocation")!.supply).toEqual([]);
    const campus = presetById("grid_capped_onsite")!;
    expect(campus.supply.length).toBeGreaterThan(0);
    for (const o of campus.supply) if (o.kind === "bess") expect(Number(o.energy_MWh)).toBeGreaterThan(0);
  });
});

describe("the disclosure and the edit tracking", () => {
  it("states what a template is, exactly", () => {
    expect(PRESET_DISCLOSURE).toBe("Reference template — synthetic, replace with your hall's figures");
  });

  it("a value stays the template's until it is changed, and an edited one is no longer declared assumed", () => {
    const p = presetById("busway_colocation")!;
    const form = presetFormState(p);
    expect(stillTemplateValues(p, form)).toEqual([...PRESET_VALUE_KEYS]);
    expect(editedTemplateValues(p, form)).toEqual([]);
    const edited = { ...form, buswayAmpacityA: "800", tapoffMaxA: "" };
    expect(stillTemplateValues(p, edited)).not.toContain("buswayAmpacityA");
    expect(stillTemplateValues(p, edited)).not.toContain("tapoffMaxA");
    expect(editedTemplateValues(p, edited)).toEqual(["buswayAmpacityA", "tapoffMaxA"]);
    // retyping the same figure leaves it the template's figure
    expect(stillTemplateValues(p, { ...form, buswayAmpacityA: " 400 " })).toContain("buswayAmpacityA");
  });

  it("the form renders the three templates as buttons, each named, and no template is loaded before a click", () => {
    const html = renderToStaticMarkup(React.createElement(TtpCompare));
    for (const p of HALL_PRESETS) expect(html).toContain(p.name);
    expect(html).not.toContain(PRESET_DISCLOSURE);
  });
});

describe("an untouched template is a synthetic example, whatever its labels say", () => {
  const p = presetById("grid_capped_onsite")!;
  it("a template click loads a synthetic, unedited state", () => {
    const s = templateLoadState(p);
    expect(s.synthetic).toBe(true);
    expect(s.templateId).toBe(p.id);
    expect(isUntouchedTemplate(p, s.form, s.btm)).toBe(true);
  });
  it("renaming the site, the hall, the platform or adding a metro does not make it a hall", () => {
    const s = templateLoadState(p);
    for (const label of [{ siteName: "My hall" }, { hallId: "H9" }, { platform: "gb200_nvl72" }, { metro: "Dublin" }]) {
      expect(isUntouchedTemplate(p, { ...s.form, ...label }, s.btm), JSON.stringify(label)).toBe(true);
    }
  });
  it("changing any one value, or any supply option, does", () => {
    const s = templateLoadState(p);
    for (const k of PRESET_VALUE_KEYS) expect(isUntouchedTemplate(p, { ...s.form, [k]: s.form[k] + "1" }, s.btm), k).toBe(false);
    expect(isUntouchedTemplate(p, { ...s.form, tapoffMaxA: "" }, s.btm)).toBe(false);
    expect(isUntouchedTemplate(p, s.form, [])).toBe(false);
    expect(isUntouchedTemplate(p, s.form, s.btm.map((o, i) => (i === 0 ? { ...o, capacity_MW: "3" } : o)))).toBe(false);
    expect(isUntouchedTemplate(p, s.form, [...s.btm, { ...s.btm[0], id: "x" }])).toBe(false);
    expect(templateSupplyUnchanged(p, s.btm)).toBe(true);
    expect(templateSupplyUnchanged(presetById("legacy_air_to_dlc")!, [])).toBe(true);
  });
  it("the page renders a loaded template with its disclosure, a tag on every value, and the 'cannot be saved' sentence", () => {
    const html = renderToStaticMarkup(React.createElement(TtpCompare, { initialTemplateId: p.id })).replace(/&#x27;/g, "'");
    expect(html).toContain(PRESET_DISCLOSURE);
    expect((html.match(/Template value · assumed \(E0\)/g) ?? []).length).toBe(PRESET_VALUE_KEYS.length);
    expect(html).toContain("the comparison cannot be saved");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("this site marks");
    expect(html).not.toMatch(/sent\s+to the engine as assumed|engine's own basis text/);
    expect(html).not.toContain("Save to a project");
  });
  it("the result banner is rendered with the disclosure, the counts, and who made the marking; removing it fails here", () => {
    const out = { result: { schema: "x", objective: "max_compute", baseline: "a", scenarios: [], ranking: { objective: "", metric: "", order: [], values: {}, excluded: [], leader: null, tie: false, note: "n" }, grade: "indicative", caveats: [], request_digest: "0".repeat(64), intake_completeness: 1, provenance: { digest: "d", engine_version: "x", code_sha256: "c", report_date: "2026-01-01" } } as unknown as CompareResult, request: {}, synthetic: true, template: { name: p.name, assumed: 13, edited: 1 } };
    const html = renderToStaticMarkup(React.createElement(ComparisonResults, { out, cli: "curl", copied: false, onCopy: () => {} })).replace(/&#x27;/g, "'");
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain(PRESET_DISCLOSURE);
    expect(text).toContain(`started from “${p.name}”`);
    expect(text).toMatch(/13 of 14 template values were still the template's when it was run; 1 had been changed by you/);
    expect(text).toContain("This site marked those 13 assumed (E0) on the request and records the marking in a saved comparison");
    expect(text).toContain("the engine's result carries no per-input classes");
    expect(text).not.toContain("Synthetic example.");
    // without a template the plain banner is still there
    const plain = renderToStaticMarkup(React.createElement(ComparisonResults, { out: { ...out, template: undefined }, cli: "curl", copied: false, onCopy: () => {} }));
    expect(plain).toContain("Synthetic example.");
    expect(plain).not.toContain(PRESET_DISCLOSURE.replace("'", "&#x27;"));
  });
});

describe.runIf(hasPython)("each template, run through the real engine", () => {
  it.each(HALL_PRESETS.map((p) => [p.id, p] as const))("%s is solved by POST /v1/compare, or refused naming a field", async (_id, p) => {
    const res = await post(requestFor(p));
    const body = await res.json();
    if (res.status === 200) {
      const r = body.result as CompareResult;
      expect(r.scenarios.length).toBeGreaterThanOrEqual(2);
      for (const s of r.scenarios) expect(typeof s.as_found.racks).toBe("number");
    } else {
      // a refusal is never silent: it is a 422 that names what to fix
      expect(res.status).toBe(422);
      expect(JSON.stringify(body)).toMatch(/[A-Za-z_.]+/);
      expect(body.error ?? body.detail ?? body.problems).toBeTruthy();
    }
    // As shipped, all three are solved. If the engine ever refuses one, this fails and the template must be fixed or its refusal explained.
    expect(res.status, JSON.stringify(body).slice(0, 400)).toBe(200);
  });

  it.each(HALL_PRESETS.map((p) => [p.id, p] as const))("%s is solved by POST /v1/screen on the same intake document", async (_id, p) => {
    const body = toEngineBody(compareRequestSchema.parse(requestFor(p)));
    const res = await screen(body.intake);
    const out = await res.json();
    expect(res.status, JSON.stringify(out).slice(0, 400)).toBe(200);
    expect(Array.isArray(out.scenarios)).toBe(true);
    expect(out.scenarios.length).toBeGreaterThan(0);
  });

  it("each template's name is not misleading: the engine's own answer to it is consistent with what it is called", async () => {
    const run = async (id: string) => ((await (await post(requestFor(presetById(id)!))).json()).result as CompareResult).scenarios;
    const by = (ss: CompareResult["scenarios"], id: string) => ss.find((s) => s.id === id)!;
    // Expectations live here, not in the template: the template holds inputs, the engine holds the answer, this test compares the two.
    const legacy = await run("legacy_air_to_dlc");
    expect(by(legacy, "full_dlc").as_found.binding).toBe("rack_feed_tapoff");
    const colo = await run("busway_colocation");
    expect(by(colo, "hybrid_dlc").as_found.binding).toBe("busway_ampacity");
    const campus = await run("grid_capped_onsite");
    expect(by(campus, "hybrid_dlc").as_found.binding).toBe("grid_firm_capacity");
    expect(by(campus, "full_dlc_btm").after_ladder.racks).toBeGreaterThan(by(campus, "full_dlc").after_ladder.racks);
  });

  it("the Density Screen's basis text for the same intake shows a marked tap-off as E0, and E5 once the figure is the visitor's; the comparison's rack counts do not move", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const assumed = (await (await post(requestFor(p))).json()).result as CompareResult;
    const yours = (await (await post({ ...requestFor(p), assumed_fields: [] })).json()).result as CompareResult;
    // the basis text lives in the Density Screen's answer to the same intake document
    const basisOf = async (b: unknown) => {
      const doc = toEngineBody(compareRequestSchema.parse(b)).intake;
      const out = await (await screen(doc)).json();
      return JSON.stringify(out).match(/installed tap-offs rated [0-9.]+ A \((E\d)\)/)?.[1];
    };
    expect(await basisOf(requestFor(p))).toBe("E0");
    expect(await basisOf({ ...requestFor(p), assumed_fields: [] })).toBe("E5");
    // declaring a value assumed changes its label, not the arithmetic: the rack counts are identical
    expect(assumed.scenarios.map((s) => [s.id, s.as_found.racks, s.after_ladder.racks])).toEqual(yours.scenarios.map((s) => [s.id, s.as_found.racks, s.after_ladder.racks]));
  });

  it("an edited value is the visitor's: only the fields still equal to the template are sent as assumed", async () => {
    const p = presetById("busway_colocation")!;
    const form = { ...presetFormState(p), tapoffMaxA: "125" };
    const sent = requestFor(p, form);
    expect(sent.assumed_fields).not.toContain("tapoffMaxA");
    expect(sent.assumed_fields).toContain("buswayAmpacityA");
    const body = toEngineBody(compareRequestSchema.parse(sent));
    const lv = (body.intake as { lv: Record<string, unknown> }).lv;
    expect(lv.tapoff_max_A).toBe(125);                                         // the visitor's number, plain
    expect(lv.busway_ampacity_A).toMatchObject({ value: 400, evidence: "E0" });  // the template's, declared
  });

  it("the declaration can only lower a claim: nothing but E0 is ever written, and an unknown field name is refused", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const body = toEngineBody(compareRequestSchema.parse(requestFor(p)));
    const seen: unknown[] = [];
    const walk = (v: unknown) => { if (v && typeof v === "object") { const o = v as Record<string, unknown>; if ("evidence" in o) seen.push(o.evidence); Object.values(o).forEach(walk); } };
    walk(body.intake);
    expect(seen.length).toBe(PRESET_VALUE_KEYS.length);
    expect(new Set(seen)).toEqual(new Set(["E0"]));
    const bad = await post({ ...requestFor(p), assumed_fields: ["buswayAmpacityA", "powerFactor"] });
    expect(bad.status).toBe(422);
  });

  it("a template with a value the engine cannot take is refused with the field named, not answered", async () => {
    const p = presetById("legacy_air_to_dlc")!;
    const body = requestFor(p, { ...presetFormState(p), existingNonItHeatKW: "9000" });   // more than the 3200 kW plant that carries it
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/existingNonItHeatKW/);
  });
});

describe.runIf(hasPython)("the save route refuses an unedited template, and accepts one that has been edited", () => {
  const TABLES = ["projects", "project_links", "project_events", "project_evidence", "project_comparisons", "project_shares", "rate_limit_windows", "leads", "deliverables", "watches", "engagement_deposits", "cost_evidence_state"];
  it("a request that marks every template value assumed is a 422 naming why, before any project is created or the engine is asked", async () => {
    const { PostgrestFake } = await import("./postgrest-fake");
    const { installProjectRpcs } = await import("./project-rpc-fake");
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    const db = new PostgrestFake(TABLES);
    installProjectRpcs(db);
    const restore = db.install();
    const engineCalls: string[] = [];
    const dbFetch = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (ENGINE && url.startsWith(ENGINE)) { engineCalls.push(url); return realFetch(i as RequestInfo, init); }
      return dbFetch(i, init);
    }) as typeof fetch;
    try {
      const save = async (compare: unknown) =>
        (await import("@/app/api/power/compare/save/route")).POST(new Request(siteUrl("/api/power/compare/save"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ compare, project: { project_name: "T" } }) }));
      const p = presetById("legacy_air_to_dlc")!;
      // an untouched template, even with every label renamed
      const untouched = requestFor(p, { ...presetFormState(p), siteName: "My own hall", hallId: "H1", metro: "Dublin" });
      const refused = await save(untouched);
      expect(refused.status).toBe(422);
      expect((await refused.json()).error).toMatch(/unedited reference template/);
      expect(db.rows("projects")).toHaveLength(0);
      expect(engineCalls).toHaveLength(0);
      // the same template with one value replaced is a hall with a template-derived part, and saves
      const edited = await save(requestFor(p, { ...presetFormState(p), tapoffMaxA: "125" }));
      expect(edited.status).toBeLessThan(300);
      expect(db.rows("projects")).toHaveLength(1);
      // the saved request records how many figures are the site's template marking
      const stored = db.rows("project_comparisons")[0] as { request: { site_annotations?: { template_derived_fields: number } } };
      expect(stored.request.site_annotations?.template_derived_fields).toBe(PRESET_VALUE_KEYS.length - 1);
    } finally {
      restore();
      globalThis.fetch = realFetch;
    }
  });
});

describe("the real-engine suites cannot be skipped silently where they are required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
  it("the guard itself fails a missing python3 when required, and allows it when not", () => {
    expect(engineAvailable(false, true).ok).toBe(false);
    expect(engineAvailable(false, false).ok).toBe(true);
  });
});
