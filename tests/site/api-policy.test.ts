/**
 * The API versioning and deprecation commitment (lib/api-policy.ts): one constant, printed on /developers, in /openapi.json's description and in
 * /llms.txt, and a dated changelog on /developers seeded with the commitment and the additive keys of 2026-11-13.
 *
 * It is a commitment, so what is pinned is (1) that all three surfaces carry the same words, (2) that the words do not promise anything the code
 * does not do (no Deprecation or Sunset header, no automated notice, no second path version that does not exist), (3) that the schema_version value
 * the changelog names is the one the engine sends, and (4) that every key the changelog says was added is really in the engine or its published
 * reference. The document stays free of prices.
 */
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import honesty from "@/lib/openapi-honesty.json";
import { API_CHANGELOG, API_DEPRECATION_NOTICE_DAYS, API_POLICY_DATE, API_VERSIONING_POLICY } from "@/lib/api-policy";
import { API_SCHEMA_VERSION, buildOpenApi, type ToolsFile } from "@/lib/openapi";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

const tools = JSON.parse(readFileSync("public/reference/tools.json", "utf8")) as ToolsFile;
const doc = buildOpenApi(tools, "https://example.invalid", "https://example.invalid/site-origin") as any;
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const flat = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function developersHtml(): Promise<string> {
  const stop = stubEngine(FULL_ENGINE);
  try {
    return renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("the commitment says what was decided", () => {
  it("within /v1 only additive changes; a meaning, a unit, a status code's meaning or a removal ships under a new path version", () => {
    expect(API_VERSIONING_POLICY).toContain("Within /v1 we make only additive changes: new endpoints, new optional request fields and new response keys.");
    expect(API_VERSIONING_POLICY).toMatch(/A change to the meaning of a response key, to a unit, or to the meaning of a status code, and the removal of anything, is a breaking change: it ships under a new path version and never inside \/v1\./);
  });

  it("the previous version keeps running at least 90 days after written notice to every active key holder's account email and a notice on /developers", () => {
    expect(API_DEPRECATION_NOTICE_DAYS).toBe(90);
    expect(API_VERSIONING_POLICY).toContain("keeps running for at least 90 days after we have given written notice to the account email of every active API-key holder and posted a notice on /developers");
  });

  it("schema_version is incremented on any change to a response shape, and a deprecation is a dated entry in the changelog on /developers", () => {
    expect(API_VERSIONING_POLICY).toContain("The schema_version field in every response is incremented on any change to a response shape, additive or breaking.");
    expect(API_VERSIONING_POLICY).toContain("A deprecation is announced with a dated entry in the changelog on /developers.");
  });

  it("promises no header and no automated notice, and says so", () => {
    expect(API_VERSIONING_POLICY).toContain("it sends no Deprecation or Sunset header, and the notice is our email and our entry on /developers");
    expect(API_VERSIONING_POLICY).not.toMatch(/\bwill (?:send|notify|be notified)|automatic|webhook|subscribe|RFC ?8594|Retry-After|guarantee/i);
    // The only places that say "Sunset" or "Deprecation" are the denial above; the claim "sends no header" is true of the engine's source.
    const apiDir = "gridforge/api";
    for (const f of fs.readdirSync(apiDir).filter((n) => n.endsWith(".py"))) {
      expect(fs.readFileSync(path.join(apiDir, f), "utf8"), f).not.toMatch(/Deprecation|Sunset/);
    }
  });

  it("states no price, and the engine has one path version (nothing is deprecated, and the changelog says so)", () => {
    expect(API_VERSIONING_POLICY).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
    expect(fs.readFileSync("gridforge/api/server.py", "utf8")).not.toMatch(/["']\/v2[/"']/);
    expect(API_CHANGELOG[0].text).toContain("/v1 is the only path version and nothing is deprecated");
    expect(API_CHANGELOG.filter((e) => e.kind === "deprecation")).toEqual([]);
  });
});

describe("the three surfaces carry the same words", () => {
  it("/openapi.json's description carries the policy, a pointer to the changelog and no price", () => {
    expect(doc.info.description).toContain(`Versioning and deprecation: ${API_VERSIONING_POLICY}`);
    expect(doc.info.description).toContain("/developers#versioning");
    const text = JSON.stringify(doc).replace(/"currency":\s?"EUR"/g, '"currency":"<code>"');
    expect(text).not.toMatch(/[€$]\s?\d|\bEUR\b/i);
  });

  it("/developers has a 'Versioning and deprecation' section with the policy verbatim and the changelog list", async () => {
    const html = await developersHtml();
    expect(html).toContain('id="versioning"');
    expect(html).toContain("Versioning and deprecation</h2>");
    expect(html).toContain(`data-testid="versioning-policy">${escapeHtml(API_VERSIONING_POLICY)}</p>`);
    const list = /data-testid="api-changelog">([\s\S]*?)<\/ol>/.exec(html)![1];
    expect((list.match(/<li\b/g) ?? []).length).toBe(API_CHANGELOG.length);
    for (const e of API_CHANGELOG) {
      expect(list).toContain(`<time dateTime="${e.date}"`);
      expect(flat(list)).toContain(e.text);
    }
  });

  it("/llms.txt carries the policy and the changelog's address", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const body = (await (await (await import("@/app/llms.txt/route")).GET()).text()).replace(/\s+/g, " ");
      expect(body).toContain(`Versioning and deprecation: ${API_VERSIONING_POLICY} The dated changelog is at `);
      expect(body).toContain("/developers#versioning.");
    } finally {
      stop();
    }
  });
});

describe("the changelog is seeded with the commitment and the additive keys of 2026-11-13, and each is real", () => {
  const additive = API_CHANGELOG.filter((e) => e.kind === "additive");

  it("is dated, starts with the commitment, and names assumed_fields, specification_available and currency as additions", () => {
    expect(API_POLICY_DATE).toBe("2026-11-13");
    expect(API_CHANGELOG[0]).toMatchObject({ date: "2026-11-13", kind: "policy" });
    expect(additive.map((e) => e.text.split(":")[0])).toEqual(["assumed_fields", "specification_available", "currency"]);
    for (const e of API_CHANGELOG) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("schema_version stays what the engine sends, and the entry says so", () => {
    expect(API_SCHEMA_VERSION).toBe("gridforge/api/1");
    expect(honesty.schema_version.value).toBe("gridforge/api/1");
    expect(/^API_SCHEMA = "([^"]+)"/m.exec(fs.readFileSync("gridforge/api/server.py", "utf8"))![1]).toBe("gridforge/api/1");
    expect(API_CHANGELOG[0].text).toContain("did not change schema_version, which stays gridforge/api/1");
  });

  it("assumed_fields is a request field of POST /v1/qualify and adds inputs_declared_assumed, assumed_count and assumed_count_note", () => {
    const server = fs.readFileSync("gridforge/api/server.py", "utf8");
    const payloads = fs.readFileSync("gridforge/api/payloads.py", "utf8");
    expect(server).toContain("assumed_fields");
    expect(server + payloads).toMatch(/inputs_declared_assumed/);
    expect(server + payloads).toMatch(/assumed_count_note/);
    expect(JSON.stringify(honesty.responses["/v1/qualify"])).toMatch(/inputs_declared_assumed.*assumed_count.*assumed_count_note/);
    expect(JSON.stringify(JSON.parse(readFileSync("lib/openapi-discovery.json", "utf8")))).toContain("qualify_assumed_fields");
  });

  it("specification_available is on every constraint of the published reference, and the engine's reference builder writes it", () => {
    expect(fs.readFileSync("gridforge/reference/build.py", "utf8")).toContain('"specification_available"');
    const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8"));
    expect(ref.constraints.length).toBeGreaterThan(0);
    for (const c of ref.constraints) expect(typeof c.specification_available, c.id).toBe("boolean");
  });

  it("currency is a key of the response_template of POST /v1/spec and, in html and md, of POST /v1/power/deploy/spec", () => {
    const server = fs.readFileSync("gridforge/api/server.py", "utf8");
    expect(server).toMatch(/out\["response_template"\] = \{[\s\S]{0,400}"currency": ""/);
    expect(server).toMatch(/def _btm_response_template\(spec\) -> dict:[\s\S]{0,300}"currency": ""/);
  });
});
