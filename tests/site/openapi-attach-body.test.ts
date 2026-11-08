import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { AttachBody, NON_PRODUCTION_ATTACH_MESSAGE } from "@/lib/sites";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;
const post = doc.paths["/api/halls/{id}/projects"].post;
const schema = post.requestBody.content["application/json"].schema;

describe("POST /api/halls/{id}/projects in the OpenAPI document", () => {
  it("describes exactly the keys AttachBody accepts (the schema is additionalProperties:false, so a missing key makes a valid request look invalid)", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(AttachBody.shape).sort());
    expect(schema.required).toEqual(["projectToken"]);
    // required in OpenAPI iff required in zod
    const requiredInZod = Object.entries(AttachBody.shape).filter(([, v]) => !(v as any).safeParse(undefined).success).map(([k]) => k);
    expect(requiredInZod).toEqual(schema.required);
    expect(schema.properties.confirmNonProductionSite.type).toBe("boolean");
  });

  it("documents the 422 (reason non_production_site_unconfirmed), what is permanent, and that nothing was written", () => {
    const d = post.responses["422"].description as string;
    expect(d).toMatch(/non_production_site_unconfirmed/);
    expect(d).toMatch(/PERMANENTLY excludes/);
    expect(d).toMatch(/does not undo it|detaching does not undo/);
    expect(d).toMatch(/Nothing was written/);
    expect(post.description).toMatch(/enforced by this route, not by the database function/);
  });

  it("the live refusal message says the same thing and does not send the person to an internal migration number", () => {
    expect(NON_PRODUCTION_ATTACH_MESSAGE).toMatch(/PERMANENTLY excludes/);
    expect(NON_PRODUCTION_ATTACH_MESSAGE).not.toMatch(/migration|0052/);
    expect(NON_PRODUCTION_ATTACH_MESSAGE).toMatch(/calibration ledger gate/);
  });
});
