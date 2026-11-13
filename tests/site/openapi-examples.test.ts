/**
 * /openapi.json can be onboarded from: every POST operation carries request examples built from inputs the repository ships, every example
 * is valid against the schema of the operation that shows it, and every engine operation names the top-level keys its answer has.
 *
 * The Python half, tests/test_api_published_contract.py, sends every example to the real engine and fails if one is refused or if a
 * route does not return a key named here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import examplesFile from "@/lib/openapi-examples.json";
import honesty from "@/lib/openapi-honesty.json";
import { buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { EXAMPLE_ENDPOINTS, EXAMPLE_SOURCE_FILES, requestExamplesFor, resolveExample } from "@/lib/openapi-examples";
import { unsupportedKeywords, validate } from "./json-schema-lite";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;

const ENGINE_POST_PATHS = Object.keys(doc.paths).filter((p) => !p.startsWith("/api/") && doc.paths[p].post);
const postOf = (path: string) => doc.paths[path].post;
const jsonContent = (path: string) => postOf(path).requestBody.content["application/json"];

describe("every POST operation has request examples", () => {
  it("covers exactly the engine's POST operations", () => {
    expect([...EXAMPLE_ENDPOINTS].sort()).toEqual([...ENGINE_POST_PATHS].sort());
    // sixteen: the fourteen tools, the deck and the MCP transport
    expect(ENGINE_POST_PATHS).toHaveLength(tools.tools.length + 2);
  });

  it.each(ENGINE_POST_PATHS)("%s: at least one named example, each with a summary and a body", (path) => {
    const examples = jsonContent(path).examples as Record<string, { summary: string; value: unknown }>;
    expect(examples, path).toBeTruthy();
    expect(Object.keys(examples).length, path).toBeGreaterThan(0);
    for (const [name, e] of Object.entries(examples)) {
      expect(e.summary.length, `${path} ${name}`).toBeGreaterThan(20);
      expect(typeof e.value, `${path} ${name}`).toBe("object");
      expect(JSON.stringify(e.value), `${path} ${name}: an unresolved $from marker`).not.toContain("$from");
      expect(JSON.stringify(e.value), `${path} ${name}: an unresolved $set marker`).not.toContain("$set");
    }
  });
});

describe("every request example validates against the schema of its operation", () => {
  it("the checker understands every keyword those schemas use", () => {
    for (const path of ENGINE_POST_PATHS) {
      expect([...unsupportedKeywords(jsonContent(path).schema, doc)], path).toEqual([]);
    }
  });

  for (const path of ENGINE_POST_PATHS) {
    it(`${path}`, () => {
      const { schema, examples } = jsonContent(path);
      for (const [name, e] of Object.entries<any>(examples)) {
        expect(validate(schema, e.value, doc), `${path} (${name})`).toEqual([]);
      }
    });
  }

  it("a checker that would accept anything is not what passed: a broken example is refused by the same schema", () => {
    const qualify = jsonContent("/v1/qualify").schema;
    const plain = requestExamplesFor("/v1/qualify")!.plain.value as Record<string, unknown>;
    expect(validate(qualify, plain, doc)).toEqual([]);
    expect(validate(qualify, { ...plain, assumed_fields: ["no_such_figure"] }, doc).join()).toContain("is not one of");
    expect(validate(qualify, { ...plain, assumed_fields: ["tapoff_max_A", "tapoff_max_A"] }, doc).join()).toContain("not unique");
    expect(validate(qualify, { ...plain, platform: "vr200" }, doc).join()).toContain("is not one of");
    expect(validate(qualify, { ...plain, not_a_field: 1 }, doc).join()).toContain("not_a_field is not allowed");
    const { tapoff_max_A, ...thin } = plain;
    void tapoff_max_A;
    // No figure is required: the engine publishes no `required` list for the qualifier and answers on any three of the seven (it names the ones it
    // assumed), so leaving one out is not a schema error; a figure of the wrong type still is.
    expect(qualify.required).toBeUndefined();
    expect(validate(qualify, thin, doc)).toEqual([]);
    expect(validate(qualify, { ...plain, tapoff_max_A: "63" }, doc).join()).toContain("expected number");
    expect(validate(jsonContent("/v1/portfolio").schema, { intakes: [] }, doc).join()).toContain("fewer than 1");
    expect(validate(jsonContent("/v1/estimate").schema, { endpoint: "/v1/portfolio", hall_count: 0 }, doc).join()).toContain("below 1");
    expect(validate(jsonContent("/mcp").schema, { jsonrpc: "2.0", id: 1 }, doc).join()).toContain("matches 0 of oneOf");
  });
});

describe("the examples are the repository's own inputs, not retyped copies", () => {
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

  it("every file an example is built from ships in the repository and is the one the resolver reads", () => {
    const named = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (typeof o.$from === "string" && !o.$from.startsWith("#bases/")) named.add(o.$from);
        Object.values(o).forEach(walk);
      }
    };
    walk(examplesFile.requests);
    expect([...named].sort()).toEqual([...EXAMPLE_SOURCE_FILES].sort().filter((f) => named.has(f)));
    for (const f of named) expect(() => readFileSync(f, "utf8"), f).not.toThrow();
    expect(EXAMPLE_SOURCE_FILES.every((f) => named.has(f))).toBe(true);
  });

  it("a plain $from is the file, byte for byte as data", () => {
    expect(requestExamplesFor("/v1/qualify")!.plain.value).toEqual(read("public/reference/examples/qualify-request.json"));
    const screen = requestExamplesFor("/v1/screen")!.reference_hall.value as { intake: unknown };
    expect(screen.intake).toEqual(read("examples/intake/reference_hall.json"));
  });

  it("$set replaces the named field and leaves the rest of the file alone", () => {
    const diff = requestExamplesFor("/v1/diff")!.contracted_capacity_raised.value as { before: any; after: any };
    const dublin = read("examples/intake/dublin_hall.json");
    expect(diff.before).toEqual(dublin);
    expect(diff.after.grid.contracted_MW).toBe(12);
    expect(dublin.grid.contracted_MW).toBe(10);
    expect({ ...diff.after, grid: { ...diff.after.grid, contracted_MW: 10 } }).toEqual(dublin);
    const bid = (requestExamplesFor("/v1/bids")!.one_response.value as { responses: any[] }).responses[0];
    const template = read("public/reference/response_template.json");
    expect(bid.supplier).toBe("Synthetic Supplier A");
    expect(bid.specification.constraint).toBe(template.specification.constraint);
    expect(Object.keys(bid.compliance).sort()).toEqual(Object.keys(template.compliance).sort());
    expect(Object.keys(bid.values).sort()).toEqual(Object.keys(template.values).sort());
  });

  it("the three-figure qualify example is three of the shipped request's seven figures, unchanged, and no more", () => {
    const full = read("public/reference/examples/qualify-request.json");
    const three = requestExamplesFor("/v1/qualify")!.three_figures.value as Record<string, unknown>;
    expect(three).toEqual({ contracted_MW: full.contracted_MW, current_site_peak_MW: full.current_site_peak_MW, busway_ampacity_A: full.busway_ampacity_A });
    expect(Object.keys(three)).toHaveLength(3);
  });

  it("the resolver refuses a source it was not given, a marker with extra keys, and a path through a non-object", () => {
    expect(() => resolveExample({ $from: "package.json" })).toThrow(/not a source file/);
    expect(() => resolveExample({ $from: "#bases/nope" })).toThrow(/not a source file/);
    expect(() => resolveExample({ $from: "examples/intake/dublin_hall.json", extra: 1 })).toThrow(/only \$from and \$set/);
    expect(() => resolveExample({ $from: "examples/intake/dublin_hall.json", $set: { "grid.contracted_MW.x": 1 } })).toThrow(/not an object/);
  });

  it("the halls named in the examples are labelled synthetic", () => {
    for (const f of ["dublin_hall", "london_hall", "reference_hall"]) {
      expect(JSON.stringify(read(`examples/intake/${f}.json`)).toLowerCase(), f).toContain("synthetic");
    }
    expect(examplesFile.note).toContain("synthetic");
  });

  it("states no price (the document states none)", () => {
    // The example supplier bids carry `"currency":"EUR"`: a bid names the currency its price is in, and one without is disqualified. That
    // is a currency CODE in an invented example, not a price. Exactly that property is exempt; the original pattern applies to everything else.
    const text = JSON.stringify(doc).replace(/"currency":"EUR"/g, '"currency":"<code>"');
    expect(text).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
  });
  it("the only place the document says EUR is the currency code of an example bid", () => {
    const hits = JSON.stringify(doc).match(/.{24}\bEUR\b.{12}/gi) ?? [];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h).toContain('"currency":"EUR"');
  });
});

describe("every engine operation names the top-level keys of its answer", () => {
  const enginePaths = ENGINE_POST_PATHS.filter((p) => p !== "/mcp");

  it("none of the fifteen answers is a bare {type: object}", () => {
    expect(enginePaths).toHaveLength(tools.tools.length + 1);
    for (const path of enginePaths) {
      const schema = postOf(path).responses["200"].content["application/json"].schema;
      expect(Object.keys(schema.properties ?? {}).length, path).toBeGreaterThan(2);
    }
  });

  it.each(enginePaths)("%s: the 200 description and schema carry the keys lib/openapi-honesty.json lists, plus schema_version", (path) => {
    const spec = (honesty.responses as Record<string, { top_level: string[]; additive_top_level?: string[]; when?: string }>)[path];
    expect(spec, path).toBeTruthy();
    const ok = postOf(path).responses["200"];
    const schema = ok.content["application/json"].schema;
    for (const key of [...spec.top_level, ...(spec.additive_top_level ?? [])]) {
      expect(ok.description, `${path}: ${key} in the description`).toContain(key);
      expect(Object.keys(schema.properties), `${path}: ${key} in the schema`).toContain(key);
    }
    expect(Object.keys(schema.properties)).toContain("schema_version");
    expect(schema.properties.schema_version.const).toBe("gridforge/api/1");
    if (spec.when) expect(ok.description).toContain(spec.when);
    expect(ok.headers["X-GridForge-Schema"]).toBeTruthy();
  });

  it.each(enginePaths)("%s: the keys inside the answer that lib/openapi-honesty.json lists are in the 200 description", (path) => {
    const spec = (honesty.responses as Record<string, { nested?: Record<string, string[]>; after_relief?: string[] }>)[path];
    const ok = postOf(path).responses["200"];
    for (const [where, keys] of Object.entries(spec.nested ?? {})) {
      expect(ok.description, `${path}: ${where}`).toContain(`${where}: ${keys.join(", ")}`);
    }
    if (spec.after_relief) expect(ok.description, `${path}: after_relief`).toContain(`after_relief: ${spec.after_relief.join(", ")}`);
  });

  it("the qualifier's answer schema types the keys the engine sends for the date, the racks and the figures it did not get", () => {
    const schema = postOf("/v1/qualify").responses["200"].content["application/json"].schema;
    const afterRelief = schema.properties.after_relief.properties;
    expect(Object.keys(afterRelief)).toEqual(honesty.responses["/v1/qualify"].after_relief);
    // sets_the_date is null when there is no date, and sets_the_date_reason says why: neither is a required string.
    expect(afterRelief.sets_the_date.type).toEqual(["string", "null"]);
    expect(afterRelief.sets_the_date_reason.type).toEqual(["string", "null"]);
    expect(afterRelief.racks_evidence.type).toBe("string");
    expect(afterRelief.date_label.description).toContain("no date: nothing is deployable in this scenario");
    expect(afterRelief.date_label.description).toContain("no date: a lead time on the path is missing");
    expect(Object.keys(schema.properties.as_found.properties)).toEqual(["racks", "racks_evidence"]);
    const rows = schema.properties.figures_not_supplied;
    expect(rows.type).toBe("array");
    expect(Object.keys(rows.items.properties)).toEqual(["field", "path", "sent", "assumed"]);
    expect(rows.items.properties.sent.enum).toEqual(["null", "absent"]);
  });

  it("the deck's hand-built schema has exactly the keys the engine's list gives", () => {
    const schema = postOf("/v1/deck").responses["200"].content["application/json"].schema;
    expect(Object.keys(schema.properties).sort()).toEqual([...honesty.responses["/v1/deck"].top_level, ...((honesty.responses["/v1/deck"] as { additive_top_level?: string[] }).additive_top_level ?? []), "schema_version"].sort());
  });

  it("each operation's description carries its evidence boundary, and the deck's carries its own", () => {
    for (const t of tools.tools) {
      expect(t.evidence_boundary, t.name).toBeTruthy();
      expect(postOf(t.endpoint).description, t.name).toContain(`Evidence boundary: ${t.evidence_boundary}`);
      expect(postOf(t.endpoint)["x-gridforge-evidence-boundary"], t.name).toBe(t.evidence_boundary);
    }
    expect(postOf("/v1/deck")["x-gridforge-evidence-boundary"]).toMatch(/not an issued engineering opinion/);
  });
});
