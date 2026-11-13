/**
 * The schema checker the request-example tests rely on must itself reject what it should: a checker that accepts everything would make
 * "every example validates" mean nothing. Each keyword it supports has a case that passes and a case that fails.
 */
import { describe, expect, it } from "vitest";
import { unsupportedKeywords, validate } from "./json-schema-lite";

const ok = (schema: Record<string, unknown>, value: unknown, root?: unknown) => expect(validate(schema, value, root)).toEqual([]);
const bad = (schema: Record<string, unknown>, value: unknown, fragment: string, root?: unknown) => {
  const issues = validate(schema, value, root);
  expect(issues.length, JSON.stringify(value)).toBeGreaterThan(0);
  expect(issues.join("\n")).toContain(fragment);
};

describe("json-schema-lite", () => {
  it("type, including a list of types, integer and null", () => {
    ok({ type: "string" }, "x");
    bad({ type: "string" }, 1, "expected string");
    ok({ type: ["string", "null"] }, null);
    bad({ type: ["string", "null"] }, 1, "string or null");
    ok({ type: "integer" }, 3);
    bad({ type: "integer" }, 3.5, "expected integer");
    ok({ type: "number" }, 3.5);
    bad({ type: "number" }, "3", "expected number");
    bad({ type: "number" }, Number.NaN, "expected number");
    ok({ type: "boolean" }, false);
    bad({ type: "object" }, [], "expected object");
    bad({ type: "array" }, {}, "expected array");
  });

  it("enum and const", () => {
    ok({ enum: ["a", "b"] }, "a");
    bad({ enum: ["a", "b"] }, "c", "is not one of");
    ok({ enum: [{ x: 1 }] }, { x: 1 });
    ok({ const: "2.0" }, "2.0");
    bad({ const: "2.0" }, "1.0", "expected");
  });

  it("required, properties and additionalProperties", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "number" }, b: { type: "string" } }, additionalProperties: false };
    ok(schema, { a: 1, b: "x" });
    bad(schema, { b: "x" }, "missing required a");
    bad(schema, { a: "1" }, "$.a: expected number");
    bad(schema, { a: 1, c: 2 }, "c is not allowed");
    ok({ type: "object", properties: { a: {} } }, { a: 1, anything: 2 });
    ok({ type: "object", additionalProperties: { type: "string" } }, { x: "y" });
    bad({ type: "object", additionalProperties: { type: "string" } }, { x: 1 }, "$.x: expected string");
  });

  it("items, minItems, maxItems and uniqueItems", () => {
    const schema = { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2, uniqueItems: true };
    ok(schema, ["a", "b"]);
    bad(schema, [], "fewer than 1");
    bad(schema, ["a", "b", "c"], "more than 2");
    bad(schema, ["a", "a"], "not unique");
    bad(schema, ["z"], "$[0]");
  });

  it("minimum, maximum, minLength, maxLength and pattern", () => {
    ok({ type: "number", minimum: 1, maximum: 3 }, 2);
    bad({ type: "number", minimum: 1 }, 0, "below 1");
    bad({ type: "number", maximum: 3 }, 4, "above 3");
    ok({ type: "string", minLength: 2, maxLength: 3 }, "ab");
    bad({ type: "string", minLength: 2 }, "a", "shorter");
    bad({ type: "string", maxLength: 2 }, "abc", "longer");
    ok({ type: "string", pattern: "^[A-Z]{2}$" }, "IE");
    bad({ type: "string", pattern: "^[A-Z]{2}$" }, "ie", "does not match");
  });

  it("oneOf, anyOf and allOf", () => {
    const one = { oneOf: [{ type: "object", required: ["method"] }, { type: "array" }] };
    ok(one, { method: "x" });
    ok(one, []);
    bad(one, {}, "matches 0 of oneOf");
    bad({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3, "matches 2 of oneOf");
    ok({ anyOf: [{ type: "string" }, { type: "number" }] }, 1);
    bad({ anyOf: [{ type: "string" }, { type: "number" }] }, true, "none of anyOf");
    ok({ allOf: [{ type: "object" }, { required: ["a"] }] }, { a: 1 });
    bad({ allOf: [{ type: "object" }, { required: ["a"] }] }, {}, "missing required a");
  });

  it("a local $ref, and a ref that does not resolve is an error rather than a pass", () => {
    const root = { components: { schemas: { Str: { type: "string" } } } };
    ok({ $ref: "#/components/schemas/Str" }, "x", root);
    bad({ $ref: "#/components/schemas/Str" }, 1, "expected string", root);
    expect(() => validate({ $ref: "#/components/schemas/Nope" }, "x", root)).toThrow(/does not resolve/);
    expect(() => validate({ $ref: "https://example.com/s.json" }, "x", root)).toThrow(/only local/);
  });

  it("names a validating keyword it does not implement, and ignores annotations", () => {
    expect([...unsupportedKeywords({ type: "object", description: "x", properties: { a: { type: "string", format: "email", default: "a" } } })]).toEqual([]);
    expect([...unsupportedKeywords({ type: "object", properties: { a: { type: "string", multipleOf: 2, dependentRequired: {} } } })].sort()).toEqual(["dependentRequired", "multipleOf"]);
    expect([...unsupportedKeywords({ type: "array", items: [{ type: "string" }] })]).toEqual(["items (tuple form)"]);
    const root = { components: { schemas: { A: { type: "string", contains: {} } } } };
    expect([...unsupportedKeywords({ $ref: "#/components/schemas/A" }, root)]).toEqual(["contains"]);
  });
});
