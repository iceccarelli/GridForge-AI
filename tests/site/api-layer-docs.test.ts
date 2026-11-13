/**
 * The documentation of the engine's HTTP and MCP layer says what the engine does, on every surface that states it: the OpenAPI document, /developers,
 * /llms.txt, the qualify tool the chat agent mirrors and the honesty file that lists the keys of each answer.
 *
 * What is pinned, and against what: the numbers (the portfolio cap, the qualify minimum) against the engine's own constants; the keys of each answer
 * against the lines of the engine that write them (tests/test_openapi_parity.py runs the real handlers for the same lists); the HTTP and MCP behaviour
 * against the engine's handler source (tests/test_api_http_methods.py and tests/test_api_published_contract.py run the real server). The words are the
 * site's, so what is checked here is that each surface carries the statement and that the statement matches the source.
 */
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import honesty from "@/lib/openapi-honesty.json";
import {
  ERROR_STATUSES,
  MAX_PORTFOLIO_HALLS,
  MCP_ERRORS,
  MCP_ID_STATEMENT,
  buildOpenApi,
  httpMethodsStatement,
  mcpErrorsStatement,
  portfolioCapStatement,
  responseKeysSentence,
  type ToolsFile,
} from "@/lib/openapi";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

const server = fs.readFileSync("gridforge/api/server.py", "utf8");
const metering = fs.readFileSync("gridforge/api/metering.py", "utf8");
const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const flat = (h: string) =>
  h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function developersText(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return flat(renderToStaticMarkup(await (await import("@/app/developers/page")).default()));
  } finally {
    stop();
  }
}

async function llmsText(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return (await (await (await import("@/app/llms.txt/route")).GET()).text()).replace(/\s+/g, " ");
  } finally {
    stop();
  }
}

describe("the qualify rule: at least three of the seven, any three, each omission named", () => {
  const qualify = tools.tools.find((t) => t.name === "gridforge_qualify")!;

  it("is the engine's number, and the engine's published schema carries it with no required list", () => {
    expect(Number(/^QUALIFY_MIN_FIGURES = (\d+)/m.exec(server)![1])).toBe(3);
    expect((qualify.inputSchema as { required?: unknown }).required).toBeUndefined();
    expect(qualify.description).toContain("at least three; each one you leave out is an assumption named in the answer");
    expect((qualify.inputSchema as { description: string }).description).toContain("Send at least three of these seven figures");
  });

  it("is in the 200 description of /v1/qualify with the new keys, and the 422 the engine sends for fewer is described by what it carries", () => {
    const ok = doc.paths["/v1/qualify"].post.responses["200"];
    expect(ok.description).toContain("figures_not_supplied");
    expect(ok.description).toContain("racks_evidence");
    expect(ok.description).toContain("sets_the_date_reason");
    expect(ok.description).toContain("required_at_least");
    expect(ok.description).toContain("minimum_figures");
    expect(ok.description).toContain("figures_sent");
    // the three keys the 422 adds are the ones the engine puts in it
    expect(server).toMatch(/required_at_least=list\(QUALIFY_FIELDS\), minimum_figures=QUALIFY_MIN_FIGURES, figures_sent=sent/);
  });

  it("/developers says it in the qualify card, and /llms.txt in its two engine-facing sentences", async () => {
    const page = await developersText();
    expect(page).toContain("Up to seven numbers about an existing air-cooled hall: send at least three, any three, and each one you leave out is an assumption the answer names");
    expect(page).toContain("figures_not_supplied");
    const llms = await llmsText();
    expect(llms).toContain("Up to seven numbers about a hall go in (at least three; each one left out is an assumption the answer names)");
    expect(llms).toContain("up to seven numbers about a hall in (send at least three, any three; each one you leave out is named in the answer as an assumption, in `figures_not_supplied`)");
  });

  it("the qualify answer's keys the honesty file lists are the keys the engine writes", () => {
    const payloads = fs.readFileSync("gridforge/api/payloads.py", "utf8");
    const spec = honesty.responses["/v1/qualify"];
    expect(spec.top_level).toContain("figures_not_supplied");
    expect(payloads).toMatch(/out\["figures_not_supplied"\] = not_supplied/);
    for (const k of spec.after_relief) expect(payloads + fs.readFileSync("gridforge/envelope/time_to_power.py", "utf8"), k).toContain(k);
    expect(spec.nested.as_found).toEqual(["racks", "racks_evidence"]);
    // each row of figures_not_supplied is field, path, sent, assumed, and sent is "null" or "absent"
    expect(server).toMatch(/rows\.append\(\{"field": name, "path": path, "sent": "null" if name in body else "absent",\s+"assumed": /);
  });
});

describe("the portfolio cap is the engine's, in the schema, the rate card, the estimator and the statement", () => {
  it("one number, defined once in metering.py, read by the honesty file and by the OpenAPI document", () => {
    const cap = Number(/^MAX_PORTFOLIO_HALLS = (\d+)/m.exec(metering)![1]);
    expect(cap).toBe(50);
    expect(honesty.engine_constants.max_portfolio_halls).toBe(cap);
    expect(MAX_PORTFOLIO_HALLS).toBe(cap);
    expect(server).not.toMatch(/^MAX_PORTFOLIO_HALLS = \d+/m);
    const portfolio = tools.tools.find((t) => t.name === "gridforge_portfolio")!;
    expect((portfolio.inputSchema as any).properties.intakes.maxItems).toBe(cap);
    expect((tools.rate_card as any[]).find((r) => r.endpoint === "/v1/portfolio").max_halls_per_request).toBe(cap);
    expect(doc.paths["/v1/portfolio"].post.requestBody.content["application/json"].schema.properties.intakes.maxItems).toBe(cap);
  });

  it("the statement names the 422, the estimator's requests_needed and what a hall that is not ranked looks like", () => {
    const s = portfolioCapStatement();
    expect(s).toContain("at most 50 halls");
    expect(s).toContain("max_halls");
    expect(s).toContain("requests_needed");
    expect(s).toContain("rank null");
    expect(s).toContain("position");
    expect(server).toMatch(/requests_needed=-\(-halls \/\/ MAX_PORTFOLIO_HALLS\)/);
    expect(fs.readFileSync("gridforge/reporting/portfolio.py", "utf8")).toMatch(/"position": i,/);
  });

  it("the estimate operations and the portfolio row of /openapi.json say the same", () => {
    const get = doc.paths["/v1/estimate"].get;
    const hallCount = get.parameters.find((p: any) => p.name === "hall_count");
    expect(hallCount.description).toContain("more than 50 halls is a 422");
    expect(get.responses["422"].description).toContain("requests_needed");
    expect(doc.paths["/v1/portfolio"].post.responses["200"].description).toContain("rank null");
    expect(doc.paths["/v1/portfolio"].post.responses["200"].description).toContain("halls[]: rank, position");
  });

  it("/developers and /llms.txt carry it", async () => {
    expect(await developersText()).toContain(portfolioCapStatement());
    expect(await llmsText()).toContain(`Portfolio over the API: ${portfolioCapStatement()}`);
  });
});

describe("the MCP transport says what the engine does with the message", () => {
  const byCode = (code: number) => MCP_ERRORS.find((e) => e.code === code)!;

  it("-32600: the message must declare jsonrpc 2.0; the engine tests the member, and answers an HTTP 400 to a single bad message", () => {
    expect(byCode(-32600).when).toContain('declares "jsonrpc": "2.0"');
    expect(server).toMatch(/message\.get\("jsonrpc"\) == "2\.0"/);
    expect(doc.paths["/mcp"].post.responses["400"].description).toContain('declaring "jsonrpc": "2.0"');
  });

  it("-32602: tools/call needs a params object and a string name, and the refusal names name and lists the tools", () => {
    const when = byCode(-32602).when;
    expect(when).toContain("tools/call has no params object or no string name");
    expect(when).toContain("data.available");
    expect(when).toContain("allowed");
    expect(when).toContain("max_halls");
    expect(server).toMatch(/if not isinstance\(body\.get\("params"\), dict\):\s+raise RpcError\(-32602, 'tools\/call needs params/);
    expect(server).toMatch(/if not isinstance\(name, str\) or not name:/);
    // the format refusal reaches the caller of a tool as -32602 with the allowed values in data (exc.extra), before the charge
    expect(server).toMatch(/validate_request\(endpoint, args\)[^\n]*\n\s+except ApiError as exc:\s+raise RpcError\(-32602, exc\.message, exc\.extra\)/);
  });

  it('"id": null is a request: the engine decides a notification by the member being absent', () => {
    expect(server).toMatch(/notification = "id" not in body/);
    expect(MCP_ID_STATEMENT).toContain('a message with "id": null is a request, and is answered with id null');
    expect(mcpErrorsStatement()).toContain(MCP_ID_STATEMENT);
    expect(doc.paths["/mcp"].post.description).toContain(MCP_ID_STATEMENT);
    const schema = doc.paths["/mcp"].post.requestBody.content["application/json"].schema.oneOf[0];
    expect(schema.properties.id.description).toContain("null included, is a request");
    expect(schema.properties.jsonrpc.const).toBe("2.0");
  });

  it("/developers and /llms.txt carry the same", async () => {
    const page = await developersText();
    expect(page).toContain(MCP_ID_STATEMENT);
    expect(page).toContain('Every message must declare "jsonrpc": "2.0"');
    const llms = await llmsText();
    expect(llms).toContain(`Every message must declare "jsonrpc": "2.0". ${MCP_ID_STATEMENT}`);
  });
});

describe("HEAD, 405 and Allow, as the engine's handler sends them", () => {
  const statement = httpMethodsStatement();

  it("the allow lists are the ones the engine builds, and every method it adds a handler for is a 405", () => {
    expect(server).toMatch(/return \(\["GET", "HEAD"\] if reads else \[\]\) \+ \(\["POST"\] if posts else \[\]\) \+ \["OPTIONS"\]/);
    expect(server).toMatch(/reads = path in \("\/", "\/health", "\/v1\/estimate"\) or path in GET_ROUTES/);
    expect(server).toMatch(/do_PUT = do_DELETE = do_PATCH = _other_method/);
    expect(server).toMatch(/def do_HEAD\(self\) -> None:[\s\S]{0,400}self\.do_GET\(\)/);
    expect(server).toMatch(/if allow:\s+self\.send_header\("Allow", ", "\.join\(allow\)\)/);
    expect(statement).toContain("POST, OPTIONS on the POST routes and /mcp; GET, HEAD, OPTIONS on the GET routes; GET, HEAD, POST, OPTIONS on /v1/estimate");
  });

  it("the library's own errors are JSON with schema_version, error and status, and no X-GridForge-Schema header", () => {
    const sendError = /def send_error\(self, code, message=None, explain=None\) -> None:([\s\S]*?)\n    def do_GET/.exec(server)![1];
    expect(sendError).toMatch(/\{"schema_version": API_SCHEMA, "error": message or short, "status": code\}/);
    expect(sendError).not.toMatch(/X-GridForge-Schema/);
    expect(statement).toContain("schema_version, error and status in the body, and no X-GridForge-Schema header");
  });

  it("the operator-only route is in no listing the statement points at", () => {
    expect(server).toMatch(/if tier is not Tier\.INTERNAL\]?\)? ?\+ sorted\(GET_ROUTES\)|r, \(_, tier\) in ROUTES\.items\(\) if tier is not Tier\.INTERNAL/);
    expect(statement).toContain("leaves out the one operator-only route, which answers 404 to everyone else");
  });

  it("a figure that is not finite is withheld by the engine as the statement says", () => {
    expect(server).toMatch(/notes = \[f"non-finite figure withheld at \{p\}" for p in paths\]/);
    expect(statement).toContain('"non-finite figure withheld at <path>"');
  });

  it("is in the OpenAPI description, on /developers (with a 405 row among the refusals) and in /llms.txt", async () => {
    expect(doc.info.description).toContain(statement);
    const e405 = ERROR_STATUSES.find((e) => e.status === 405)!;
    expect(e405.meaning).toContain("Allow header");
    expect(doc.paths["/v1/screen"].post.responses.default.description).toContain(`405, ${e405.meaning}`);
    const page = await developersText();
    expect(page).toContain(statement);
    expect(page).toMatch(/405 the method is not one the route takes/);
    expect(await llmsText()).toContain(statement);
  });

  it("states no price", () => {
    for (const text of [statement, portfolioCapStatement(), MCP_ID_STATEMENT, ...ERROR_STATUSES.map((e) => e.meaning)]) expect(text).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
  });
});

describe("the refusals the 422 now carries are described where a caller reads them", () => {
  it("the 422 says the body names the field and the allowed values, and that a format the route cannot render is refused before anything is metered", () => {
    const e422 = ERROR_STATUSES.find((e) => e.status === 422)!;
    expect(e422.meaning).toContain("allowed");
    expect(e422.meaning).toContain("refused before anything is metered");
    expect(server).toMatch(/Runs BEFORE the call is metered/);
  });

  it("the engine's format table is the one the document's inputs enumerate: each route's schema lists exactly the formats the engine allows", () => {
    const table = /ROUTE_FORMATS: dict\[[^\n]*\] = \{([\s\S]*?)\n\}/.exec(server)![1];
    for (const m of table.matchAll(/"(\/v1\/[a-z]+)": \(\(([^)]*)\), "([a-z]+)"\)/g)) {
      const route = m[1];
      const allowed = [...m[2].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
      const tool = tools.tools.find((t) => t.endpoint === route);
      if (!tool) continue; // /v1/deck has no schema: it renders html only
      const format = (tool.inputSchema as any).properties.format;
      expect(format.enum, route).toEqual(allowed);
      expect(format.default, route).toBe(m[3]);
    }
  });
});

describe("the Error schema names the keys the new refusals carry, and the engine writes each of them", () => {
  const props = doc.components.schemas.Error.properties as Record<string, { description?: string }>;
  const written: Record<string, RegExp> = {
    field: /field=name, limit=ceiling/,
    allowed: /allowed=list\(allowed\)/,
    limit: /field=name, limit=ceiling/,
    minimum_figures: /minimum_figures=QUALIFY_MIN_FIGURES/,
    figures_sent: /figures_sent=sent/,
    required_at_least: /required_at_least=list\(QUALIFY_FIELDS\)/,
    missing: /missing=missing\)/,
    max_halls: /max_halls=MAX_PORTFOLIO_HALLS/,
    requests_needed: /requests_needed=-\(-halls \/\/ MAX_PORTFOLIO_HALLS\)/,
    units_per_hall: /units_per_hall=UNIT_COST\[_PORTFOLIO\]/,
    allow: /"allow": allow\}\)/,
    status: /"error": message or short, "status": code/,
  };

  it.each(Object.entries(written))("%s", (key, pattern) => {
    expect(props[key], key).toBeTruthy();
    expect(props[key].description, key).toMatch(/^On /);
    expect(server).toMatch(pattern);
  });
});

describe("the honesty file's nested keys are each written by the engine", () => {
  it.each(Object.entries(honesty.responses).filter(([, spec]) => (spec as { nested?: unknown }).nested))("%s", (path, spec) => {
    const nested = (spec as { nested: Record<string, string[]> }).nested;
    expect(responseKeysSentence(path)).toContain("Keys inside it");
    const engineText = ["gridforge/api/server.py", "gridforge/api/payloads.py", "gridforge/api/compare_payload.py", "gridforge/reporting/portfolio.py", "gridforge/reporting/readiness.py"]
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const [where, keys] of Object.entries(nested)) {
      for (const k of keys) expect(engineText, `${path} ${where}: ${k}`).toContain(`"${k}"`);
    }
  });
});
