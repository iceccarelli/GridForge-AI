// The optional "other heat the existing hall already puts on the plant" field, from the website form to the engine's loader.
// The engine subtracts it from the plant headroom when supplied and changes nothing when absent (tests/test_existing_non_it_heat.py proves that side);
// these tests prove the website side sends exactly that and nothing else, and that the engine's own loader accepts what the form builds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { engagementIntakeSchema, screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { engineAvailable } from "./_engine-guard";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const ROOT = path.resolve(__dirname, "..", "..");
const FIELD = "thermal.plant.existing_non_it_heat_kW";

// A synthetic hall that satisfies the Density Screen's schema.
const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

const plantOf = (doc: unknown) => ((doc as { thermal: { plant: Record<string, unknown> } }).thermal.plant);

describe("the existing-non-it-heat field in the intake form schema", () => {
  it("is optional: a hall without it parses, and the document carries no such key", () => {
    const parsed = screenIntakeSchema.safeParse(HALL);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.existingNonItHeatKW).toBeUndefined();
    expect("existing_non_it_heat_kW" in plantOf(toIntakeDocument(parsed.data))).toBe(false);
  });

  it("maps to the engine's field name when given, next to the plant capacity it is carried by", () => {
    const parsed = screenIntakeSchema.parse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: 3000 });
    const plant = plantOf(toIntakeDocument(parsed));
    expect(plant.chilled_water_capacity_kW).toBe(9000);
    expect(plant.existing_non_it_heat_kW).toBe(3000);
  });

  it("treats zero as a real figure (nothing extra subtracted), not as absent", () => {
    const parsed = screenIntakeSchema.parse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: 0 });
    expect(parsed.existingNonItHeatKW).toBe(0);
    expect(plantOf(toIntakeDocument(parsed)).existing_non_it_heat_kW).toBe(0);
  });

  it("refuses a figure above the plant capacity, naming both numbers, on the field itself", () => {
    const r = screenIntakeSchema.safeParse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: 9500 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.path.join(".") === "existingNonItHeatKW");
    expect(issue?.message).toContain("9500");
    expect(issue?.message).toContain("9000");
  });

  it("accepts a figure equal to the plant capacity (the engine clamps the result at zero racks, it does not refuse)", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: 9000 }).success).toBe(true);
  });

  it("does not compare against a plant capacity nobody gave (the engine applies its own placeholder and says so)", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, plantCapacityKW: undefined, existingNonItHeatKW: 3000 }).success).toBe(true);
  });

  it("refuses a negative or non-numeric figure", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: -1 }).success).toBe(false);
    expect(screenIntakeSchema.safeParse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: "abc" }).success).toBe(false);
  });

  it("a blank form box never becomes zero: the form drops blanks before parsing, and an absent figure leaves no key", () => {
    const form = readFileSync(path.join(ROOT, "components/EngagementIntake.tsx"), "utf8");
    // Every form value goes through the same blank-to-undefined step; this field is one of those values, with a blank initial state.
    expect(form).toContain('existingNonItHeatKW: ""');
    expect(form).toMatch(/Object\.entries\(f\)\.map\(\(\[k, v\]\) => \[k, confirmed\.includes\(k\) \? undefined : clean\(v\)\]\)/);
    const blank = (v: string) => (v.trim() === "" ? undefined : v);
    const parsed = screenIntakeSchema.parse({ ...HALL, existingNonItHeatKW: blank("  ") });
    expect(parsed.existingNonItHeatKW).toBeUndefined();
    expect("existing_non_it_heat_kW" in plantOf(toIntakeDocument(parsed))).toBe(false);
    // Typed digits arrive as text and are read as the number typed.
    expect(screenIntakeSchema.parse({ ...HALL, existingNonItHeatKW: blank("750") }).existingNonItHeatKW).toBe(750);
  });

  it("applies to the full-intake schema too, and the schemas keep their shape (other code reads .shape)", () => {
    expect("existingNonItHeatKW" in screenIntakeSchema.shape).toBe(true);
    expect("existingNonItHeatKW" in engagementIntakeSchema.shape).toBe(true);
  });
});

describe("the field name the website sends is the one the engine defines", () => {
  it("is declared in the engine's intake schema and read by its loader", () => {
    const schema = readFileSync(path.join(ROOT, "gridforge/intake/schema.py"), "utf8");
    const loader = readFileSync(path.join(ROOT, "gridforge/intake/loader.py"), "utf8");
    expect(schema).toContain(FIELD);
    expect(loader).toContain(FIELD);
  });

  it.runIf(hasPython)("is accepted by the real engine loader, and read back with its value (absent: None)", () => {
    const read = (doc: unknown) => {
      const dir = mkdtempSync(path.join(tmpdir(), "gf-existing-non-it-heat-"));
      const file = path.join(dir, "intake.json");
      writeFileSync(file, JSON.stringify(doc));
      const py = "import sys; from gridforge.intake.loader import load; v = load(sys.argv[1]).context.thermal.plant.existing_non_it_heat_kW; print('None' if v is None else v.value)";
      const out = spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); ${py}`, file], { encoding: "utf8" });
      expect(out.status, out.stderr).toBe(0);
      return out.stdout.trim();
    };
    const given = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, plantCapacityKW: 9000, existingNonItHeatKW: 3000 }));
    const absent = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, plantCapacityKW: 9000 }));
    expect(Number(read(given))).toBe(3000);
    expect(read(absent)).toBe("None");
  });

  it.runIf(hasPython)("the engine's own loader refuses the same figure the form refuses, naming both numbers", () => {
    const doc = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, plantCapacityKW: 9000 }));
    plantOf(doc).existing_non_it_heat_kW = 9500;
    const dir = mkdtempSync(path.join(tmpdir(), "gf-existing-non-it-heat-"));
    const file = path.join(dir, "intake.json");
    writeFileSync(file, JSON.stringify(doc));
    const py = "import sys; from gridforge.intake.loader import load; load(sys.argv[1])";
    const out = spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); ${py}`, file], { encoding: "utf8" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("9500");
    expect(out.stderr).toContain("9000");
  });
});

describe("the real-engine tests in this file cannot be skipped silently where they are required", () => {
  it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
    const g = engineAvailable(hasPython);
    expect(g.ok, g.reason).toBe(true);
  });
});
