/**
 * The identity of a cost-evidence run: what is canonical, what changes it and what must not. Pure. Fixtures are
 * SYNTHETIC.
 */
import { describe, expect, it } from "vitest";
import { RUN_IDENTITY_VERSION, canonical, digestOf, runFingerprint, sortSnapshot } from "@/lib/run-identity";

const D = (c: string) => c.repeat(64);
const base = { deliverable_id: "11111111-1111-4111-8111-111111111111", intake_digest: D("a"), accepted_snapshot_digest: D("b"), engine_fingerprint: D("c") };

describe("canonical form", () => {
  it("does not depend on object key order, at any depth", () => {
    expect(digestOf({ a: 1, b: { x: [1, 2], y: "z" } })).toBe(digestOf({ b: { y: "z", x: [1, 2] }, a: 1 }));
  });
  it("keeps array order (a list is not a set unless the caller says so)", () => {
    expect(digestOf({ a: [1, 2] })).not.toBe(digestOf({ a: [2, 1] }));
  });
  it("distinguishes values that merely print alike", () => {
    expect(digestOf({ a: "1" })).not.toBe(digestOf({ a: 1 }));
    expect(digestOf({ a: null })).not.toBe(digestOf({ a: "null" }));
  });
  it("omits undefined members and refuses a number that has no canonical form", () => {
    expect(canonical({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonical({ a: NaN })).toThrow();
    expect(() => canonical({ a: Infinity })).toThrow();
  });
});

describe("the run fingerprint", () => {
  it("is deterministic and versioned", () => {
    expect(runFingerprint(base)).toBe(runFingerprint({ ...base }));
    expect(runFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(RUN_IDENTITY_VERSION).toBe("gridforge/cost-evidence-run/1");
  });
  it.each(["deliverable_id", "intake_digest", "accepted_snapshot_digest", "engine_fingerprint"] as const)("changes with %s", (k) => {
    const other = k === "deliverable_id" ? "22222222-2222-4222-8222-222222222222" : D("f");
    expect(runFingerprint({ ...base, [k]: other })).not.toBe(runFingerprint(base));
  });
  it("is not the digest of its parts concatenated (the field names are part of the identity)", () => {
    expect(runFingerprint(base)).not.toBe(digestOf([base.deliverable_id, base.intake_digest, base.accepted_snapshot_digest, base.engine_fingerprint]));
  });
});

describe("the accepted snapshot is a set", () => {
  it("has one byte form whatever order the lines arrive in", () => {
    const a = { evidence_id: "00000000-0000-4000-8000-000000000002", value: 2 };
    const b = { evidence_id: "00000000-0000-4000-8000-000000000001", value: 1 };
    expect(digestOf(sortSnapshot([a, b]))).toBe(digestOf(sortSnapshot([b, a])));
  });
  it("changes when a material input of any line changes, or when a line is added", () => {
    const line = { evidence_id: "00000000-0000-4000-8000-000000000001", value: 1, basis: "firm_quote" };
    const d0 = digestOf(sortSnapshot([line]));
    expect(digestOf(sortSnapshot([{ ...line, value: 2 }]))).not.toBe(d0);
    expect(digestOf(sortSnapshot([{ ...line, basis: "contracted" }]))).not.toBe(d0);
    expect(digestOf(sortSnapshot([line, { ...line, evidence_id: "00000000-0000-4000-8000-000000000002" }]))).not.toBe(d0);
  });
});
