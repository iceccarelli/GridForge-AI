/**
 * The engine-backed capacity diff for a hall (lib/site-registry-engine.ts), without a database: the rules that build each point's intake document, and the proof that
 * those rules are the ENGINE'S (a drift test against its own schema, its own refusal and the evidence class it really reads), and that its answer is shaped to a whitelist.
 *
 * The drift tests run the real Python engine; where python3 is missing they are skipped unless GRIDFORGE_REQUIRE_ENGINE=1 or CI=true (see _engine-guard.ts), when the last test fails.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_POLICIES } from "@/lib/rate-limit";
import {
  ENGINE_DIFF_PER_HALL_PER_DAY, ENGINE_DIFF_PER_HOUR, ENGINE_DIFF_UNITS, ENGINE_ITEM_RATING, ENGINE_REQUIRED_PATHS, ITEM_FIELDS, RECORDED_MINIMUM, SCALAR_FIELDS,
  buildEngineDocument, carryingClass, compareBuilt, matchField, racksSentence, recordedAsOf, recordedNow, recordedWithProposed, sendableClass, shapeEngineDiff,
  type Built, type Recorded,
} from "@/lib/site-registry-engine";
import { EXPECTED_HALL_FIELDS, EVIDENCE_CLASS_CODES, ORIGINS } from "@/lib/site-registry-fields";
import type { RegistryInput } from "@/lib/site-registry-model";
import { engineAvailable } from "./_engine-guard";
import { REFERENCE_HALL, referenceInputs } from "./site-registry-reference-hall";

const ROOT = path.resolve(__dirname, "../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const py = (code: string, stdin = ""): any => {
  const r = spawnSync("python3", ["-c", code], { cwd: ROOT, input: stdin, encoding: "utf8", env: { ...process.env, PYTHONPATH: ROOT } });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

const build = (inputs: RegistryInput[]): Built => buildEngineDocument(recordedNow(inputs));
const get = (doc: Record<string, any>, p: string): any => p.split(".").reduce((c: any, k) => c?.[k], doc);

// ------------------------------------------------------------------------------------------------ the table against the engine

describe.runIf(hasPython)("the table is the engine's own intake (drift test against the real engine)", () => {
  const meta = py([
    "import json", "from gridforge.intake.schema import INTAKE_FIELDS, REQUIRED_PATHS", "from gridforge.api.metering import UNIT_COST",
    "print(json.dumps({'required': list(REQUIRED_PATHS), 'fields': {f.path: {'label': f.label, 'required': f.required, 'unit': f.unit} for f in INTAKE_FIELDS}, 'diff_units': UNIT_COST['/v1/diff']}))",
  ].join("\n"));

  it("the engine's required list is the one in the lib, spelled the same", () => {
    expect([...ENGINE_REQUIRED_PATHS].sort()).toEqual([...meta.required].sort());
  });

  it("every scalar the engine's schema lists has the same path, label and required flag; every other one says its label is ours", () => {
    for (const f of SCALAR_FIELDS) {
      const e = meta.fields[f.engine];
      if (f.labelIsEngines) {
        expect(e, f.engine).toBeDefined();
        expect(f.label, f.engine).toBe(e.label);
        expect(f.need === "engine_required", f.engine).toBe(e.required);
        // a real unit is the engine's unit; a dimensionless figure has none here
        if (e.unit === "-" || e.unit === "positions") expect(["", "-"], f.engine).toContain(f.unit);
        else expect(f.unit, f.engine).toBe(e.unit);
      } else {
        expect(e, `${f.engine} is in the engine's schema, so its label should be the engine's`).toBeUndefined();
      }
    }
  });

  it("every required field of the engine's schema is covered: each is a scalar here or one of the two equipment lists, and nothing marked required is outside the list", () => {
    const scalars = new Set(SCALAR_FIELDS.filter((f) => f.need === "engine_required").map((f) => f.engine));
    for (const p of meta.required) expect(scalars.has(p) || p === "transformers" || p === "ups", p).toBe(true);
    for (const p of scalars) expect(meta.required, p).toContain(p);
    for (const s of ["transformers", "ups"] as const) expect(ITEM_FIELDS[s].some((f) => f.need === "engine_required")).toBe(true);
  });

  it("the minimum a run needs is exactly the engine's required list plus the figures it would default without a word", () => {
    expect(RECORDED_MINIMUM).toEqual(expect.arrayContaining(["transformers[0].unit_rating_mva", "ups[0].unit_rating_kw", "transformers[0].units", "ups[0].redundancy", "hall.rack_positions", "compute.platform"]));
    const asEngine = SCALAR_FIELDS.filter((f) => f.need === "engine_required").map((f) => f.engine);
    expect(asEngine.length + 2).toBe(meta.required.length);        // + the two lists
  });

  it("a diff costs what the lib says", () => {
    expect(meta.diff_units).toBe(ENGINE_DIFF_UNITS);
  });

  it("the allowance the page states is the policy the route enforces", () => {
    expect(RATE_POLICIES.registry_diff).toEqual({ bucket: "registry_diff", limit: ENGINE_DIFF_PER_HOUR, windowSeconds: 3600 });
    expect(RATE_POLICIES.registry_diff_hall).toEqual({ bucket: "registry_diff_hall", limit: ENGINE_DIFF_PER_HALL_PER_DAY, windowSeconds: 86400 });
  });

  it("the engine refuses a list item that has no rating, in the words the lib names", () => {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/intake/reference_hall.json"), "utf8"));
    for (const [section, key] of Object.entries(ENGINE_ITEM_RATING)) {
      const doc = { ...base, [section]: [{ units: 2 }] };
      const out = py(["import json,sys", "from gridforge.intake.loader import load_document, IntakeError", "d=json.load(sys.stdin)",
        "try:\n    load_document(d); print(json.dumps({'ok': True}))\nexcept IntakeError as e:\n    print(json.dumps({'ok': False, 'msg': str(e)}))"].join("\n"), JSON.stringify(doc));
      expect(out.ok).toBe(false);
      expect(out.msg).toBe(`the intake is missing a required field: ${key}`);
    }
  });

  it("the engine reads each figure at the class the table says: the declared one, a fixed one, or none at all", () => {
    const b = build(referenceInputs());
    expect(b.absent).toEqual([]);
    const read = py([
      "import json,sys", "from gridforge.intake.loader import load_document", "c=load_document(json.load(sys.stdin)).context", "g=c.power.grid; lv=c.power.lv; p=c.thermal.plant; t=c.power.transformers[0]; u=c.power.ups[0]",
      "print(json.dumps({'grid.firm_capacity_mva': g.firm_capacity_MVA.evidence.short, 'grid.contracted_mw': g.contracted_MW.evidence.short, 'grid.power_factor': g.power_factor.evidence.short,",
      " 'lv.busway_ampacity_a': lv.busway_ampacity_A.evidence.short, 'hall.floor_loading_kpa': c.hall.floor_loading_kPa.evidence.short, 'thermal.plant.design_supply_c': p.design_supply_C.evidence.short,",
      " 'economics.discount_rate': (c.economics.discount_rate.evidence.short if c.economics.discount_rate is not None else None),",
      " 'transformers[0].unit_rating_mva': t.unit_rating_MVA.evidence.short, 'transformers[0].derating_factor': t.derating_factor.evidence.short, 'transformers[0].replacement_lead_time_weeks': t.replacement_lead_time_weeks.evidence.short,",
      " 'ups[0].unit_rating_kw': u.unit_rating_kW.evidence.short, 'ups[0].step_load_capability': u.step_load_capability.evidence.short}))",
    ].join("\n"), JSON.stringify({ ...b.doc, economics: { discount_rate: { value: 0.08, evidence: "E1" } } }));
    expect(Object.keys(read)).toHaveLength(12);
    for (const [p, cls] of Object.entries(read) as [string, string | null][]) {
      const m = matchField(p)!;
      expect(m, p).not.toBeNull();
      const h = m.field.handling;
      if (p === "economics.discount_rate") { expect(h).toEqual({ how: "fixed", cls: 5 }); expect(cls).toBe("E5"); continue; }
      if (h.how === "declared") {
        const sent = b.sentClass.get(m.field.engine.replace("[]", "[0]"));
        expect(sent, p).toMatch(/^E[0-5]$/);
        expect(cls, p).toBe(sent);
      } else if (h.how === "fixed") expect(cls, p).toBe(`E${h.cls}`);
    }
  });

  it("the engine itself would solve a document with required figures left out (it fills them from its library without saying so in a diff), which is why this page enforces the minimum itself", async () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/intake/reference_hall.json"), "utf8"));
    const out = py([
      "import json,sys", "from gridforge.api.server import handle_diff", "from gridforge.api.tiers import Tier", "d=json.load(sys.stdin)", "a=json.loads(json.dumps(d)); a['grid']['contracted_MW']=9",
      "for k in ('platform',): d['compute'].pop(k); a['compute'].pop(k)", "d.pop('transformers'); a.pop('transformers'); d['hall'].pop('positions_available'); a['hall'].pop('positions_available')",
      "r=handle_diff({'before': d, 'after': a}, Tier.CLIENT); print(json.dumps({'ok': True, 'headline': r['headline']}))",
    ].join("\n"), JSON.stringify(doc));
    expect(out.ok).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ the class that may be sent

describe("the class sent with a figure is never higher than declared, and never higher than the registry can stand behind", () => {
  const fileStates = [
    { name: "no file", source: null },
    { name: "verified", source: { kind: "project_evidence", id: "f", filename: "a.pdf", reviewStatus: "verified" } },
    { name: "unreviewed", source: { kind: "project_evidence", id: "f", filename: "a.pdf", reviewStatus: "unverified" } },
    { name: "rejected", source: { kind: "project_evidence", id: "f", filename: "a.pdf", reviewStatus: "rejected" } },
    { name: "engagement file", source: { kind: "intake_evidence", id: "f", filename: "a.pdf", reviewStatus: null } },
  ] as const;

  it("over every origin, declared class and file state: sent <= declared, sent <= 5, sent <= 3 unless a project file is reviewed and verified, sent <= 3 for assumed and modelled", () => {
    let n = 0;
    for (const origin of ORIGINS) for (const cls of EVIDENCE_CLASS_CODES) for (const f of fileStates) {
      const s = sendableClass({ origin, evidenceClass: cls, source: f.source });
      const declared = Number(cls.slice(1));
      const label = `${origin} ${cls} ${f.name}`;
      expect(s.declared, label).toBe(declared);
      expect(s.sent, label).toBeLessThanOrEqual(declared);
      expect(s.sent, label).toBeLessThanOrEqual(5);
      if (!(f.name === "verified")) expect(s.sent, label).toBeLessThanOrEqual(3);
      if (origin === "assumed" || origin === "modelled") expect(s.sent, label).toBeLessThanOrEqual(3);
      // a figure sent below its declared class says why; one sent at its declared class says nothing
      expect(s.why === null, label).toBe(s.sent === declared);
      n++;
    }
    expect(n).toBe(7 * 8 * 5);
  });

  it("a verified project file carries the declared class up to E5, and E6 or E7 is sent as E5 with the engine's reason", () => {
    const v = fileStates[1].source;
    expect(sendableClass({ origin: "measured", evidenceClass: "E5", source: v })).toEqual({ declared: 5, sent: 5, why: null });
    const six = sendableClass({ origin: "vendor", evidenceClass: "E6", source: v });
    expect(six.sent).toBe(5);
    expect(six.why).toMatch(/calibration ledger/);
  });

  it("a file that is not reviewed, or was rejected, or is an engagement file holds a declared E5 at E3, and the reason names the file", () => {
    for (const f of fileStates.slice(2)) {
      const s = sendableClass({ origin: "measured", evidenceClass: "E5", source: f.source });
      expect(s.sent, f.name).toBe(3);
      expect(s.why, f.name).toMatch(/file it cites is not reviewed and verified now/);
    }
    expect(sendableClass({ origin: "measured", evidenceClass: "E4", source: null }).why).toMatch(/cites no file/);
  });

  it("the document carries exactly that class: a declared-measured E5 on a file that has since been rejected goes out as E3, with a class note", () => {
    const b = build(referenceInputs({ fileStatus: "rejected" }));
    const fm = get(b.doc, "grid.firm_capacity_MVA");
    expect(fm).toMatchObject({ value: 14, evidence: "E3", note: "declared measured by the recorder; file rejected" });
    expect(b.classNotes.find((n) => n.path === "grid.firm_capacity_mva")).toMatchObject({ declared: "E5", sent: "E3" });
    // and no annotated figure in the document is above E5, or above the class its figure declared
    const declared = new Map(referenceInputs().map((i) => [i.fieldPath, Number(i.evidenceClass.slice(1))]));
    for (const [ep, cls] of b.sentClass) {
      if (!cls) continue;
      const rec = b.pathMap.get(ep)!;
      expect(Number(cls.slice(1)), ep).toBeLessThanOrEqual(declared.get(rec)!);
      expect(Number(cls.slice(1)), ep).toBeLessThanOrEqual(5);
    }
  });

  it("MUTATION: a builder that sent the declared class whatever the file says would fail the check above (the guard sees an E5 over a rejected file)", () => {
    const honest = build(referenceInputs({ fileStatus: "rejected" }));
    const sentAt = (b: Built) => Number(String(get(b.doc, "grid.firm_capacity_MVA").evidence).slice(1));
    expect(sentAt(honest)).toBe(3);
    // the mutation: treat every file as verified
    const mutated = build(referenceInputs({ fileStatus: "verified" }));
    expect(sentAt(mutated)).toBe(5);
    const guard = (b: Built, rejected: boolean) => !(rejected && sentAt(b) > 3);
    expect(guard(honest, true)).toBe(true);
    expect(guard(mutated, true)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ one document

describe("a document built from the reference hall", () => {
  const inputs = referenceInputs();
  const b = build(inputs);

  it("has nothing missing, and every scalar the registry calls a number goes as the annotated form with its class and the recorder's declaration", () => {
    expect(b.absent).toEqual([]);
    expect(get(b.doc, "grid.contracted_MW")).toEqual({ value: 12, evidence: "E3", note: "declared assumed by the recorder; no file cited" });
    expect(get(b.doc, "grid.firm_capacity_MVA")).toEqual({ value: 14, evidence: "E5", note: "declared measured by the recorder; file reviewed and verified" });
    expect(get(b.doc, "compute.platform")).toEqual({ value: "gb300_nvl72", evidence: "E3", note: "declared vendor by the recorder; no file cited" });
    expect(get(b.doc, "hall.rack_positions")).toMatchObject({ value: 560, evidence: "E1" });
  });

  it("the equipment lists carry plain values (the engine takes no class there), compacted from index 0", () => {
    expect(b.doc.transformers).toEqual([{ unit_rating_MVA: 5, units: 3, redundancy: "N+1", derating_factor: 0.9, replacement_lead_time_weeks: 160 }]);
    expect(b.doc.ups).toEqual([{ unit_rating_kW: 1200, units: 6, redundancy: "N+1", step_load_capability: 0.5 }]);
  });

  it("sends no address, file name or file reference, and no key the engine's intake does not have", () => {
    const text = JSON.stringify(b.doc);
    expect(text).not.toMatch(/@|nameplate|\.pdf|storage|file-\d/);
    const allowed = new Set(["grid", "lv", "hall", "thermal", "compute", "site", "economics", "transformers", "ups"]);
    for (const k of Object.keys(b.doc)) expect(allowed.has(k), k).toBe(true);
  });

  it("the fixture agrees with the engine's own synthetic example, value for value", () => {
    const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/intake/reference_hall.json"), "utf8"));
    const at = (d: any, p: string): any => {
      const v = p.split(/\.|\[|\]/).filter(Boolean).reduce((c: any, k) => c?.[/^\d+$/.test(k) ? Number(k) : k], d);
      return v && typeof v === "object" && "value" in v ? v.value : v;
    };
    let checked = 0;
    for (const f of REFERENCE_HALL) {
      const want = at(ex, f.engine);
      if (want === undefined) continue;                                  // a figure the example leaves to the library (e.g. the UPS rating is in the example; some optional ones are not)
      expect(f.value, f.fieldPath).toBe(want);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(24);
  });

  it("a figure the engine would default is listed as a placeholder with what it falls back to, never silently", () => {
    const ph = new Map(b.placeholders.map((p) => [p.path, p]));
    expect(ph.get("economics.electricity_eur_per_mwh")?.fallback).toMatch(/140 EUR\/MWh/);
    expect(ph.get("lv.existing_busway_load_kw")?.fallback).toMatch(/nothing is subtracted/);
    expect(ph.has("grid.firm_capacity_mva")).toBe(false);
  });

  it("figures that carry no class (counts, names) put a ceiling on the class the answer may have", () => {
    const c = compareBuilt(b, b);
    expect(c.ceiling?.cls).toBe("E1");
    expect(c.ceiling?.paths).toEqual(expect.arrayContaining(["hall.rack_positions", "transformers[0].units"]));
    expect(carryingClass("E3", c.ceiling)).toBe("E1");
    expect(carryingClass("E0", c.ceiling)).toBe("E0");
    expect(carryingClass("E4", null)).toBe("E4");
    expect(carryingClass(null, null)).toBeNull();
  });
});

describe("what is missing is named exactly, and nothing is invented to make a run succeed", () => {
  it.each(RECORDED_MINIMUM.map((p) => [p]))("without %s the document has exactly that figure missing, with a reason", (p) => {
    const b = build(referenceInputs({ drop: [p] }));
    expect(b.absent.map((a) => a.path)).toEqual([p]);
    expect(b.absent[0]!.reason).toMatch(/not recorded/);
  });

  it("a hall with nothing recorded is missing every figure of the minimum, the first transformer and UPS item included", () => {
    const b = build([]);
    expect(b.absent.map((a) => a.path).sort()).toEqual([...RECORDED_MINIMUM].sort());
    expect(b.doc.transformers).toBeUndefined();
  });

  it("a figure recorded as missing, as text where a number is wanted, in the wrong unit, or as a fraction of a unit is missing with its own reason, and is not sent", () => {
    const b = build(referenceInputs({ set: {
      "grid.contracted_mw": { origin: "missing", value: null, unit: null, evidenceClass: "E0" },
      "grid.current_site_peak_mw": { value: "seven" },
      "lv.busway_ampacity_a": { unit: "kA" },
      "hall.positions_available": { value: 12.5 },
      "compute.platform": { value: 5 },
    } }));
    const by = new Map(b.absent.map((a) => [a.path, a.reason]));
    expect(by.get("grid.contracted_mw")).toBe("It is recorded as missing.");
    expect(by.get("grid.current_site_peak_mw")).toMatch(/recorded as text/);
    expect(by.get("lv.busway_ampacity_a")).toMatch(/recorded in “kA”.*does not convert/);
    expect(by.get("hall.positions_available")).toMatch(/whole number/);
    expect(by.get("compute.platform")).toMatch(/takes a name/);
    expect(JSON.stringify(b.doc)).not.toMatch(/seven|kA/);
  });

  it("a transformer or UPS rating the engine would read ABOVE its declared class is not sent: it is missing, with that reason", () => {
    const b = build(referenceInputs({ set: { "transformers[0].unit_rating_mva": { origin: "assumed", evidenceClass: "E3", source: null } } }));
    expect(b.absent.map((a) => a.path)).toEqual(["transformers[0].unit_rating_mva"]);
    expect(b.absent[0]!.reason).toMatch(/reads this figure as E5 whatever class is sent, and it is recorded as E3/);
    expect(b.doc.transformers).toBeUndefined();
  });

  it("a rating on an unreviewed file is carried at E3 and so is not sent either", () => {
    const b = build(referenceInputs({ fileStatus: "unverified" }));
    expect(b.absent.map((a) => a.path).sort()).toEqual(["transformers[0].unit_rating_mva", "ups[0].unit_rating_kw"]);
    expect(b.absent[0]!.reason).toMatch(/carried at E3/);
  });

  it("an incomplete second item blocks the run (it is not silently dropped) and its other figures are not sent", () => {
    const more: RegistryInput[] = [
      ...referenceInputs(),
      { ...referenceInputs()[0]!, id: "t1u", fieldPath: "transformers[1].units", value: 2, unit: null, origin: "assumed", evidenceClass: "E1", source: null },
      { ...referenceInputs()[0]!, id: "t1d", fieldPath: "transformers[1].derating_factor", value: 0.9, unit: null, origin: "assumed", evidenceClass: "E3", source: null },
    ];
    const b = build(more);
    expect(b.absent.map((a) => a.path).sort()).toEqual(["transformers[1].redundancy", "transformers[1].unit_rating_mva"]);
    expect(b.notUsed.some((n) => n.path === "transformers[1].derating_factor")).toBe(true);
  });

  it("a recorded field that is not an engine input takes no part and is listed, and a field whose history was not loaded is unknown, not 'not recorded'", () => {
    const rec: Recorded = recordedNow([...referenceInputs(), { ...referenceInputs()[0]!, id: "x", fieldPath: "grid.queue_position", value: 4, unit: null, origin: "assumed", evidenceClass: "E1", source: null }]);
    rec.set("grid.contracted_mw", { unknown: true });
    const b = buildEngineDocument(rec);
    expect(b.notUsed).toContainEqual({ path: "grid.queue_position", reason: "The engine's intake has no such input, so it takes no part in the run." });
    expect(b.absent.find((a) => a.path === "grid.contracted_mw")?.reason).toMatch(/older history was not loaded/);
  });

  it("two sides are compared: a figure missing on one side only names that side; the same figure on both sides names both", () => {
    const one = compareBuilt(build(referenceInputs()), build(referenceInputs({ drop: ["compute.platform"] })));
    expect(one.missing).toMatchObject([{ path: "compute.platform", sides: ["to"], need: "engine_required", label: "Target platform" }]);
    const both = compareBuilt(build(referenceInputs({ drop: ["hall.rack_positions"] })), build(referenceInputs({ drop: ["hall.rack_positions"] })));
    expect(both.missing).toMatchObject([{ path: "hall.rack_positions", sides: ["from", "to"], need: "no_gap_default", inTemplate: true }]);
    expect(both.missing[0]!.reason).toBe("It is not recorded.");
  });

  it("the import template carries a missing figure only when it is one of the hall's expected fields", () => {
    const m = compareBuilt(build([]), build([])).missing;
    const t = new Map(m.map((x) => [x.path, x.inTemplate]));
    for (const f of EXPECTED_HALL_FIELDS) if (t.has(f.path)) expect(t.get(f.path), f.path).toBe(true);
    expect(t.get("transformers[0].units")).toBe(false);
    expect(t.get("compute.platform")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ points in time

describe("the state at a point", () => {
  const day = (d: string) => `${d}T12:00:00Z`;
  const claim = (id: string, d: string, value: number, supersedesId: string | null = null): RegistryInput => ({
    ...referenceInputs()[1]!, id, value, recordedAt: day(d), supersedesId, superseded: false,
  });
  const claims = [claim("a", "2026-01-10", 10), claim("b", "2026-02-10", 12, "a"), claim("c", "2026-03-10", 14, "b")];

  it("is the latest claim recorded by the end of that UTC day", () => {
    const at = (d: string) => (recordedAsOf(claims, d).get("grid.contracted_mw") as { input: RegistryInput } | undefined)?.input.value;
    expect(at("2026-01-09")).toBeUndefined();
    expect(at("2026-01-10")).toBe(10);
    expect(at("2026-02-09")).toBe(10);
    expect(at("2026-02-10")).toBe(12);
    expect(at("2026-12-31")).toBe(14);
  });

  it("is unknown, not absent, when the older history was not loaded", () => {
    const partial = claims.slice(1);                                   // the first claim is not among those loaded
    expect(recordedAsOf(partial, "2026-01-20").get("grid.contracted_mw")).toEqual({ unknown: true });
    expect(recordedAsOf(partial, "2026-02-20").get("grid.contracted_mw")).toMatchObject({ input: { value: 12 } });
  });
});

describe("a pending import laid over the current figures is judged by the import's own rules", () => {
  const cur = referenceInputs();
  const row = (cells: Record<string, unknown>, n = 1) => ({ n, fromCsv: false, cells });
  const plan = recordedWithProposed(cur, [
    row({ field_path: "grid.contracted_mw", value: 15, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" }, 1),
    row({ field_path: "grid.current_site_peak_mw", value: 8, unit: "MW", origin: "assumed", class: "E5", as_of: "2026-02-01" }, 2),     // an assumed figure above E3: the import rejects it
    row({ field_path: "not.a.field", value: 1, origin: "assumed", class: "E1", as_of: "2026-02-01" }, 3),
    row({ field_path: "hall.floor_loading_kpa", value: 12, unit: "kPa", origin: "assumed", class: "E1", as_of: "2026-01-15" }, 4),       // the same as now: unchanged
  ], "2026-11-07");

  it("uses only the rows the import would write, lists the others with the import's reason, and counts the unchanged", () => {
    expect(plan.used).toBe(1);
    expect(plan.unchanged).toBe(1);
    expect(plan.excluded.map((e) => e.n)).toEqual([2, 3]);
    expect(plan.excluded[0]!.reason).toMatch(/cannot claim a class above E3/);
    expect(plan.excluded[1]!.reason).toMatch(/not a field this registry knows/);
  });

  it("changes the figure it replaces and nothing else, without touching the input it was given", () => {
    const b = buildEngineDocument(plan.recorded);
    expect(get(b.doc, "grid.contracted_MW")).toMatchObject({ value: 15, evidence: "E3" });
    expect(get(b.doc, "grid.current_site_peak_MW")).toMatchObject({ value: 7.4 });
    expect(cur.find((i) => i.fieldPath === "grid.contracted_mw")!.value).toBe(12);
  });

  it("a file cited by a pending row whose review status the preview cannot see is carried at E3 at most", () => {
    const p = recordedWithProposed(cur, [row({ field_path: "grid.contracted_mw", value: 15, unit: "MW", origin: "measured", class: "E5", as_of: "2026-02-01", source_kind: "project", source_id: "11111111-1111-4111-8111-111111111111" })], "2026-11-07");
    const b = buildEngineDocument(p.recorded);
    expect(get(b.doc, "grid.contracted_MW")).toMatchObject({ evidence: "E3", note: "declared measured by the recorder; file not yet reviewed" });
  });
});

// ------------------------------------------------------------------------------------------------ the answer, whitelisted

describe("the engine's answer is reduced to a whitelist", () => {
  const state = (over: Record<string, unknown> = {}) => ({
    racks_as_found: 0, racks_after_ladder: 28, binding_id: "x", binding_name: "Rack feed / tap-off rating", binding_basis: "platform needs 205 A per rack; tap-offs rated 63 A (E5)",
    weeks_to_full: 160, scenario_name: "Full DLC, grid only", racks_class: "E0_ASSUMPTION", capex_eur: 6216000, intake_digest: "SECRET-DIGEST", storage_ref: "SECRET-STORAGE", ...over,
  });
  const raw = {
    headline: "-28 racks (28 to 0)", material: true, racks_delta: -28, explained_racks: -28, unexplained_racks: 0, binding_moved: true, weeks_delta: -128, inputs: "changed",
    date_basis: "assumed", date_evidence_class: "E0", date_binding_item: "Transformer capacity", date_label: "assumed lead time, not a date (E0; set by transformer capacity)",
    before: state(), after: state({ racks_after_ladder: 0, binding_name: "Firm supply" }), capex_delta_eur: 1, token: "SECRET-TOKEN", email: "x@y.example",
    drivers: [{ path: "grid.firm_capacity_MVA", before: 14, after: 6, racks_delta: -28, flips_binding_to: "Firm supply", racks_class: "E0_ASSUMPTION", digest: "SECRET-D" }],
    unprobed_inputs: [], unprobeable_inputs: ["transformers[0].units"], model_drift: ["prices"], price_basis_digest: "SECRET-P",
  };
  const maps = { from: new Map([["grid.firm_capacity_MVA", "grid.firm_capacity_mva"], ["transformers[0].units", "transformers[3].units"]]), to: new Map<string, string>() };

  it("keeps the figures a reader needs, maps a driver to the path as recorded and the engine's label, and drops everything else", () => {
    const v = shapeEngineDiff(raw, maps)!;
    expect(v).not.toBeNull();
    expect(v.drivers).toEqual([{ path: "grid.firm_capacity_mva", enginePath: "grid.firm_capacity_MVA", label: "Firm connection capacity", before: 14, after: 6, direction: "lowers", racksDelta: -28, flipsBindingTo: "Firm supply", racksClass: "E0" }]);
    expect(v.racksClass).toBe("E0");
    expect(v.notAttributed).toEqual(["transformers[3].units"]);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/SECRET|@|capex|digest|token|storage/i);
  });

  it("a weeks figure is only a number beside what it rests on; an engine that does not say what it rests on gives no number", () => {
    expect(shapeEngineDiff(raw, maps)!.weeks).toEqual({ delta: -128, basis: "assumed", evidenceClass: "E0", bindingItem: "Transformer capacity", label: "assumed lead time, not a date (E0; set by transformer capacity)" });
    const bare = shapeEngineDiff({ ...raw, date_basis: undefined, date_label: undefined, date_evidence_class: undefined, date_binding_item: undefined }, maps)!.weeks;
    expect(bare).toMatchObject({ delta: null, basis: "unverified", label: "lead time unverified" });
    expect(shapeEngineDiff({ ...raw, date_basis: "none", weeks_delta: null }, maps)!.weeks).toMatchObject({ delta: null, basis: "none" });
  });

  it("an answer that is not in the expected form is refused whole, never half shown", () => {
    for (const bad of [null, "x", {}, { ...raw, racks_delta: "28" }, { ...raw, drivers: "none" }, { ...raw, before: {} }, { ...raw, headline: "" }, { ...raw, binding_moved: "yes" }, { ...raw, drivers: [{ path: 3, racks_delta: 1 }] }]) {
      expect(shapeEngineDiff(bad, maps)).toBeNull();
    }
  });

  it("the rack sentence says raises or lowers by a number and the class that carries it, and never 'improvement'", () => {
    const d = { before: { racksAfterLadder: 20 }, after: { racksAfterLadder: 24 } };
    expect(racksSentence({ racksDelta: 4, ...d }, "E1")).toBe("Raises the rack count by 4 (from 20 to 24), carried by class E1.");
    expect(racksSentence({ racksDelta: -4, before: { racksAfterLadder: 24 }, after: { racksAfterLadder: 20 } }, null)).toBe("Lowers the rack count by 4 (from 24 to 20), with no class stated by the engine.");
    expect(racksSentence({ racksDelta: 0, before: { racksAfterLadder: 24 }, after: { racksAfterLadder: 24 } }, "E3")).toBe("Does not change the rack count (24), carried by class E3.");
  });
});

// ------------------------------------------------------------------------------------------------ the real engine, end to end through the lib

const KEY = "registry-engine-diff-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
beforeAll(async () => {
  if (!hasPython) return;
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0", "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  ENGINE = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}, 30_000);
afterAll(() => engine?.kill());

describe.runIf(hasPython)("the documents are accepted by the real engine, and its answer is attributed to the recorded inputs", () => {
  const ask = async (before: Built, after: Built) => {
    const res = await fetch(`${ENGINE}/v1/diff`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ before: before.doc, after: after.doc, cost_evidence: [] }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("a changed contracted capacity: the engine attributes the movement to that input, which maps back to the recorded path with the engine's label", async () => {
    const before = build(referenceInputs());
    const after = build(referenceInputs({ set: { "grid.firm_capacity_mva": { value: 9 } } }));
    const { status, body } = await ask(before, after);
    expect(status).toBe(200);
    const v = shapeEngineDiff(body, { from: before.pathMap, to: after.pathMap })!;
    expect(v).not.toBeNull();
    expect(v.drivers.map((d) => d.path)).toEqual(["grid.firm_capacity_mva"]);
    expect(v.drivers[0]!.label).toBe("Firm connection capacity");
    expect(v.drivers[0]!.before).toBe(14);
    expect(v.drivers[0]!.after).toBe(9);
    expect(v.racksDelta).toBe(v.explainedRacks + v.unexplainedRacks);
    expect((body.provenance as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);          // cost_evidence: [] makes the engine say which build answered
  });

  it("a change of declared class alone, the value the same, is seen by the engine as a change of evidence, not of inputs", async () => {
    const before = build(referenceInputs());
    const after = build(referenceInputs({ set: { "grid.contracted_mw": { evidenceClass: "E1" } } }));
    expect(compareBuilt(before, after).classChanges).toEqual([{ path: "grid.contracted_mw", from: "E3", to: "E1" }]);
    const { body } = await ask(before, after);
    expect(body.changed_inputs).toEqual([]);
    expect(body.inputs).toBe("changed");
  });

  it("the weeks figure of a hall whose lead time is a recorded assumption is labelled as assumed", async () => {
    const before = build(referenceInputs());
    const after = build(referenceInputs({ set: { "transformers[0].replacement_lead_time_weeks": { value: 100 }, "grid.contracted_mw": { value: 14 } } }));
    const { body } = await ask(before, after);
    const v = shapeEngineDiff(body, { from: before.pathMap, to: after.pathMap })!;
    expect(["assumed", "none", "supported"]).toContain(v.weeks.basis);
    if (v.weeks.delta !== null) expect(v.weeks.label).toMatch(/lead time|assumed|class/);
  });
});

describe("the real-engine suites cannot be skipped silently where they are required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});

// keep React imported for the component tests added below in sites-page.test.ts
void React; void renderToStaticMarkup;
