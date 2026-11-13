// The request examples /openapi.json carries (lib/openapi-examples.json), resolved into the plain JSON bodies they stand for.
//
// An example is built from a file the repository already ships and labels synthetic, never retyped: a value of the form
// {"$from": "<repository path>" | "#bases/<name>", "$set": {"<dotted path>": <value>}} is that file with the named fields replaced.
// tests/test_api_published_contract.py resolves the same markers in Python and sends every example to the real engine;
// tests/site/openapi-examples.test.ts checks every resolved example against the schema of the operation that carries it.

import examples from "@/lib/openapi-examples.json";
import dublinHall from "@/examples/intake/dublin_hall.json";
import referenceHall from "@/examples/intake/reference_hall.json";
import qualifyRequest from "@/public/reference/examples/qualify-request.json";
import responseTemplate from "@/public/reference/response_template.json";

/** Every repository file an example may be built from, by the path the examples file names. A path not listed here is refused. */
const FILES: Record<string, unknown> = {
  "examples/intake/dublin_hall.json": dublinHall,
  "examples/intake/reference_hall.json": referenceHall,
  "public/reference/examples/qualify-request.json": qualifyRequest,
  "public/reference/response_template.json": responseTemplate,
};

export const EXAMPLE_SOURCE_FILES: string[] = Object.keys(FILES);

const BASES = examples.bases as Record<string, unknown>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setPath(target: unknown, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = target as Record<string, unknown>;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (next === undefined) cur[p] = {};
    else if (next === null || typeof next !== "object" || Array.isArray(next)) throw new Error(`openapi example: ${dotted} passes through ${p}, which is not an object`);
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Replace every {"$from", "$set"} marker in `node` with the file (or base) it names, edited as `$set` says. */
export function resolveExample(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveExample);
  if (node === null || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  if ("$from" in o) {
    const { $from, $set, ...rest } = o;
    if (Object.keys(rest).length) throw new Error(`openapi example: a $from marker carries only $from and $set, not ${Object.keys(rest).join(", ")}`);
    if (typeof $from !== "string") throw new Error("openapi example: $from must be a path");
    const source = $from.startsWith("#bases/") ? BASES[$from.slice("#bases/".length)] : FILES[$from];
    if (source === undefined) throw new Error(`openapi example: ${$from} is not a source file or base the examples may use`);
    const out = clone(source);
    for (const [path, value] of Object.entries(($set ?? {}) as Record<string, unknown>)) setPath(out, path, clone(value));
    return out;
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveExample(v)]));
}

export interface RequestExample {
  summary: string;
  value: unknown;
}

const REQUESTS = examples.requests as Record<string, Record<string, { summary: string; value: unknown }>>;

/** The paths (as in the document) that have request examples. */
export const EXAMPLE_ENDPOINTS: string[] = Object.keys(REQUESTS);

/** The named request examples for one path, resolved, in the shape of an OpenAPI Media Type Object's `examples`; undefined when it has none. */
export function requestExamplesFor(path: string): Record<string, RequestExample> | undefined {
  const raw = REQUESTS[path];
  if (!raw) return undefined;
  return Object.fromEntries(Object.entries(raw).map(([name, e]) => [name, { summary: e.summary, value: resolveExample(e.value) }]));
}
