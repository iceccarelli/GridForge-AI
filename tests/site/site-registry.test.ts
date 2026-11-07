/**
 * The site and hall registry's route scenarios against an in-memory PostgREST that mirrors migrations 0049-0051 (runs anywhere; SUPPLEMENTAL).
 * The same scenarios run against REAL PostgreSQL through REAL PostgREST in site-registry.realdb.test.ts. This file also holds the checks that only
 * make sense against a fake: the deploy window before the migration, the store being down, and the allowance.
 */
import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installWithAuth, bearerFor } from "./auth-fake";
import { installRegistryRpcs } from "./site-registry-rpc-fake";
import { defineRegistryScenarios } from "./site-registry-scenarios";

function fakeDb(): PostgrestFake {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  const db = new PostgrestFake();
  installRegistryRpcs(db);
  return db;
}

describe("site registry - in-memory PostgREST", () => {
  defineRegistryScenarios({
    async install() {
      return fakeDb().install();
    },
  });
});

const get = async (path: string, who: string, ip = "10.1.1.1") => {
  const { GET } = await import("@/app/api/orgs/route");
  return GET(new Request(siteUrl(path), { headers: { ...bearerFor(who), "x-forwarded-for": ip } }));
};

describe("the deploy window and the store being down", () => {
  it("code live before migrations 0049-0051: every route answers 503 and says nothing was changed, never an empty list", async () => {
    const db = fakeDb();
    for (const fn of [...db.rpcs.keys()].filter((k) => k.startsWith("gf_") && !["gf_rate_limit_hit", "gf_founding_reserve"].includes(k))) db.rpcs.delete(fn);
    const { restore } = installWithAuth(db);
    try {
      const r = await get("/api/orgs", "someone@registry.example");
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect((await r.json()).error).toMatch(/Nothing was changed/);
      const { POST } = await import("@/app/api/orgs/route");
      const w = await POST(new Request(siteUrl("/api/orgs"), { method: "POST", headers: { ...bearerFor("someone@registry.example"), "x-forwarded-for": "10.1.1.2", "content-type": "application/json" }, body: JSON.stringify({ name: "X" }) }));
      expect(w.status).toBe(503);
    } finally {
      restore();
    }
  });

  it("a malformed answer from the database is a 503, not a success", async () => {
    const db = fakeDb();
    db.rpcs.set("gf_my_orgs", () => ({ unexpected: true }));
    const { restore } = installWithAuth(db);
    try {
      expect((await get("/api/orgs", "someone@registry.example", "10.1.1.3")).status).toBe(503);
    } finally {
      restore();
    }
  });

  it("the store being down is a 503", async () => {
    const db = fakeDb();
    const { restore } = installWithAuth(db);
    try {
      db.failMethod = { method: "POST", status: 503, body: "{}" };
      expect((await get("/api/orgs", "someone@registry.example", "10.1.1.4")).status).toBe(503);
    } finally {
      restore();
    }
  });

  it("the route layer drops a row of an organisation the caller is not a member of even if the database were to return it", async () => {
    const db = fakeDb();
    db.rpcs.set("gf_list_sites", () => ({ ok: true, sites: [{ id: "s1", org_id: "mine", org_name: "Mine", name: "Mine", country: null, data_origin: "test" }, { id: "s2", org_id: "theirs", org_name: "Theirs", name: "Theirs", country: null, data_origin: "test" }] }));
    db.rpcs.set("gf_my_orgs", () => ({ ok: true, orgs: [{ id: "mine", name: "Mine", role: "viewer", created_at: "2026-01-01T00:00:00Z" }] }));
    const { restore } = installWithAuth(db);
    try {
      const { GET } = await import("@/app/api/sites/route");
      const r = await GET(new Request(siteUrl("/api/sites"), { headers: { ...bearerFor("someone@registry.example"), "x-forwarded-for": "10.1.1.5" } }));
      const body = await r.json();
      expect(body.sites.map((s: any) => s.id)).toEqual(["s1"]);
      expect(JSON.stringify(body)).not.toContain("Theirs");
    } finally {
      restore();
    }
  });
});

describe("the allowance", () => {
  it("writes are counted per caller address; the limit-th+1 write is a 429 with Retry-After, and a refused (invalid) request spends nothing", async () => {
    const db = fakeDb();
    const { restore } = installWithAuth(db);
    try {
      const { POST } = await import("@/app/api/orgs/route");
      const post = (body: unknown) => POST(new Request(siteUrl("/api/orgs"), { method: "POST", headers: { ...bearerFor("busy@registry.example"), "x-forwarded-for": "10.9.9.9", "content-type": "application/json" }, body: JSON.stringify(body) }));
      for (let i = 0; i < 30; i++) expect((await post({ nope: 1 })).status).toBe(400);      // invalid: free
      const hits = () => db.rows("rate_limit_windows").filter((r) => r.bucket === "registry_write").reduce((n, r) => n + (r.hits as number), 0);
      expect(hits()).toBe(0);
      const limit = RATE_POLICIES.registry_write.limit;
      let last: Response | null = null;
      for (let i = 0; i < limit + 1; i++) last = await post({ name: `O${i}` });
      expect(last!.status).toBe(429);
      expect(last!.headers.get("retry-after")).toBeTruthy();
      expect(last!.headers.get("cache-control")).toBe("no-store");
    } finally {
      restore();
    }
  });

  it("fails closed: when the counter cannot be read the request is refused with 503, not run", async () => {
    const db = fakeDb();
    db.rpcs.delete("gf_rate_limit_hit");
    const { restore } = installWithAuth(db);
    try {
      const r = await get("/api/orgs", "someone@registry.example", "10.1.2.1");
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
    } finally {
      restore();
    }
  });

  it("the new policies exist with the documented bounds", () => {
    expect(RATE_POLICIES.registry_read).toEqual({ bucket: "registry_read", limit: 600, windowSeconds: 3600 });
    expect(RATE_POLICIES.registry_write).toEqual({ bucket: "registry_write", limit: 120, windowSeconds: 3600 });
    expect(RATE_POLICIES.registry_account).toEqual({ bucket: "registry_account", limit: 1200, windowSeconds: 3600 });
  });
});
