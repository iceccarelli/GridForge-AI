/**
 * What /openapi.json and /developers say about retries, errors, MCP codes, browsers and the response version is what the engine sends.
 * The facts are in lib/openapi-honesty.json and are proved against the real server by tests/test_api_published_contract.py; this file checks
 * that the documents state them, completely and without promising more.
 */
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import honesty from "@/lib/openapi-honesty.json";
import {
  CORS_POLICY,
  ERROR_STATUSES,
  LEDGER_RETRY_AFTER_SECONDS,
  MCP_ERRORS,
  SHED_RETRY_AFTER_SECONDS,
  buildOpenApi,
  corsStatement,
  failureStatuses,
  mcpCodesFor,
  mcpErrorsStatement,
  retryStatement,
  schemaVersionStatement,
  type ToolsFile,
} from "@/lib/openapi";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;
const post = (path: string) => doc.paths[path].post;

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function developersHtml(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("503 and Retry-After", () => {
  it("the Error schema carries every field a refusal can hold, including retry_after_seconds and what it is not on", () => {
    const props = doc.components.schemas.Error.properties;
    for (const f of ["retryable", "retry_after_seconds", "limit_per_minute", "request_id", "reason", "resets_at", "plan", "unit_price_cents"]) expect(props[f], f).toBeTruthy();
    expect(props.retry_after_seconds.description).toMatch(/Only on the 503 that says the engine is busy/);
    expect(props.retry_after_seconds.description).toMatch(/usage that could not be recorded carries the header and not this field/);
    expect(props.retryable.description).toMatch(/not configured/);
  });

  it("every solving or metered operation declares a 503 with a Retry-After header; the estimator, which cannot be shed, does not", () => {
    for (const t of tools.tools) {
      const op = post(t.endpoint);
      const solving = (honesty.solving_routes as string[]).includes(t.endpoint);
      if (solving || t.units > 0) {
        const r = op.responses["503"];
        expect(r, t.name).toBeTruthy();
        expect(r.headers["Retry-After"].schema.type, t.name).toBe("integer");
        expect(r.description, t.name).toContain("not charged");
      } else {
        expect(op.responses["503"], t.name).toBeUndefined();
      }
    }
    expect(post("/v1/deck").responses["503"].headers["Retry-After"]).toBeTruthy();
  });

  it("a metered 503 names all three causes with the engine's seconds; the free qualifier names only the busy one", () => {
    const metered: string = post("/v1/screen").responses["503"].description;
    expect(metered).toContain(`Retry-After: ${SHED_RETRY_AFTER_SECONDS}`);
    expect(metered).toContain(`Retry-After: ${LEDGER_RETRY_AFTER_SECONDS}`);
    expect(metered).toMatch(/No Retry-After header, and a retry will not help/);
    const free: string = post("/v1/qualify").responses["503"].description;
    expect(free).toContain(`Retry-After: ${SHED_RETRY_AFTER_SECONDS}`);
    expect(free).not.toContain(`Retry-After: ${LEDGER_RETRY_AFTER_SECONDS}`);
    expect([SHED_RETRY_AFTER_SECONDS, LEDGER_RETRY_AFTER_SECONDS]).toEqual([2, 30]);
  });

  it("429 has no Retry-After and 402 is its own answer; 402 and 401 exist only where a key is needed", () => {
    for (const t of tools.tools) {
      const op = post(t.endpoint);
      expect(op.responses["429"].headers["Retry-After"], t.name).toBeUndefined();
      expect(op.responses["429"].description, t.name).toMatch(/no Retry-After header/);
      expect(Boolean(op.responses["402"]), t.name).toBe(t.units > 0);
      expect(Boolean(op.responses["401"]), t.name).toBe(t.units > 0);
    }
    expect(post("/v1/screen").responses["402"].description).toMatch(/not a rate limit and not a retry/);
  });

  it("the shared statuses list says what 429 and 503 carry, and /developers and the default response print it", async () => {
    const s503 = ERROR_STATUSES.find((e) => e.status === 503)!.meaning;
    expect(s503).toContain(`${SHED_RETRY_AFTER_SECONDS} seconds, with retry_after_seconds in the body`);
    expect(s503).toContain(`${LEDGER_RETRY_AFTER_SECONDS} seconds`);
    expect(ERROR_STATUSES.find((e) => e.status === 429)!.meaning).toMatch(/no Retry-After header/);
    const html = await developersHtml();
    expect(html).toContain(escapeHtml(retryStatement()));
    expect(doc.info.description).toContain(retryStatement());
  });

  it("the retry statement is the engine's: it names the body fields each 503 holds and does not say a 429 or a 402 should be retried like a 503", () => {
    for (const cause of honesty.service_unavailable) expect(retryStatement()).toContain(cause.body_fields.join(", "));
    expect(retryStatement()).toMatch(/A 402 is not a retry/);
  });
});

describe("the MCP error codes", () => {
  it("the /mcp operation lists all eight, with what causes each", () => {
    expect(MCP_ERRORS.map((e) => e.code)).toEqual([-32600, -32601, -32602, -32001, -32002, -32003, -32005, -32603]);
    const d: string = post("/mcp").description;
    for (const e of MCP_ERRORS) {
      expect(d).toContain(`${e.code} ${e.name}`);
      expect(d).toContain(e.when);
    }
    expect(d).toContain(mcpErrorsStatement());
    expect(d).toMatch(/not valid JSON is refused at the HTTP level \(400 with a plain \{error\} body\)/);
  });

  it("/developers prints each code once, with its name", async () => {
    const html = await developersHtml();
    const block = /data-testid="mcp-errors">([\s\S]*?)<\/dl>/.exec(html)![1];
    for (const e of MCP_ERRORS) {
      expect(block.split(`>${e.code}</dt>`).length - 1, String(e.code)).toBe(1);
      expect(block).toContain(e.name);
    }
  });

  it("which codes a tool can return follows its tier and whether it can be shed", () => {
    expect(mcpCodesFor("/v1/screen", true)).toEqual([-32001, -32002, -32003, -32005, -32602, -32603].sort((a, b) => b - a));
    expect(mcpCodesFor("/v1/qualify", false)).toEqual([-32003, -32005, -32602, -32603].sort((a, b) => b - a));
    expect(mcpCodesFor("/v1/estimate", false)).toEqual([-32005, -32602, -32603].sort((a, b) => b - a));
    expect(failureStatuses("/v1/estimate", false)).toEqual([400, 413, 415, 422, 429, 500]);
    expect(failureStatuses("/v1/screen", true)).toEqual([400, 401, 402, 413, 415, 422, 429, 500, 503]);
  });
});

describe("browsers (CORS)", () => {
  it("states the engine's default origins, public routes, methods and headers, and /openapi.json and /developers carry the same sentence", async () => {
    const text = corsStatement();
    for (const o of CORS_POLICY.defaultAllowedOrigins) expect(text).toContain(o);
    for (const p of CORS_POLICY.publicPaths) expect(text).toContain(p);
    for (const h of [...CORS_POLICY.allowHeaders, ...CORS_POLICY.exposeHeaders, ...CORS_POLICY.allowMethods]) expect(text).toContain(h);
    expect(text).toMatch(/no Access-Control-Allow-Credentials/);
    expect(text).toMatch(/an operator can change the origin list/);
    expect(doc.info.description).toContain(text);
    expect(await developersHtml()).toContain(escapeHtml(text));
  });
});

describe("the response version: the fact and no promise", () => {
  it("states the value, the body field and the header", () => {
    expect(schemaVersionStatement()).toBe(
      'Every JSON response carries schema_version: "gridforge/api/1" in its body and the same value in an X-GridForge-Schema header. A JSON-RPC response from /mcp carries the header only.',
    );
    expect(doc.info.description).toContain(schemaVersionStatement());
    for (const t of tools.tools) expect(post(t.endpoint).responses["200"].headers["X-GridForge-Schema"].schema.enum, t.name).toEqual(["gridforge/api/1"]);
  });

  it("makes no deprecation, support or stability statement anywhere in the version text, the header's description or the schema_version property", () => {
    const words = /deprecat|sunset|support|stabil|stable|guarantee|promise|commit|backward|compatib|long-term|will (?:not )?change|until|retire|end of life/i;
    expect(schemaVersionStatement()).not.toMatch(words);
    const header = JSON.stringify(doc.paths["/v1/screen"].post.responses["200"].headers["X-GridForge-Schema"]);
    expect(header).not.toMatch(words);
    expect(JSON.stringify(doc.paths["/v1/screen"].post.responses["200"].content["application/json"].schema.properties.schema_version)).not.toMatch(words);
    expect(JSON.stringify(honesty.schema_version)).not.toMatch(/deprecat|sunset|stabil|guarantee|promise|backward/i);
  });
});
