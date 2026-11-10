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
import { installProjectRpcs } from "./project-rpc-fake";
import { defineRegistryScenarios } from "./site-registry-scenarios";
import { defineEngineDiffScenarios } from "./site-registry-engine-diff-scenarios";

function fakeDb(): PostgrestFake {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  const db = new PostgrestFake();
  // The project file decision (0048) is another migration's function; the registry scenarios seed files through it, as production does.
  installProjectRpcs(db);
  db.createTable("project_evidence_reviews");
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

describe("site registry engine-backed capacity diff - in-memory PostgREST", () => {
  let store: PostgrestFake | null = null;
  defineEngineDiffScenarios({
    async install() {
      store = fakeDb();
      return store.install();
    },
    // Moves every claim recorded so far to that time, so a later recording is on a later day.
    backdate(recordedAt) {
      for (const r of store!.rows("hall_inputs")) r.created_at = recordedAt;
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

describe("the route layer's own membership check, with a database that misbehaves", () => {
  // A defence in depth: these make the DATABASE answer for an organisation the caller is not in, as if a function had lost its role check, and
  // show the route refuses to pass it on.
  const hallOf = (org: string) => ({ id: "h1", label: "Secret hall", site_id: "s1", site_name: "Secret site", org_id: org, data_origin: "production", country: null });
  const stranger = "someone@registry.example";
  async function withBrokenDb(setup: (db: PostgrestFake) => void, run: () => Promise<Response>) {
    const db = fakeDb();
    db.rpcs.set("gf_my_orgs", () => ({ ok: true, orgs: [{ id: "mine", name: "Mine", role: "viewer", created_at: "2026-01-01T00:00:00Z" }] }));
    setup(db);
    const { restore } = installWithAuth(db);
    try { return await run(); } finally { restore(); }
  }
  const id = "00000000-0000-4000-8000-0000000000aa";
  const headers = { ...bearerFor(stranger), "x-forwarded-for": "10.2.2.2" };

  it("inputs of a hall of another organisation are a 404 with none of its data", async () => {
    const r = await withBrokenDb((db) => db.rpcs.set("gf_hall_inputs", () => ({ ok: true, hall: hallOf("theirs"), inputs: [{ id: "i", field_path: "grid.x", value: 987, unit: null, evidence_class: "E1", origin: "assumed", as_of: "2026-01-01", recorded_by: "a@b.example", recorded_at: "2026-01-01", supersedes_id: null, superseded: false, source: null }] })), async () => {
      const { GET } = await import("@/app/api/halls/[id]/inputs/route");
      return GET(new Request(siteUrl(`/api/halls/${id}/inputs`), { headers }), { params: Promise.resolve({ id }) });
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/Secret|987/);
  });

  it("the halls of a site of another organisation are a 404", async () => {
    const r = await withBrokenDb((db) => db.rpcs.set("gf_list_halls", () => ({ ok: true, site: { id: "s1", org_id: "theirs", name: "Secret site", country: null, data_origin: "production" }, halls: [{ id: "h", site_id: "s1", label: "Secret hall", created_by: "a@b.example", created_at: "2026-01-01" }] })), async () => {
      const { GET } = await import("@/app/api/sites/[id]/halls/route");
      return GET(new Request(siteUrl(`/api/sites/${id}/halls`), { headers }), { params: Promise.resolve({ id }) });
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/Secret/);
  });

  it("the timeline of a hall of another organisation is a 404", async () => {
    const r = await withBrokenDb((db) => db.rpcs.set("gf_hall_timeline", () => ({ ok: true, hall: { id: "h1", label: "Secret hall", site_name: "Secret site", org_id: "theirs", data_origin: "production" }, truncated: false, events: [] })), async () => {
      const { GET } = await import("@/app/api/halls/[id]/timeline/route");
      return GET(new Request(siteUrl(`/api/halls/${id}/timeline`), { headers }), { params: Promise.resolve({ id }) });
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/Secret/);
  });

  it("the roster of another organisation is a 404", async () => {
    const r = await withBrokenDb((db) => db.rpcs.set("gf_org_members", () => ({ ok: true, members: [{ id: "m", email: "secret@theirs.example", role: "owner", added_by: "x@y.example", added_at: "2026-01-01" }] })), async () => {
      const { GET } = await import("@/app/api/orgs/[id]/members/route");
      return GET(new Request(siteUrl(`/api/orgs/${id}/members`), { headers }), { params: Promise.resolve({ id }) });
    });
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toMatch(/secret@theirs/);
  });

  it("an answer that carries a project token or a storage location is never passed on: responses are built field by field", async () => {
    const r = await withBrokenDb((db) => db.rpcs.set("gf_hall_timeline", () => ({
      ok: true, truncated: false, hall: { id: "h1", label: "Hall", site_name: "Site", org_id: "mine", data_origin: "test", project_token: "LEAK-1" },
      events: [{ hall_id: "h1", occurred_at: "2026-01-01T00:00:00Z", kind: "project_event", subject: "x", summary: "s", origin: "recorded", evidence_class: null, basis: "b", actor: "a@b.example", project_id: null, superseded: false, source_table: "project_events", source_id: "e", payload: { case_token: "LEAK-2" }, storage_ref: "LEAK-3" }],
    })), async () => {
      const { GET } = await import("@/app/api/halls/[id]/timeline/route");
      return GET(new Request(siteUrl(`/api/halls/${id}/timeline`), { headers }), { params: Promise.resolve({ id }) });
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toMatch(/LEAK/);
  });
});

describe("the allowance", () => {
  const postOrg = (who: string, ip: string, body: unknown) =>
    import("@/app/api/orgs/route").then(({ POST }) =>
      POST(new Request(siteUrl("/api/orgs"), { method: "POST", headers: { ...bearerFor(who), "x-forwarded-for": ip, "content-type": "application/json" }, body: JSON.stringify(body) })));

  it("writes are counted per VERIFIED ACCOUNT: the limit+1-th is a 429 with Retry-After from any address, a refused (invalid) request spends nothing, and a colleague on the same address is not locked out", async () => {
    const db = fakeDb();
    const { restore } = installWithAuth(db);
    try {
      for (let i = 0; i < 30; i++) expect((await postOrg("busy@registry.example", "10.9.9.9", { nope: 1 })).status).toBe(400);      // invalid: free
      const hits = () => db.rows("rate_limit_windows").filter((r) => r.bucket === "registry_write").reduce((n, r) => n + (r.hits as number), 0);
      expect(hits()).toBe(0);
      const limit = RATE_POLICIES.registry_write.limit;
      let last: Response | null = null;
      for (let i = 0; i < limit + 1; i++) last = await postOrg("busy@registry.example", "10.9.9.9", { name: `O${i}` });   // one address, one account
      expect(last!.status).toBe(429);
      expect(last!.headers.get("retry-after")).toBeTruthy();
      expect(last!.headers.get("cache-control")).toBe("no-store");
      // the address is not what is counted: a colleague behind the SAME address as the exhausted account is unaffected (an office behind a NAT)
      expect((await postOrg("colleague@registry.example", "10.9.9.9", { name: "Mine" })).status).toBe(201);
      // and the exhausted account is exhausted from any other address too
      expect((await postOrg("busy@registry.example", "10.77.7.7", { name: "Elsewhere" })).status).toBe(429);
      expect(db.rows("rate_limit_windows").every((r) => r.bucket !== "registry_account")).toBe(true);
    } finally {
      restore();
    }
  });

  it("one write and one read each cost a small, fixed number of store requests (no N+3 fan-out)", async () => {
    const db = fakeDb();
    const { restore } = installWithAuth(db);
    try {
      const who = "counter@registry.example";
      const countFor = async (run: () => Promise<Response>) => { const before = db.calls.length; const r = await run(); expect(r.status).toBeLessThan(300); return db.calls.length - before; };
      const created = await postOrg(who, "10.8.8.8", { name: "Counted" });
      const org = (await created.json()).org.id as string;
      const post = (path: string, body: unknown, mod: () => Promise<any>, ctx?: unknown) => async () => (await mod()).POST(new Request(siteUrl(path), { method: "POST", headers: { ...bearerFor(who), "x-forwarded-for": "10.8.8.8", "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
      expect(await countFor(post("/api/sites", { orgId: org, name: "S", dataOrigin: "test" }, () => import("@/app/api/sites/route")))).toBe(5);           // EXACT: the Auth-lookup hit, its refund (a read and a delete: the user is valid), the allowance hit and the write. A double charge adds one.
      const get = (path: string, mod: () => Promise<any>, ctx?: unknown) => async () => (await mod()).GET(new Request(siteUrl(path), { headers: { ...bearerFor(who), "x-forwarded-for": "10.8.8.8" } }), ctx);
      const sites = await (await get("/api/sites", () => import("@/app/api/sites/route"))()).json();
      expect(sites.sites[0].halls).toEqual([]);                                   // halls travel inside the site list
      expect(await countFor(get("/api/sites", () => import("@/app/api/sites/route")))).toBe(6);                 // EXACT: the same three for the lookup, the allowance, the list, the membership check
      expect(await countFor(get("/api/orgs", () => import("@/app/api/orgs/route")))).toBe(5);                 // EXACT: the lookup hit and its refund (3), the allowance, the membership read
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

  it("the policies exist with the documented bounds, and the old address-keyed account policy is gone", () => {
    expect(RATE_POLICIES.registry_read).toEqual({ bucket: "registry_read", limit: 600, windowSeconds: 3600 });
    expect(RATE_POLICIES.registry_write).toEqual({ bucket: "registry_write", limit: 120, windowSeconds: 3600 });
    expect("registry_account" in RATE_POLICIES).toBe(false);
  });
});
