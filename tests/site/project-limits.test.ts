/**
 * Anyone can create a project and upload evidence to it (there are no accounts; a project token is a bearer capability), and
 * neither route was metered: unbounded free project creation and 5 MB uploads into the object store with no ceiling. Now the
 * per-caller allowance applies (lib/rate-limit.ts RATE_POLICIES.project_create / project_evidence), counted after validation
 * so a malformed request never uses it, and one project keeps at most EVIDENCE_MAX_FILES files and
 * EVIDENCE_MAX_TOTAL_BYTES in all.
 *
 * MOCKS: in-memory PostgREST/Storage fake, rate-limit counter through the fake's gf_rate_limit_hit (the SQL is proven in
 * tests/test_buyer_page_migration.py).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES } from "@/lib/rate-limit";
import { EVIDENCE_MAX_FILES, EVIDENCE_MAX_TOTAL_BYTES } from "@/lib/projects";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

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

const from = (ip: string) => ({ "content-type": "application/json", "x-real-ip": ip, "x-forwarded-for": ip });
async function create(body: unknown = { project_name: "Hall A" }, ip = "198.51.100.7") {
  const { POST } = await import("@/app/api/projects/route");
  return POST(new Request(siteUrl("/api/projects"), { method: "POST", headers: from(ip), body: JSON.stringify(body) }));
}
async function upload(project: string, name: string, bytes: Buffer, ip = "198.51.100.7") {
  const { POST } = await import("@/app/api/projects/[token]/evidence/route");
  return POST(
    new Request(siteUrl(`/api/projects/${project}/evidence?filename=${name}&source_category=other`), {
      method: "POST", headers: { "content-type": "text/csv", "x-real-ip": ip, "x-forwarded-for": ip }, body: new Uint8Array(bytes),
    }),
    { params: Promise.resolve({ token: project }) }
  );
}

describe("project creation is metered per caller", () => {
  it("allows the policy's limit and then answers 429 with Retry-After, and a different caller is unaffected", async () => {
    const limit = RATE_POLICIES.project_create.limit;
    for (let i = 0; i < limit; i++) expect((await create({ project_name: `Hall ${i}` })).status, `request ${i + 1}`).toBe(201);
    const refused = await create({ project_name: "one too many" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(db.rows("projects")).toHaveLength(limit);
    expect((await create({ project_name: "someone else" }, "203.0.113.9")).status).toBe(201);
  });

  it("a malformed request is refused without using the allowance", async () => {
    const limit = RATE_POLICIES.project_create.limit;
    const { POST } = await import("@/app/api/projects/route");
    for (let i = 0; i < limit + 5; i++) {
      const r = await POST(new Request(siteUrl("/api/projects"), { method: "POST", headers: from("198.51.100.7"), body: "not json" }));
      expect(r.status).toBe(400);
    }
    expect((await create()).status).toBe(201);
  });
});

describe("evidence upload is metered, and a project's inventory has a ceiling", () => {
  async function project() {
    const body: any = await (await create()).json();
    return body.project_token as string;
  }

  it("answers 429 after the policy's limit of uploads from one address", async () => {
    const p = await project();
    const limit = RATE_POLICIES.project_evidence.limit;
    // distinct contents so none is refused as a duplicate; tiny, so the count ceiling (100) is not what stops us first
    const n = Math.min(limit, EVIDENCE_MAX_FILES);
    for (let i = 0; i < n; i++) expect((await upload(p, `f${i}.csv`, Buffer.from(`a,b\n${i},1\n`))).status, `upload ${i + 1}`).toBe(201);
    if (limit < EVIDENCE_MAX_FILES) expect((await upload(p, "over.csv", Buffer.from("a,b\n9,9\n"))).status).toBe(429);
    expect(RATE_POLICIES.project_evidence.limit).toBeGreaterThan(0);
  });

  it("an unsupported or oversized upload does not use the allowance", async () => {
    const p = await project();
    const { POST } = await import("@/app/api/projects/[token]/evidence/route");
    for (let i = 0; i < RATE_POLICIES.project_evidence.limit + 3; i++) {
      const r = await POST(
        new Request(siteUrl(`/api/projects/${p}/evidence?filename=x.exe`), { method: "POST", headers: { "content-type": "application/x-msdownload", "x-real-ip": "198.51.100.7" }, body: "MZ" }),
        { params: Promise.resolve({ token: p }) }
      );
      expect(r.status).toBe(415);
    }
    expect((await upload(p, "ok.csv", Buffer.from("a,b\n1,2\n"))).status).toBe(201);
  });

  it(`one project keeps at most ${EVIDENCE_MAX_FILES} files`, async () => {
    const p = await project();
    const rows = db.rows("projects").find((r: any) => r.project_token === p) as any;
    for (let i = 0; i < EVIDENCE_MAX_FILES; i++) {
      db.rows("project_evidence").push({ id: `e${i}`, project_id: rows.id, byte_size: 10, sha256: `h${i}` });
    }
    const r = await upload(p, "one-more.csv", Buffer.from("a,b\n1,2\n"));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/most one project keeps/);
    expect(db.objects.size).toBe(0);                                  // nothing was written to the object store
  });

  it(`one project keeps at most ${EVIDENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB`, async () => {
    const p = await project();
    const rows = db.rows("projects").find((r: any) => r.project_token === p) as any;
    db.rows("project_evidence").push({ id: "big", project_id: rows.id, byte_size: EVIDENCE_MAX_TOTAL_BYTES - 5, sha256: "big" });
    const r = await upload(p, "tips-it-over.csv", Buffer.from("a,b\n1,2\n"));
    expect(r.status).toBe(413);
    expect(db.objects.size).toBe(0);
  });
});
