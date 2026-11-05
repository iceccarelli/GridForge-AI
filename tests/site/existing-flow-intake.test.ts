// The optional "flow the existing hall already draws" field, from the website form to the engine's loader.
// The engine subtracts it from the pumped flow when supplied and changes nothing when absent (tests/test_existing_flow.py proves that side);
// these tests prove the website side sends exactly that and nothing else, and that the engine's own loader accepts what the form builds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { engagementIntakeSchema, screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const ROOT = path.resolve(__dirname, "..", "..");
const FIELD = "thermal.plant.existing_flow_l_per_min";

// A synthetic hall that satisfies the Density Screen's schema.
const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

const plantOf = (doc: unknown) => ((doc as { thermal: { plant: Record<string, unknown> } }).thermal.plant);

describe("the existing-flow field in the intake form schema", () => {
  it("is optional: a hall without it parses, and the document carries no such key", () => {
    const parsed = screenIntakeSchema.safeParse(HALL);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.existingFlowLPerMin).toBeUndefined();
    expect("existing_flow_l_per_min" in plantOf(toIntakeDocument(parsed.data))).toBe(false);
  });

  it("maps to the engine's field name when given, next to the pumped flow it is taken from", () => {
    const parsed = screenIntakeSchema.parse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: 3000 });
    const plant = plantOf(toIntakeDocument(parsed));
    expect(plant.pump_flow_capacity_l_per_min).toBe(9000);
    expect(plant.existing_flow_l_per_min).toBe(3000);
  });

  it("treats zero as a real figure (nothing subtracted), not as absent", () => {
    const parsed = screenIntakeSchema.parse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: 0 });
    expect(parsed.existingFlowLPerMin).toBe(0);
    expect(plantOf(toIntakeDocument(parsed)).existing_flow_l_per_min).toBe(0);
  });

  it("refuses a flow above the pumped flow, naming both numbers, on the field itself", () => {
    const r = screenIntakeSchema.safeParse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: 9500 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.path.join(".") === "existingFlowLPerMin");
    expect(issue?.message).toContain("9500");
    expect(issue?.message).toContain("9000");
  });

  it("accepts a flow equal to the pumped flow (the engine clamps the result at zero racks, it does not refuse)", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: 9000 }).success).toBe(true);
  });

  it("does not compare against a pumped flow nobody gave (the engine applies its own placeholder and says so)", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, existingFlowLPerMin: 3000 }).success).toBe(true);
  });

  it("refuses a negative or non-numeric flow", () => {
    expect(screenIntakeSchema.safeParse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: -1 }).success).toBe(false);
    expect(screenIntakeSchema.safeParse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: "abc" }).success).toBe(false);
  });

  it("applies to the full-intake schema too, and the schemas keep their shape (other code reads .shape)", () => {
    expect("existingFlowLPerMin" in screenIntakeSchema.shape).toBe(true);
    expect("existingFlowLPerMin" in engagementIntakeSchema.shape).toBe(true);
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
      const dir = mkdtempSync(path.join(tmpdir(), "gf-existing-flow-"));
      const file = path.join(dir, "intake.json");
      writeFileSync(file, JSON.stringify(doc));
      const py = "import sys; from gridforge.intake.loader import load; v = load(sys.argv[1]).context.thermal.plant.existing_flow_l_per_min; print('None' if v is None else v.value)";
      const out = spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); ${py}`, file], { encoding: "utf8" });
      expect(out.status, out.stderr).toBe(0);
      return out.stdout.trim();
    };
    const given = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, pumpFlowLPerMin: 9000, existingFlowLPerMin: 3000 }));
    const absent = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, pumpFlowLPerMin: 9000 }));
    expect(Number(read(given))).toBe(3000);
    expect(read(absent)).toBe("None");
  });
});
