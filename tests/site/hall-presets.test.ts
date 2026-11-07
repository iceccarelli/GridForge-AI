/**
 * The reference hall templates: input values only, validated against the real intake schema and run through the REAL engine
 * (spawned, not stubbed) via the real comparison route and the real /v1/screen route. A template is shown to a visitor only as inputs;
 * this file is where it is proved that each one is solved by the engine, and that the "assumed (E0)" label reaches the engine and comes
 * back in the engine's own wording. Nothing here asserts a figure the engine should return: the expectations are about what was asked.
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
  presetById,
  presetFormState,
  stillTemplateValues,
  type HallPreset,
} from "@/lib/hall-presets";
import { TtpCompare, buildCompareBody } from "@/components/TtpCompare";
import { resetMemoryLimiter } from "@/lib/rate-limit";

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

  it("the engine reads the declared class: a template's tap-off is E0 in its own basis text, and E5 once the figure is declared the visitor's", async () => {
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
