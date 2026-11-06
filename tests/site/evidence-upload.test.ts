/**
 * The evidence-upload control: it makes the one request the route expects, takes its limits from the route's own constants,
 * and has no way to say "verified". The route stays the authority (tests/site/verified-power-record.test.ts covers its
 * validation); here the control's request is replayed against the real route and the stored row is inspected.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as limits from "@/lib/project-evidence-upload";
import * as server from "@/lib/projects";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

describe("one contract, defined once", () => {
  it("the server re-exports exactly the constants the control reads", () => {
    expect(server.EVIDENCE_MAX_BYTES).toBe(limits.EVIDENCE_MAX_BYTES);
    expect(server.EVIDENCE_MAX_FILES).toBe(limits.EVIDENCE_MAX_FILES);
    expect(server.EVIDENCE_MAX_TOTAL_BYTES).toBe(limits.EVIDENCE_MAX_TOTAL_BYTES);
    expect([...server.EVIDENCE_MEDIA_TYPES]).toEqual([...limits.EVIDENCE_MEDIA_TYPES]);
    expect([...server.EVIDENCE_CATEGORIES]).toEqual([...limits.EVIDENCE_CATEGORIES]);
  });
  it("every category has a label and the picker offers only accepted types", () => {
    for (const c of limits.EVIDENCE_CATEGORIES) expect(limits.EVIDENCE_CATEGORY_LABEL[c].length).toBeGreaterThan(0);
    for (const t of limits.EVIDENCE_MEDIA_TYPES) expect(limits.EVIDENCE_ACCEPT).toContain(t);
    expect(limits.EVIDENCE_ACCEPT).not.toMatch(/exe|html|zip/);
  });
  it("the screen and the module do not restate a limit as a literal", () => {
    const ui = readFileSync("components/ai/EvidenceUpload.tsx", "utf8");
    expect(ui).not.toMatch(/5\s*\*\s*1024|5242880|\b100\s*MB\b/);
  });
});

describe("media type and refusals before any request", () => {
  it("falls back to the extension when the browser reports a generic or empty type", () => {
    expect(limits.evidenceMediaType({ name: "load.csv", type: "application/vnd.ms-excel" })).toBe("text/csv");
    expect(limits.evidenceMediaType({ name: "meta.JSON", type: "" })).toBe("application/json");
    expect(limits.evidenceMediaType({ name: "a.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(limits.evidenceMediaType({ name: "x.pdf", type: "application/pdf; charset=binary" })).toBe("application/pdf");
  });
  it("refuses other types, no extension, empty and oversized files", () => {
    expect(limits.checkEvidenceFile({ name: "a.exe", size: 10, type: "application/x-msdownload" })).toMatch(/Unsupported/);
    expect(limits.checkEvidenceFile({ name: "noext", size: 10, type: "" })).toMatch(/Unsupported/);
    expect(limits.checkEvidenceFile({ name: "a.csv", size: 0, type: "text/csv" })).toMatch(/empty/);
    expect(limits.checkEvidenceFile({ name: "a.csv", size: limits.EVIDENCE_MAX_BYTES + 1, type: "text/csv" })).toMatch(/5 MB/);
    expect(limits.checkEvidenceFile({ name: "a.csv", size: limits.EVIDENCE_MAX_BYTES, type: "text/csv" })).toBeNull();
  });
});

describe("the request has no field that could set a review status or an evidence class", () => {
  it("carries only filename, source_category and note, and a Content-Type", () => {
    const r = limits.buildEvidenceRequest("tok/en", { name: "letter.pdf", type: "application/pdf" }, { category: "utility_correspondence", note: "  from the DSO " });
    if ("error" in r) throw new Error(r.error);
    const u = new URL(r.url, "https://x.test");
    expect(u.pathname).toBe("/api/projects/tok%2Fen/evidence");
    expect([...u.searchParams.keys()].sort()).toEqual(["filename", "note", "source_category"]);
    expect(u.searchParams.get("note")).toBe("from the DSO");
    expect(Object.keys(r.headers)).toEqual(["Content-Type"]);
  });
  it("an unknown category is sent as 'other', never as free text", () => {
    const r = limits.buildEvidenceRequest("t", { name: "a.csv", type: "text/csv" }, { category: "verified", note: "" });
    if ("error" in r) throw new Error(r.error);
    expect(new URL(r.url, "https://x.test").searchParams.get("source_category")).toBe("other");
  });
  it("the component source never names review_status, evidence_class or 'verified' as something it sends", () => {
    const ui = readFileSync("components/ai/EvidenceUpload.tsx", "utf8");
    expect(ui).not.toMatch(/review_status\s*[:=]|evidence_class\s*[:=]|source_category=verified/);
    expect(ui).toContain("buildEvidenceRequest");
    // the only fetch in the control is the evidence POST
    expect(ui.match(/fetch\(/g)).toHaveLength(1);
  });
});

describe("replayed against the real route", () => {
  let db: PostgrestFake;
  let restore: () => void;
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.RATE_LIMIT_HMAC_KEY = "rate-limit-test-hmac-key-0123456789abcdef";
    db = new PostgrestFake(["projects", "project_links", "project_evidence", "project_events"]);
    db.uniqueKeys.set("projects", [["project_token"]]);
    installProjectRpcs(db);
    restore = db.install();
  });
  afterEach(() => restore());

  async function project() {
    const { POST } = await import("@/app/api/projects/route");
    const r = await POST(new Request(siteUrl("/api/projects"), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.1" }, body: JSON.stringify({ project_name: "Hall A" }) }));
    return ((await r.json()) as { project_token: string }).project_token;
  }
  async function send(token: string, url: string, headers: Record<string, string>, body: string) {
    const { POST } = await import("@/app/api/projects/[token]/evidence/route");
    return POST(new Request(siteUrl(url), { method: "POST", headers: { ...headers, "x-real-ip": "198.51.100.1" }, body }), { params: Promise.resolve({ token }) });
  }

  it("what the control sends is stored unverified and unclassified", async () => {
    const token = await project();
    const r = limits.buildEvidenceRequest(token, { name: "load data.csv", type: "application/vnd.ms-excel" }, { category: "load_data", note: "2025 meter export" });
    if ("error" in r) throw new Error(r.error);
    const res = await send(token, r.url, r.headers, "t,kW\n1,2\n");
    expect(res.status).toBe(201);
    const row = db.rows("project_evidence")[0] as Record<string, unknown>;
    expect(row).toMatchObject({ review_status: "unverified", evidence_class: null, source_category: "load_data", media_type: "text/csv", filename: "load_data.csv", note: "2025 meter export" });
  });

  it("even a hand-crafted request cannot upload as verified or with a class (the route ignores those parameters)", async () => {
    const token = await project();
    const res = await send(token, `/api/projects/${token}/evidence?filename=a.csv&source_category=other&review_status=verified&evidence_class=E7`, { "content-type": "text/csv" }, "a,b\n1,2\n");
    expect(res.status).toBe(201);
    expect(db.rows("project_evidence")[0]).toMatchObject({ review_status: "unverified", evidence_class: null });
    const body = await res.clone().json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toMatch(/"review_status":"verified"/);
  });

  it("server errors reach the control in the route's own words (duplicate, wrong type, no such project)", async () => {
    const token = await project();
    const ok = limits.buildEvidenceRequest(token, { name: "a.csv", type: "text/csv" }, { category: "other", note: "" });
    if ("error" in ok) throw new Error(ok.error);
    await send(token, ok.url, ok.headers, "x,y\n1,2\n");
    const dup = await send(token, ok.url, ok.headers, "x,y\n1,2\n");
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/already attached/);
    const bad = await send(token, ok.url, { "content-type": "text/html" }, "<p>");
    expect(bad.status).toBe(415);
    const nope = await send("no-such-project", ok.url.replace(token, "no-such-project"), ok.headers, "q,r\n");
    expect(nope.status).toBe(404);
  });
});
