import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { GET } from "@/app/openapi.json/route";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid") as any;

describe("/openapi.json", () => {
  it("has one operation for every tool, at the tool's own endpoint and method", () => {
    for (const t of tools.tools) {
      const op = doc.paths[t.endpoint]?.[t.method.toLowerCase()];
      expect(op, t.name).toBeTruthy();
      expect(op.operationId).toBe(t.name);
      expect(op.requestBody.content["application/json"].schema).toEqual(t.inputSchema);
    }
    expect(Object.keys(doc.paths).length).toBe(new Set(tools.tools.map((t) => t.endpoint)).size);
  });

  it("asks for a key exactly where the tool is metered", () => {
    for (const t of tools.tools) {
      const op = doc.paths[t.endpoint][t.method.toLowerCase()];
      expect(op["x-gridforge-units"]).toBe(t.units);
      expect(op.security).toEqual(t.units === 0 ? [] : [{ ApiKeyAuth: [] }]);
    }
    expect(doc.components.securitySchemes.ApiKeyAuth.name).toBe(tools.auth.header);
  });

  it("states no price", () => {
    expect(JSON.stringify(doc)).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
  });

  it("is served as JSON and parses as OpenAPI 3.1", async () => {
    const res = await GET();
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBeTruthy();
  });
});
