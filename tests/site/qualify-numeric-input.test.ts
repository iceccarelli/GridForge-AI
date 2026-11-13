/**
 * A figure the visitor did not give is not zero.
 *
 * lib/qualify.ts read every number with z.coerce.number(), which is Number(value): null, "", "   ", false and [] parsed as 0, so a request with
 * `positionsAvailable: null` was a request for ZERO free rack positions (the engine then answers "0 racks"), and toEngineBody sent
 * positions_available = 0 for a figure never sent. The same held for every numeric field of the schema whose bounds admit zero (peak, IT load, plant
 * supply), and `true` / `[12]` read as 1 / 12 in the others.
 *
 * Now a figure is read only if it is a number or a decimal numeric string. A genuine 0 and "0" still pass where zero is a real answer, and the paid
 * Screen intake accepts the zero the free read carries into it (intakePrefill), keeping its other bounds.
 */
import { describe, expect, it } from "vitest";
import { intakePrefill, qualifySchema, toEngineBody, type StoredQualification } from "@/lib/qualify";
import { screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { typedNumberInput } from "@/lib/qualify-number";

const SEVEN = { contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180 };
const FIELDS = Object.keys(SEVEN) as (keyof typeof SEVEN)[];

/** What Number() reads as a number and a person never typed as one. */
const NOT_A_FIGURE: [string, unknown][] = [
  ["null", null],
  ["the empty string", ""],
  ["spaces", "   "],
  ["a tab and a newline", "\t\n"],
  ["false", false],
  ["true", true],
  ["an empty array", []],
  ["an array holding a number", [5]],
  ["an array holding a numeric string", ["12"]],
  ["an object", {}],
  ["a bare word", "abc"],
  ["a hex string", "0x10"],
  ["Infinity as text", "Infinity"],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["undefined", undefined],
];

describe("every numeric field of the free qualifier refuses what is not a figure", () => {
  for (const field of FIELDS) {
    for (const [what, value] of NOT_A_FIGURE) {
      it(`${field}: ${what} is refused`, () => {
        const r = qualifySchema.safeParse({ ...SEVEN, [field]: value });
        expect(r.success, `${field} = ${JSON.stringify(value)} was accepted`).toBe(false);
        if (!r.success) expect(r.error.issues.some((i) => i.path[0] === field), "the refusal names the field").toBe(true);
      });
    }
  }

  it("a field that is missing altogether is refused, so toEngineBody never sends a figure that was never sent", () => {
    for (const field of FIELDS) {
      const { [field]: _omitted, ...rest } = SEVEN;
      expect(qualifySchema.safeParse(rest).success, `${field} omitted`).toBe(false);
    }
  });
});

describe("a real number, or a numeric string, still passes", () => {
  it("numbers, decimal strings with spaces, signs, fractions and exponents", () => {
    for (const v of [12, "12", " 12 ", "12.5", ".5", "5.", "+7", "1e1"]) {
      const r = qualifySchema.safeParse({ ...SEVEN, contractedMW: v });
      expect(r.success, String(v)).toBe(true);
    }
    expect(qualifySchema.parse({ ...SEVEN, contractedMW: " 12.5 " }).contractedMW).toBe(12.5);
    expect(qualifySchema.parse({ ...SEVEN, plantSupplyC: "-3" }).plantSupplyC).toBe(-3);
  });

  it("zero is a real answer where the bounds admit it: positions, peak, IT load, a 0 degC plant supply", () => {
    for (const field of ["positionsAvailable", "currentPeakMW", "currentItLoadMW", "plantSupplyC"] as const) {
      for (const zero of [0, "0", " 0 ", "0.0"]) {
        const r = qualifySchema.safeParse({ ...SEVEN, [field]: zero });
        expect(r.success, `${field} = ${JSON.stringify(zero)}`).toBe(true);
        if (r.success) expect(r.data[field]).toBe(0);
      }
    }
    expect(toEngineBody(qualifySchema.parse({ ...SEVEN, positionsAvailable: 0 })).positions_available).toBe(0);
    expect(toEngineBody(qualifySchema.parse({ ...SEVEN, positionsAvailable: "0" })).positions_available).toBe(0);
  });

  it("the bounds are unchanged", () => {
    for (const bad of [-1, 1.5, 20001, "-1", "1.5", "20001"]) expect(qualifySchema.safeParse({ ...SEVEN, positionsAvailable: bad }).success, String(bad)).toBe(false);
    expect(qualifySchema.safeParse({ ...SEVEN, contractedMW: 0 }).success).toBe(false); // positive
    expect(qualifySchema.safeParse({ ...SEVEN, contractedMW: 2001 }).success).toBe(false);
    expect(qualifySchema.safeParse({ ...SEVEN, plantSupplyC: 46 }).success).toBe(false);
    expect(qualifySchema.safeParse({ ...SEVEN, plantSupplyC: -6 }).success).toBe(false);
    expect(qualifySchema.safeParse({ ...SEVEN, buswayAmpacityA: 0 }).success).toBe(false);
    expect(qualifySchema.safeParse({ ...SEVEN, tapoffMaxA: 1601 }).success).toBe(false);
  });

  it("the reading rule itself", () => {
    expect(typedNumberInput("12")).toBe(12);
    expect(typedNumberInput("")).toBe("");
    expect(typedNumberInput(null)).toBe(null);
    expect(typedNumberInput(false)).toBe(false);
    const arr: unknown[] = [];
    expect(typedNumberInput(arr)).toBe(arr);
  });
});

describe("the zero the free read carries into the paid Screen intake is accepted there", () => {
  const stored = (inputs: Record<string, unknown>): StoredQualification =>
    ({ id: "q1", created_at: "2026-11-13T10:00:00Z", token: "t", inputs, racks_as_found: 0, racks_after_relief: 0, binding_constraint: "x", intake_completeness: 0.5, status: "scored" }) as unknown as StoredQualification;
  const HALL = { siteName: "North Hall", hallId: "H1", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6 };

  it("intakePrefill carries '0' for zero free positions, and the Screen intake accepts it", () => {
    const pre = intakePrefill(stored({ ...SEVEN, positionsAvailable: 0, siteName: "North Hall", hallId: "H1" }));
    expect(pre.positionsAvailable).toBe("0");
    const r = screenIntakeSchema.safeParse({ ...HALL, ...pre });
    expect(r.success, JSON.stringify(r.success ? "" : r.error.issues)).toBe(true);
    if (r.success) expect(r.data.positionsAvailable).toBe(0);
  });

  it("zero free positions is accepted as 0 and '0'; the other bounds stay (a fraction, a negative, over 20000)", () => {
    for (const ok of [0, "0", 1, "180", 20000]) expect(screenIntakeSchema.safeParse({ ...HALL, positionsAvailable: ok }).success, String(ok)).toBe(true);
    for (const bad of [-1, "-1", 1.5, 20001]) expect(screenIntakeSchema.safeParse({ ...HALL, positionsAvailable: bad }).success, String(bad)).toBe(false);
  });

  it("a required figure left blank is NOT zero in the paid intake either: null, '', spaces, false and [] are refused", () => {
    for (const [what, v] of NOT_A_FIGURE) {
      expect(screenIntakeSchema.safeParse({ ...HALL, positionsAvailable: v }).success, `positionsAvailable: ${what}`).toBe(false);
    }
  });

  it("zero free positions with no total is sent without a total (the engine names its own default), not as a hall of zero positions", () => {
    const doc = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, positionsAvailable: 0 })) as { hall: Record<string, unknown> };
    expect(doc.hall.positions_available).toBe(0);
    expect(doc.hall).not.toHaveProperty("rack_positions");
    // A declared total is still sent as declared, and a non-zero free count still stands in for a missing total as before.
    const withTotal = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, positionsAvailable: 0, rackPositions: 120 })) as { hall: Record<string, unknown> };
    expect(withTotal.hall.rack_positions).toBe(120);
    const some = toIntakeDocument(screenIntakeSchema.parse({ ...HALL, positionsAvailable: 40 })) as { hall: Record<string, unknown> };
    expect(some.hall.rack_positions).toBe(40);
  });
});
