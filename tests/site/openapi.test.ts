import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REGISTRY_PATH_NAMES, buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { GET } from "@/app/openapi.json/route";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;

describe("/openapi.json", () => {
  it("has one operation for every tool, at the tool's own endpoint and method", () => {
    for (const t of tools.tools) {
      const op = doc.paths[t.endpoint]?.[t.method.toLowerCase()];
      expect(op, t.name).toBeTruthy();
      expect(op.operationId).toBe(t.name);
      expect(op.requestBody.content["application/json"].schema).toEqual(t.inputSchema);
    }
    // The document holds the engine's endpoints and, besides them, only the website's registry paths.
    expect(Object.keys(doc.paths).sort()).toEqual([...new Set(tools.tools.map((t) => t.endpoint)), ...REGISTRY_PATH_NAMES].sort());
  });

  it("describes the site and hall registry as website routes: a session token, no key, never metered, every answer no-store, no admin route", () => {
    expect(REGISTRY_PATH_NAMES.sort()).toEqual([
      "/api/halls/{id}/inputs", "/api/halls/{id}/projects", "/api/halls/{id}/timeline", "/api/orgs", "/api/orgs/{id}/members", "/api/sites", "/api/sites/{id}/halls",
    ]);
    const ops: [string, string][] = [
      ["/api/orgs", "get"], ["/api/orgs", "post"], ["/api/orgs/{id}/members", "get"], ["/api/orgs/{id}/members", "post"], ["/api/orgs/{id}/members", "delete"],
      ["/api/sites", "get"], ["/api/sites", "post"], ["/api/sites/{id}/halls", "get"], ["/api/sites/{id}/halls", "post"],
      ["/api/halls/{id}/inputs", "get"], ["/api/halls/{id}/inputs", "post"], ["/api/halls/{id}/timeline", "get"],
      ["/api/halls/{id}/projects", "post"], ["/api/halls/{id}/projects", "delete"],
    ];
    for (const [p, m] of ops) {
      const op = doc.paths[p][m];
      expect(op, `${m} ${p}`).toBeTruthy();
      expect(op.security, `${m} ${p}`).toEqual([{ SupabaseSession: [] }]);
      expect(op["x-gridforge-units"], `${m} ${p}`).toBeUndefined();
      expect(doc.paths[p].servers[0].url).toBe("https://example.invalid/site-origin");
      for (const [status, r] of Object.entries<any>(op.responses)) {
        if (status !== "default") expect(r.headers["Cache-Control"], `${m} ${p} ${status}`).toBeTruthy();
      }
      for (const s of ["401", "403", "429", "503"]) expect(op.responses[s], `${m} ${p} ${s}`).toBeTruthy();
    }
    expect(doc.components.securitySchemes.SupabaseSession).toMatchObject({ type: "http", scheme: "bearer" });
    expect(JSON.stringify(doc.paths)).not.toMatch(/\/api\/admin/);
    // the shapes the routes use: 201 on create, 200 or 201 on attach, the opaque cursor, the history switch
    expect(doc.paths["/api/orgs"].post.responses["201"]).toBeTruthy();
    expect(doc.paths["/api/halls/{id}/projects"].post.responses["200"]).toBeTruthy();
    expect(doc.paths["/api/halls/{id}/projects"].post.responses["201"]).toBeTruthy();
    expect(doc.paths["/api/halls/{id}/timeline"].get.parameters.map((x: any) => x.name)).toEqual(["id", "limit", "cursor"]);
    expect(doc.paths["/api/halls/{id}/inputs"].get.parameters.map((x: any) => x.name)).toEqual(["id", "history", "field", "limit"]);
  });

  it("asks for a key exactly where the tool is metered", () => {
    for (const t of tools.tools) {
      const op = doc.paths[t.endpoint][t.method.toLowerCase()];
      expect(op["x-gridforge-units"]).toBe(t.units);
      expect(op.security).toEqual(t.units === 0 ? [] : [{ ApiKeyAuth: [] }]);
    }
    expect(doc.components.securitySchemes.ApiKeyAuth.name).toBe(tools.auth.header);
  });

  it("lists, for every registry path, exactly the methods its route file exports", () => {
    for (const p of REGISTRY_PATH_NAMES) {
      const file = `app${p.replace(/\{id\}/g, "[id]")}/route.ts`;
      const exported = [...readFileSync(file, "utf8").matchAll(/^export async function (GET|POST|DELETE|PUT|PATCH)\b/gm)].map((m) => m[1].toLowerCase()).sort();
      const { servers, ...operations } = doc.paths[p];
      expect(Object.keys(operations).sort(), p).toEqual(exported);
      expect(servers).toHaveLength(1);
    }
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
