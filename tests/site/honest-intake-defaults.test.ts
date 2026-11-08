/**
 * Honest intake defaults: busway runs, LV voltage and site power factor reach the engine only when the visitor gave them.
 *
 * The forms used to pre-fill 6 runs, 400 V and a power factor of 0.97 and send them as if supplied. The engine then classed them as supplied
 * customer data (E5, or E3 for the power factor), counted them in intake_completeness, dropped them from the named assumptions, and built a busway
 * basis on a precision nobody gave it. These tests pin the repaired behaviour at every layer: the schema, the form's own payload, the request
 * /power/compare sends, the engine's reading of the omitted figures, and the evidence ladder's list of what each limit rests on.
 *
 * The real-engine part spawns python3 and the engine's own loader; it FAILS (not skips) where GRIDFORGE_REQUIRE_ENGINE=1 or CI=true and python3 is
 * missing (tests/site/_engine-guard.ts).
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ENGINE_LIBRARY_DEFAULTS,
  LIBRARY_DEFAULT_HINT,
  engagementIntakeSchema,
  screenIntakeSchema,
  toIntakeDocument,
} from "@/lib/engagement-intake";
import { EMPTY_FORM, intakePayload } from "@/components/EngagementIntake";
import { TtpCompare, buildCompareBody } from "@/components/TtpCompare";
import { compareRequestSchema, toEngineBody } from "@/lib/ttp-compare";
import { HALL_PRESETS, presetFormState } from "@/lib/hall-presets";
import { LADDER_FAMILIES } from "@/lib/project-spec-relief";
import { engineAvailable } from "./_engine-guard";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const THREE = ["buswayRuns", "voltageV", "powerFactor"] as const;
/** The three above plus the annual utilisation: the four figures the old forms always sent, pre-filled, as if the visitor had supplied them. */
const FOUR = [...THREE, "utilisation"] as const;

const HALL = {
  siteName: "Honest Hall", hallId: "H1", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63,
  positionsAvailable: 180, plantSupplyC: 6,
};

// ------------------------------------------------------------------------------------------------ the schema and the document
describe("the schema: the three are optional, with no default", () => {
  it("a hall that does not give them parses without them, and the intake document carries no key for them", () => {
    for (const schema of [screenIntakeSchema, engagementIntakeSchema]) {
      const r = schema.safeParse({ ...HALL, firmCapacityMVA: 15, floorLoadingKPa: 12, plantCapacityKW: 6000 });
      expect(r.success, JSON.stringify(r)).toBe(true);
      if (!r.success) continue;
      for (const k of FOUR) expect(r.data[k], k).toBeUndefined();
      expect(r.data.floorType).toBeUndefined();
      const doc = toIntakeDocument(r.data as never) as { lv: Record<string, unknown>; grid: Record<string, unknown> };
      expect(Object.keys(doc.lv).sort()).toEqual(["busway_ampacity_A", "tapoff_max_A"]);
      expect("power_factor" in doc.grid).toBe(false);
    }
  });

  it("a value the visitor typed is carried exactly (including one equal to the engine's default)", () => {
    const r = screenIntakeSchema.parse({ ...HALL, buswayRuns: "6", voltageV: "400", powerFactor: "0.97" });
    const doc = toIntakeDocument(r) as { lv: Record<string, unknown>; grid: Record<string, unknown> };
    expect([doc.lv.busway_runs, doc.lv.voltage_V, doc.grid.power_factor]).toEqual([6, 400, 0.97]);
    const other = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, buswayRuns: 2, voltageV: 230, powerFactor: 0.8 })) as { lv: Record<string, unknown>; grid: Record<string, unknown> };
    expect([other.lv.busway_runs, other.lv.voltage_V, other.grid.power_factor]).toEqual([2, 230, 0.8]);
  });

  it("the bounds are unchanged: a wrong value is refused, not defaulted", () => {
    for (const bad of [{ buswayRuns: 0 }, { buswayRuns: 65 }, { buswayRuns: 1.5 }, { voltageV: -1 }, { voltageV: 1001 }, { powerFactor: 0.5 }, { powerFactor: 1.1 }, { powerFactor: "abc" }]) {
      expect(screenIntakeSchema.safeParse({ ...HALL, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the schemas keep their .shape (other code reads it) and it lists the three, optional", () => {
    for (const schema of [screenIntakeSchema, engagementIntakeSchema]) {
      for (const k of [...FOUR, "floorType"] as const) {
        expect(k in schema.shape, k).toBe(true);
        expect(schema.shape[k].safeParse(undefined).success, k).toBe(true);
      }
      expect("firmCapacityMVA" in schema.shape).toBe(true);
    }
    // the Density Screen leaves the three assumable figures optional; the Procurement Specification still requires them
    expect(screenIntakeSchema.shape.firmCapacityMVA.safeParse(undefined).success).toBe(true);
    expect(engagementIntakeSchema.shape.firmCapacityMVA.safeParse(undefined).success).toBe(false);
  });
});

describe("the engine's library defaults are shown, never submitted", () => {
  it("are the engine's own numbers (read from gridforge/intake/loader.py, not retyped)", () => {
    const loader = read("gridforge/intake/loader.py");
    expect(loader).toContain(`r.raw("lv.busway_runs", ${ENGINE_LIBRARY_DEFAULTS.buswayRuns})`);
    expect(loader).toMatch(new RegExp(`V\\(${ENGINE_LIBRARY_DEFAULTS.voltageV}, "V", "assumed LV distribution voltage", ASSUMED`));
    expect(loader).toMatch(new RegExp(`V\\(${ENGINE_LIBRARY_DEFAULTS.powerFactor}, "1", "assumed site power factor", ASSUMED`));
    expect(loader).toMatch(new RegExp(`V\\(${ENGINE_LIBRARY_DEFAULTS.utilisation}, "1", "assumed annual average utilisation", ASSUMED`));
    expect(loader).toContain(`r.raw("hall.floor_type", "${ENGINE_LIBRARY_DEFAULTS.floorType}")`);
    expect(loader).toContain(`t.get("redundancy", "${ENGINE_LIBRARY_DEFAULTS.redundancy}"), "transformer"`);
    expect(loader).toContain(`u.get("redundancy", "${ENGINE_LIBRARY_DEFAULTS.redundancy}"), "UPS"`);
    expect(LIBRARY_DEFAULT_HINT).toBe("the engine assumes 6 runs / 400 V / 0.97 until you give yours");
  });

  it("the engagement form starts with the three EMPTY and its payload omits them until typed", () => {
    for (const k of [...FOUR, "floorType"] as const) expect(EMPTY_FORM[k], k).toBe("");
    const rows = [{ id: "TX-1", rating: "" as const, units: "" as const, redundancy: "N+1" }];
    const untouched = intakePayload({ ...EMPTY_FORM, siteName: "S", hallId: "H" }, [], rows, rows);
    for (const k of [...FOUR, "floorType"] as const) expect(untouched[k as keyof typeof untouched], k).toBeUndefined();
    const typed = intakePayload({ ...EMPTY_FORM, siteName: "S", hallId: "H", buswayRuns: "3", voltageV: "415", powerFactor: "0.92" }, [], rows, rows);
    expect([typed.buswayRuns, typed.voltageV, typed.powerFactor]).toEqual(["3", "415", "0.92"]);
    // a blank, or whitespace, is not a value
    const blank = intakePayload({ ...EMPTY_FORM, buswayRuns: "  ", voltageV: "", powerFactor: " ", utilisation: " " }, [], rows, rows);
    for (const k of FOUR) expect(blank[k as keyof typeof blank], k).toBeUndefined();
  });

  it("the form shows the defaults as placeholder text and says what is assumed, in the field's own hint", () => {
    const src = read("components/EngagementIntake.tsx");
    expect(src).toContain("placeholder={`engine assumes ${ENGINE_LIBRARY_DEFAULTS.powerFactor}`}");
    expect(src).toContain("placeholder={`engine assumes ${ENGINE_LIBRARY_DEFAULTS.buswayRuns}`}");
    expect(src).toContain("placeholder={`engine assumes ${ENGINE_LIBRARY_DEFAULTS.voltageV}`}");
    expect(src).not.toMatch(/buswayRuns: "6"|voltageV: "400"|powerFactor: "0\.97"/);
  });
});

// ------------------------------------------------------------------------------------------------ /power/compare
describe("/power/compare sends them only when typed", () => {
  const body = (over: Record<string, string> = {}) => {
    const p = HALL_PRESETS[0];
    const hall = buildCompareBody({ ...presetFormState(p), ...over }, [], p.objective, p);
    return toEngineBody(compareRequestSchema.parse(hall)) as { intake: { lv: Record<string, unknown>; grid: Record<string, unknown> } };
  };

  it("a template run carries none of the three: the templates do not define them", () => {
    for (const p of HALL_PRESETS) {
      const b = toEngineBody(compareRequestSchema.parse(buildCompareBody(presetFormState(p), [], p.objective, p))) as { intake: { lv: Record<string, unknown>; grid: Record<string, unknown> } };
      expect(Object.keys(b.intake.lv).sort(), p.id).toEqual(["busway_ampacity_A", "tapoff_max_A"]);
      expect("busway_runs" in b.intake.lv || "voltage_V" in b.intake.lv || "power_factor" in b.intake.grid, p.id).toBe(false);
    }
  });

  it("typed values reach the request as the visitor's own plain figures (not marked as the template's)", () => {
    const b = body({ buswayRuns: "4", voltageV: "415", powerFactor: "0.9" });
    expect([b.intake.lv.busway_runs, b.intake.lv.voltage_V, b.intake.grid.power_factor]).toEqual([4, 415, 0.9]);
  });

  it("the form offers the three as optional fields with the engine's defaults as placeholders", () => {
    const html = renderToStaticMarkup(React.createElement(TtpCompare));
    for (const [label, ph] of [["Busway runs (count)", "engine assumes 6"], ["LV voltage (V)", "engine assumes 400"], ["Site power factor", "engine assumes 0.97"]]) {
      expect(html).toContain(label);
      expect(html).toContain(`placeholder="${ph}"`);
    }
    // placeholders only: no input holds the default as its value
    expect(html).not.toMatch(/value="(6|400|0\.97)"/);
  });
});

// ------------------------------------------------------------------------------------------------ the real engine
const run = (docs: Record<string, unknown>) => {
  const code = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(ROOT)})`,
    "from gridforge.intake.loader import load_document",
    "from gridforge.intake.schema import INTAKE_FIELDS",
    "from gridforge.scenario import run_all",
    "docs = json.load(sys.stdin)",
    "out = {}",
    "for name, doc in docs.items():",
    "    i = load_document(doc)",
    "    res = run_all(i.context, i.scenarios)",
    "    inf = float('inf')",
    "    out[name] = {",
    "        'completeness': round(i.report.completeness, 3),",
    "        'counted': len({f.path for f in INTAKE_FIELDS if f.counts_toward_completeness}),",
    "        'supplied': sorted(i.report.supplied),",
    "        'gaps': sorted(g.path for g in i.report.gaps),",
    "        'racks': {r.spec.id: r.envelope.max_racks for r in res},",
    "        'binding': {r.spec.id: r.envelope.binding.name for r in res},",
    "        'constraints': {r.spec.id: {c.id: (None if c.racks == inf else c.racks) for c in r.envelope.constraints} for r in res},",
    "    }",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", code], { input: JSON.stringify(docs), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, {
    completeness: number; counted: number; supplied: string[]; gaps: string[]; racks: Record<string, number>; binding: Record<string, string>;
    constraints: Record<string, Record<string, number | null>>;
  }>;
};

const PATHS = { runs: "lv.busway_runs", volts: "lv.voltage_V", pf: "grid.power_factor", util: "compute.utilisation" } as const;

describe.runIf(hasPython)("the engine, given the three or not (real loader, real solver)", () => {
  const templateDocs = () =>
    Object.fromEntries(
      HALL_PRESETS.flatMap((p) => {
        const hall = compareRequestSchema.parse(buildCompareBody(presetFormState(p), [], p.objective, p));
        const omitted = (toEngineBody(hall) as { intake: Record<string, unknown> }).intake;
        const withDefaults = JSON.parse(JSON.stringify(omitted));
        withDefaults.lv = { ...withDefaults.lv, busway_runs: 6, voltage_V: 400 };
        withDefaults.grid = { ...withDefaults.grid, power_factor: 0.97 };
        withDefaults.compute = { ...withDefaults.compute, utilisation: 0.75 };
        return [[`${p.id}:omitted`, omitted], [`${p.id}:as-before`, withDefaults]];
      })
    );

  it("omitted, the four are named gaps and are not counted as supplied; given at the same values they were silently counted", () => {
    const out = run(templateDocs());
    for (const p of HALL_PRESETS) {
      const omitted = out[`${p.id}:omitted`];
      const before = out[`${p.id}:as-before`];
      for (const path of Object.values(PATHS)) {
        expect(omitted.gaps, `${p.id} ${path}`).toContain(path);
        expect(omitted.supplied, `${p.id} ${path}`).not.toContain(path);
        expect(before.gaps, `${p.id} ${path}`).not.toContain(path);
        expect(before.supplied, `${p.id} ${path}`).toContain(path);
      }
      // the completeness the old forms reported was higher than the facts supported
      expect(omitted.completeness, p.id).toBeLessThan(before.completeness);
      // the arithmetic is unchanged: the engine's defaults ARE 6 / 400 / 0.97, so the rack counts and what binds are identical
      expect(omitted.racks, p.id).toEqual(before.racks);
      expect(omitted.binding, p.id).toEqual(before.binding);
      expect(omitted.constraints, p.id).toEqual(before.constraints);
    }
  });

  it("the completeness moves by exactly the four fields: each is one of the intake's counted fields", () => {
    const out = run(templateDocs());
    for (const p of HALL_PRESETS) {
      const o = out[`${p.id}:omitted`];
      const diff = out[`${p.id}:as-before`].completeness - o.completeness;
      expect(diff, p.id).toBeCloseTo(4 / o.counted, 2);
    }
  });

  it("the honest completeness of the three reference templates: 0.452 (14 of 31 counted fields), not the 0.581 the pre-filled form reported", () => {
    // Pinned on purpose. It moves only when the engine's counted intake fields change (gridforge/intake/schema.py); then update this deliberately.
    const out = run(templateDocs());
    for (const p of HALL_PRESETS) {
      expect(out[`${p.id}:omitted`].counted, p.id).toBe(31);
      expect(out[`${p.id}:omitted`].completeness, p.id).toBe(0.452);
      expect(out[`${p.id}:as-before`].completeness, p.id).toBe(0.581);
    }
  });

  // The ladder lists each input under the families whose limit the engine computes from it. Proved by perturbing the real engine, in both
  // directions: a listed family must move, and an unlisted electrical family must not (so the list cannot be incomplete either).
  const ELECTRICAL = ["rack_feed_tapoff", "busway_ampacity", "grid_firm_capacity", "transformer_capacity"] as const;
  const base = {
    project: { client: "x", reference: "r" }, site: { name: "s", design_drybulb_C: 30 },
    hall: { id: "H", positions_available: 200, floor_loading_kPa: 15 },
    grid: { firm_capacity_MVA: 8, contracted_MW: 20, current_site_peak_MW: 7.4, current_it_load_MW: 4.9 },
    lv: { busway_ampacity_A: 1000, tapoff_max_A: 250 },
    thermal: { plant: { chilled_water_capacity_kW: 12000, design_supply_C: 10 } },
    transformers: [{ unit_rating_MVA: 20, units: 2, redundancy: "N+1" }],
    ups: [{ unit_rating_kW: 5000, units: 6, redundancy: "N+1" }],
    compute: { platform: "gb300_nvl72" },
    scenarios: ["hybrid_dlc"],
  };
  const with_ = (lv: Record<string, unknown>, grid: Record<string, unknown> = {}) => ({ ...base, lv: { ...base.lv, ...lv }, grid: { ...base.grid, ...grid } });

  it.each([
    ["lv.busway_runs", { a: with_({ busway_runs: 2 }), b: with_({ busway_runs: 12 }) }],
    ["lv.voltage_V", { a: with_({ voltage_V: 230 }), b: with_({ voltage_V: 690 }) }],
    ["grid.power_factor", { a: with_({}, { power_factor: 0.8 }), b: with_({}, { power_factor: 1.0 }) }],
  ])("%s moves exactly the electrical limits the ladder lists it under", (inputPath, pair) => {
    const out = run({ a: pair.a, b: pair.b });
    const A = out.a.constraints.hybrid_dlc;
    const B = out.b.constraints.hybrid_dlc;
    const listed = Object.entries(LADDER_FAMILIES).filter(([, ds]) => ds!.some((d) => d.path === inputPath)).map(([id]) => id);
    for (const family of ELECTRICAL) {
      if (listed.includes(family)) expect(A[family], `${inputPath} must move ${family}`).not.toEqual(B[family]);
      else expect(A[family], `${inputPath} must not move ${family}: add it to the ladder if it does`).toEqual(B[family]);
    }
  });

  it("the earlier reviewer's checks still hold on this engine: voltage 230 binds the tap-off gate, 690 does not; 2 runs hold fewer racks than 12; PF 0.8 fewer than 1.0", () => {
    const out = run({
      v230: with_({ voltage_V: 230 }), v690: with_({ voltage_V: 690 }), r2: with_({ busway_runs: 2 }), r12: with_({ busway_runs: 12 }),
      pf8: with_({}, { power_factor: 0.8 }), pf10: with_({}, { power_factor: 1.0 }),
    });
    const racks = (k: string, c: string) => out[k].constraints.hybrid_dlc[c];
    expect(racks("v230", "rack_feed_tapoff")).toBe(0);
    expect(racks("v690", "rack_feed_tapoff")).toBeNull();
    expect(racks("r2", "busway_ampacity")!).toBeLessThan(racks("r12", "busway_ampacity")!);
    expect(racks("pf8", "grid_firm_capacity")!).toBeLessThan(racks("pf10", "grid_firm_capacity")!);
    expect(racks("pf8", "transformer_capacity")!).toBeLessThan(racks("pf10", "transformer_capacity")!);
  });
});

describe("the real-engine suite cannot be skipped silently where it is required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ the utilisation, floor type and redundancy
describe("utilisation, floor type and redundancy are sent only when chosen", () => {
  it("none of them is in the intake document unless given", () => {
    const doc = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, transformers: [{ unit_rating_MVA: 5, units: 2 }], ups: [{ unit_rating_kW: 800, units: 3 }] })) as any;
    expect(doc.compute).toEqual({ platform: "gb300_nvl72" });
    expect("floor_type" in doc.hall).toBe(false);
    expect(doc.transformers).toEqual([{ id: "TX", unit_rating_MVA: 5, units: 2 }]);
    expect(doc.ups).toEqual([{ id: "UPS", unit_rating_kW: 800, units: 3 }]);
    const given = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, utilisation: "0.6", floorType: "slab", transformers: [{ unit_rating_MVA: 5, units: 2, redundancy: "2N" }] })) as any;
    expect([given.compute.utilisation, given.hall.floor_type, given.transformers[0].redundancy]).toEqual([0.6, "slab", "2N"]);
  });

  it("the form leaves each unstated and says what the engine assumes beside the field", () => {
    const src = read("components/EngagementIntake.tsx");
    expect(src).toContain("placeholder={`engine assumes ${ENGINE_LIBRARY_DEFAULTS.utilisation}`}");
    expect(src).toContain("Not stated (engine assumes ${ENGINE_LIBRARY_DEFAULTS.floorType");
    expect(src).toContain("`Not stated (engine assumes ${ENGINE_LIBRARY_DEFAULTS.redundancy})`");
    expect(src).not.toMatch(/utilisation: "0\.75"|redundancy: "N\+1" \}|floorType: "raised_floor"/);
    const rows = [{ id: "TX-1", rating: 5 as const, units: 2 as const, redundancy: "" }];
    const p = intakePayload({ ...EMPTY_FORM }, [], rows, []) as { transformers: Record<string, unknown>[] };
    expect(p.transformers).toEqual([{ id: "TX-1", unit_rating_MVA: 5, units: 2 }]);
    expect((intakePayload({ ...EMPTY_FORM }, [], [{ ...rows[0], redundancy: "N+2" }], []) as any).transformers[0].redundancy).toBe("N+2");
  });
});

describe.runIf(hasPython)("what the engine does with them (real loader, real solver)", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    project: { client: "x", reference: "r" }, site: { name: "s", design_drybulb_C: 30 },
    hall: { id: "H", positions_available: 200, floor_loading_kPa: 15 },
    grid: { firm_capacity_MVA: 15, contracted_MW: 12, current_site_peak_MW: 7.4, current_it_load_MW: 4.9 },
    lv: { busway_ampacity_A: 400, tapoff_max_A: 400 },
    thermal: { plant: { chilled_water_capacity_kW: 12000, design_supply_C: 10 } },
    transformers: [{ unit_rating_MVA: 20, units: 2 }], ups: [{ unit_rating_kW: 5000, units: 6 }],
    compute: { platform: "gb300_nvl72" }, scenarios: ["hybrid_dlc"], ...over,
  });
  it("utilisation moves no capacity limit (so it is not on the evidence ladder): racks and every constraint are identical across 0.3 / 0.75 / 1.0", () => {
    const out = run({ a: base({ compute: { platform: "gb300_nvl72", utilisation: 0.3 } }), b: base(), c: base({ compute: { platform: "gb300_nvl72", utilisation: 1.0 } }) });
    expect(out.a.constraints).toEqual(out.b.constraints);
    expect(out.c.constraints).toEqual(out.b.constraints);
    expect(out.a.racks).toEqual(out.c.racks);
    expect(Object.values(LADDER_FAMILIES).flat().some((d) => d!.path === "compute.utilisation")).toBe(false);
  });
  it("a supplied utilisation is counted as supplied and its gap disappears: omitted it is a named gap", () => {
    const out = run({ without: base(), with: base({ compute: { platform: "gb300_nvl72", utilisation: 0.75 } }) });
    expect(out.without.gaps).toContain("compute.utilisation");
    expect(out.with.gaps).not.toContain("compute.utilisation");
    expect(out.with.supplied).toContain("compute.utilisation");
    expect(out.with.completeness).toBeGreaterThan(out.without.completeness);
  });
  it("floor type and redundancy are silent defaults in the engine: omitted or equal to the default gives an identical result and no gap either way", () => {
    const withN1 = base({ transformers: [{ unit_rating_MVA: 20, units: 2, redundancy: "N+1" }], ups: [{ unit_rating_kW: 5000, units: 6, redundancy: "N+1" }] });
    const out = run({ a: base(), b: withN1, c: base({ hall: { id: "H", positions_available: 200, floor_loading_kPa: 15, floor_type: "raised_floor" } }) });
    expect(out.a).toEqual(out.b);
    expect(out.a).toEqual(out.c);
    expect(out.a.gaps.some((g) => /redundancy|floor_type/.test(g))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ Stream D's engineering constants
describe("this file's engine defaults equal the engineering constants document, where that document exists", () => {
  // lib/engineering-constants.json is Stream D's (a different branch). Until it merges the file is absent here and the comparison is SKIPPED, with this
  // reason in the test name; once present it must agree with ENGINE_LIBRARY_DEFAULTS and the ladder's supplied classes, or this fails.
  const file = path.join(ROOT, "lib", "engineering-constants.json");
  const present = fs.existsSync(file);
  const find = (node: unknown, key: string): unknown => {
    if (!node || typeof node !== "object") return undefined;
    const o = node as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = find(v, key); if (r !== undefined) return r; }
    return undefined;
  };
  const num = (v: unknown) => (v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v);
  it.skipIf(!present)(present ? "voltage, power factor and the voltage's supplied class are the same numbers in both" : "SKIPPED: lib/engineering-constants.json is not on this branch (Stream D's); compared after the merge", () => {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(num(find(doc, "voltage_default_V"))).toBe(ENGINE_LIBRARY_DEFAULTS.voltageV);
    expect(num(find(doc, "site_power_factor_default"))).toBe(ENGINE_LIBRARY_DEFAULTS.powerFactor);
    const cls = num(find(doc, "voltage_supplied_class"));
    const voltage = Object.values(LADDER_FAMILIES).flatMap((d) => d ?? []).find((d) => d.path === "lv.voltage_V")!;
    expect(String(cls)).toMatch(new RegExp(`^${voltage.suppliedClass}\\b`));
  });
  it("the absent-file case is explicit, not a silent pass", () => {
    expect(typeof present).toBe("boolean");
    if (!present) expect(fs.existsSync(path.join(ROOT, "lib", "engagement-intake.ts"))).toBe(true);        // this branch's own constants exist and are pinned above
  });
});
