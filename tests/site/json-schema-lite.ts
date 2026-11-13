/**
 * A small JSON Schema checker for the schemas the OpenAPI document carries, so a request example can be checked against the schema of
 * the operation that shows it without adding a dependency. It is not a general validator: it implements the keywords below, and
 * `unsupportedKeywords` names any other validating keyword a schema uses, so a test can fail rather than let a keyword it does not
 * understand pass silently.
 *
 * Supported: type (one name or a list; integer is a number with no fraction), enum, const, required, properties, additionalProperties
 * (false, true or a schema), items (one schema), minItems, maxItems, uniqueItems, minimum, maximum, minLength, maxLength, pattern,
 * oneOf, anyOf, allOf and a local $ref (#/components/schemas/Name, or any #/a/b/c path in the root document).
 * Annotations are ignored on purpose: description, default, title, examples, example, format, deprecated, readOnly, writeOnly.
 */

export const VALIDATING_KEYWORDS = [
  "type", "enum", "const", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems",
  "minimum", "maximum", "minLength", "maxLength", "pattern", "oneOf", "anyOf", "allOf", "$ref",
] as const;

export const ANNOTATION_KEYWORDS = ["description", "default", "title", "examples", "example", "format", "deprecated", "readOnly", "writeOnly"] as const;

type Schema = Record<string, unknown>;

function resolveRef(ref: string, root: unknown): Schema {
  if (!ref.startsWith("#/")) throw new Error(`json-schema-lite: only local $ref is supported, not ${ref}`);
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (cur === null || typeof cur !== "object") throw new Error(`json-schema-lite: ${ref} does not resolve`);
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (cur === undefined) throw new Error(`json-schema-lite: ${ref} does not resolve`);
  return cur as Schema;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isType(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every problem found, each with the path of the value it is about. An empty list means the value satisfies the schema. */
export function validate(schema: Schema, value: unknown, root: unknown = schema, path = "$"): string[] {
  const out: string[] = [];
  if (typeof schema.$ref === "string") return validate(resolveRef(schema.$ref, root), value, root, path);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => isType(value, t))) out.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((e) => same(e, value))) out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && !same(schema.const, value)) out.push(`${path}: expected ${JSON.stringify(schema.const)}`);

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${path}: ${value} is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${path}: ${value} is above ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${path}: items are not unique`);
    if (schema.items && typeof schema.items === "object") value.forEach((v, i) => out.push(...validate(schema.items as Schema, v, root, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) out.push(`${path}: missing required ${r}`);
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) out.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}: ${k} is not allowed (additionalProperties is false)`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...validate(schema.additionalProperties as Schema, v, root, `${path}.${k}`));
    }
  }

  if (Array.isArray(schema.allOf)) for (const s of schema.allOf as Schema[]) out.push(...validate(s, value, root, path));
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as Schema[]).some((s) => validate(s, value, root, path).length === 0)) out.push(`${path}: matches none of anyOf`);
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((s) => validate(s, value, root, path).length === 0).length;
    if (matches !== 1) out.push(`${path}: matches ${matches} of oneOf, expected exactly 1`);
  }
  return out;
}

/** Validating keywords in a schema (following local $ref) that this checker does not implement. */
export function unsupportedKeywords(schema: unknown, root: unknown = schema, seen = new Set<string>(), found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach((s) => unsupportedKeywords(s, root, seen, found));
    return found;
  }
  if (schema === null || typeof schema !== "object") return found;
  const s = schema as Schema;
  if (typeof s.$ref === "string") {
    if (!seen.has(s.$ref)) {
      seen.add(s.$ref);
      unsupportedKeywords(resolveRef(s.$ref, root), root, seen, found);
    }
    return found;
  }
  const known = new Set<string>([...VALIDATING_KEYWORDS, ...ANNOTATION_KEYWORDS]);
  for (const k of Object.keys(s)) if (!known.has(k)) found.add(k);
  if (Array.isArray(s.items)) found.add("items (tuple form)");
  for (const k of ["items", "additionalProperties"]) if (s[k] && typeof s[k] === "object" && !Array.isArray(s[k])) unsupportedKeywords(s[k], root, seen, found);
  for (const k of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(s[k])) unsupportedKeywords(s[k], root, seen, found);
  if (s.properties && typeof s.properties === "object") for (const p of Object.values(s.properties as Record<string, unknown>)) unsupportedKeywords(p, root, seen, found);
  return found;
}
