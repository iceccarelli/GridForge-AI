// The paid intake reads a typed figure without Number() semantics. z.coerce.number() is Number(value), which reads "", "  ", null, false and [] as 0:
// for a required rating, load or capacity that made "not given" a zero sent to the engine as the client's own figure (POST /api/power/compare with
// contractedMW "" was answered as a confident 0-rack hall: found by the adversarial route suite). A blank string is NOT GIVEN: an optional figure
// stays absent (the engine then names it as an assumption), a required one is refused. A genuine zero still passes.
import { describe, expect, it } from "vitest";
import { num, numOpt, screenIntakeSchema } from "@/lib/engagement-intake";

describe("a required figure", () => {
  const f = num(10);
  it.each(["", "   ", null, undefined, false, true, [], [5], {}, "abc", "1e999", "Infinity", "0x10"])("refuses %j", (bad) => {
    expect(f.safeParse(bad).success).toBe(false);
  });
  it.each([[0, 0], ["0", 0], [" 7.5 ", 7.5], [10, 10], ["1e1", 10]])("reads %j as %j", (v, out) => {
    const r = f.safeParse(v);
    expect(r.success && r.data).toBe(out);
  });
  it("still enforces its own bounds", () => {
    expect(f.safeParse(-1).success).toBe(false);
    expect(f.safeParse(10.01).success).toBe(false);
  });
});

describe("an optional figure", () => {
  const f = numOpt(10);
  it.each(["", "   ", undefined])("treats %j as not given (absent), never as 0", (blank) => {
    const r = f.safeParse(blank);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBeUndefined();
  });
  it.each([null, false, true, [], {}, "abc"])("refuses %j rather than reading it as a number", (bad) => {
    expect(f.safeParse(bad).success).toBe(false);
  });
  it("keeps a genuine zero", () => {
    expect(f.safeParse("0")).toMatchObject({ success: true, data: 0 });
  });
});

describe("the hall schema built from them", () => {
  it("has no field left on Number() coercion", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/engagement-intake.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/z\.coerce\.number/);
    expect(typeof screenIntakeSchema.safeParse).toBe("function");
  });
});
