/**
 * The site and hall registry (migrations 0049-0051, lib/sites.ts, app/api/orgs|sites|halls) as a CALLER meets it, written once and run
 * against two backends:
 *
 *   tests/site/site-registry.test.ts           an in-memory PostgREST that mirrors the SQL (runs anywhere; SUPPLEMENTAL)
 *   tests/site/site-registry.realdb.test.ts    REAL PostgreSQL through REAL PostgREST (the proof the routes and the functions agree)
 *
 * Everything goes through the route handlers and the real data layer. The only thing stubbed is Supabase Auth's /auth/v1/user.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { rest } from "@/lib/pgrest";
import { installAuth, tokenFor, unconfirmedBearerFor } from "./auth-fake";

export interface Backend {
  /** Install the store under test (as globalThis.fetch) and the env it needs. Returns its restore. */
  install(): Promise<() => void>;
}

type Res = { status: number; body: any; headers: Headers };

const uid = () => crypto.randomBytes(5).toString("hex");
const SECRET = `SECRET-${uid()}-do-not-leak`;
const GHOST = "00000000-0000-4000-8000-00000000dead";

const ROUTES = {
  orgs: () => import("@/app/api/orgs/route"),
  members: () => import("@/app/api/orgs/[id]/members/route"),
  sites: () => import("@/app/api/sites/route"),
  halls: () => import("@/app/api/sites/[id]/halls/route"),
  inputs: () => import("@/app/api/halls/[id]/inputs/route"),
  timeline: () => import("@/app/api/halls/[id]/timeline/route"),
  projects: () => import("@/app/api/halls/[id]/projects/route"),
} as const;
type RouteName = keyof typeof ROUTES;
const PATHS: Record<RouteName, (id: string) => string> = {
  orgs: () => "/api/orgs", members: (id) => `/api/orgs/${id}/members`, sites: () => "/api/sites", halls: (id) => `/api/sites/${id}/halls`,
  inputs: (id) => `/api/halls/${id}/inputs`, timeline: (id) => `/api/halls/${id}/timeline`, projects: (id) => `/api/halls/${id}/projects`,
};

/** Every route and method this feature adds. A new one is added here or it is not tested at all. */
const ENDPOINTS: { route: RouteName; method: "GET" | "POST" | "DELETE"; body?: unknown }[] = [
  { route: "orgs", method: "GET" }, { route: "orgs", method: "POST", body: { name: "X" } },
  { route: "members", method: "GET" }, { route: "members", method: "POST", body: { email: "x@y.example", role: "viewer" } }, { route: "members", method: "DELETE" },
  { route: "sites", method: "GET" }, { route: "sites", method: "POST", body: { orgId: GHOST, name: "S", dataOrigin: "test" } },
  { route: "halls", method: "GET" }, { route: "halls", method: "POST", body: { label: "H" } },
  { route: "inputs", method: "GET" },
  { route: "inputs", method: "POST", body: { fieldPath: "grid.firm_capacity_mva", value: 1, evidenceClass: "E1", origin: "assumed", asOf: "2026-01-01" } },
  { route: "timeline", method: "GET" }, { route: "projects", method: "POST", body: { projectToken: "0123456789abcdef" } }, { route: "projects", method: "DELETE" },
];

export function defineRegistryScenarios(backend: Backend): void {
  let restore: () => void;
  let ip: string;

  beforeEach(async () => {
    const undoBackend = await backend.install();
    const auth = installAuth();
    restore = () => { auth.restore(); undoBackend(); };
    // A caller address of its own per test, so rate-limit counters on a shared database never bleed between tests.
    ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  });
  afterEach(() => restore());

  // ------------------------------------------------------------------------------------------------- helpers

  const person = (n: string) => `${n}-${uid()}@registry.example`;

  async function call(route: RouteName, method: string, as: string | { raw: Record<string, string> } | undefined, opts: { id?: string; query?: string; body?: unknown } = {}): Promise<Res> {
    const headers: Record<string, string> = { "x-forwarded-for": ip };
    if (typeof as === "string") headers.authorization = `Bearer ${tokenFor(as)}`;
    else if (as) Object.assign(headers, as.raw);
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const mod = (await ROUTES[route]()) as unknown as Record<string, (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>>;
    const res = await mod[method](
      new Request(siteUrl(PATHS[route](opts.id ?? GHOST) + (opts.query ?? "")), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
      { params: Promise.resolve({ id: opts.id ?? GHOST }) }
    );
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  }

  const mkOrg = async (as: string, name = `Org ${uid()}`) => {
    const r = await call("orgs", "POST", as, { body: { name } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.org.id as string;
  };
  const addMember = (as: string, org: string, email: string, role: string) => call("members", "POST", as, { id: org, body: { email, role } });
  const mkSite = async (as: string, org: string, name = `Site ${uid()}`, dataOrigin = "synthetic") => {
    const r = await call("sites", "POST", as, { body: { orgId: org, name, country: "DE", dataOrigin } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.site.id as string;
  };
  const mkHall = async (as: string, site: string, label = `Hall ${uid()}`) => {
    const r = await call("halls", "POST", as, { id: site, body: { label } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.hall.id as string;
  };
  const input = (over: Record<string, unknown> = {}) => ({
    fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed", asOf: "2026-01-15", ...over,
  });
  const record = (as: string, hall: string, over: Record<string, unknown> = {}) => call("inputs", "POST", as, { id: hall, body: input(over) });

  /** An organisation with an owner, an editor and a viewer, one site and one hall. */
  async function team() {
    const owner = person("owner"), editor = person("editor"), viewer = person("viewer");
    const org = await mkOrg(owner);
    expect((await addMember(owner, org, editor, "editor")).status).toBe(201);
    expect((await addMember(owner, org, viewer, "viewer")).status).toBe(201);
    const site = await mkSite(editor, org);
    const hall = await mkHall(editor, site);
    return { owner, editor, viewer, org, site, hall };
  }

  async function seedProject(attachTo?: { as: string; hall: string }) {
    const token = `tok-${uid()}${uid()}`;
    const p = await rest<any[]>("POST", "projects", { project_token: token, project_name: "North hall build" });
    expect(p.ok, JSON.stringify(p)).toBe(true);
    const id = (p as any).data[0].id as string;
    if (attachTo) expect((await call("projects", "POST", attachTo.as, { id: attachTo.hall, body: { projectToken: token } })).status).toBe(201);
    return { id, token };
  }
  async function seedEvidence(projectId: string, review = "verified") {
    const e = await rest<any[]>("POST", "project_evidence", {
      project_id: projectId, filename: "connection-agreement.pdf", media_type: "application/pdf", sha256: uid().repeat(7).slice(0, 64).padEnd(64, "a"),
      byte_size: 100, storage_ref: `project-evidence/${SECRET}`, review_status: review,
    });
    expect(e.ok, JSON.stringify(e)).toBe(true);
    return (e as any).data[0].id as string;
  }

  // ------------------------------------------------------------------------------------------------- the door

  describe("every route identifies the caller and requires a VERIFIED address", () => {
    for (const ep of ENDPOINTS) {
      const label = `${ep.method} ${PATHS[ep.route]("{id}")}`;
      it(`${label}: no token -> 401, a forged token -> 401, an unconfirmed address -> 403, and each answer is no-store`, async () => {
        const none = await call(ep.route, ep.method, undefined, { body: ep.body, query: ep.method === "DELETE" ? `?id=${GHOST}` : "" });
        expect(none.status).toBe(401);
        const forged = await call(ep.route, ep.method, { raw: { authorization: "Bearer forged.jwt.value" } }, { body: ep.body, query: ep.method === "DELETE" ? `?id=${GHOST}` : "" });
        expect(forged.status).toBe(401);
        const unconfirmed = await call(ep.route, ep.method, { raw: unconfirmedBearerHeader(person("unconfirmed")) }, { body: ep.body, query: ep.method === "DELETE" ? `?id=${GHOST}` : "" });
        expect(unconfirmed.status).toBe(403);
        expect(unconfirmed.body.error).toBe("Confirm your email address by signing in with the emailed link, then try again.");
        for (const r of [none, forged, unconfirmed]) expect(r.headers.get("cache-control")).toBe("no-store");
      });
      it(`${label}: an unconfigured store is a 503 that changes nothing, even for a verified caller`, async () => {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        try {
          const r = await call(ep.route, ep.method, person("anyone"), { body: ep.body, query: ep.method === "DELETE" ? `?id=${GHOST}` : "" });
          expect(r.status).toBe(503);
          expect(r.headers.get("cache-control")).toBe("no-store");
        } finally {
          process.env.SUPABASE_URL = url;
          process.env.SUPABASE_SERVICE_ROLE_KEY = key;
        }
      });
    }

    it("the caller's address is never taken from the request: a body, a query or a header that names someone else changes nothing", async () => {
      const t = await team();
      const stranger = person("stranger");
      const r = await call("orgs", "GET", { raw: { authorization: `Bearer ${tokenFor(stranger)}`, "x-user-email": t.owner } }, { query: `?email=${t.owner}&actor=${t.owner}` });
      expect(r.status).toBe(200);
      expect(r.body.orgs).toEqual([]);
      const w = await call("sites", "POST", stranger, { body: { orgId: t.org, name: "Intruder", dataOrigin: "test", email: t.owner } });
      expect(w.status).toBe(400);      // an unknown key is refused outright (strict schema)
    });
  });

  function unconfirmedBearerHeader(email: string): Record<string, string> {
    return unconfirmedBearerFor(email);
  }

  // ------------------------------------------------------------------------------------------------- input refusals

  describe("a malformed request is a 400 that names the field and never echoes the value", () => {
    it.each([
      ["a missing organisation name", "orgs", {}],
      ["an empty organisation name", "orgs", { name: "   " }],
      ["an over-long organisation name", "orgs", { name: "x".repeat(121) }],
      ["a key that is not part of the schema", "orgs", { name: "ok", role: "owner" }],
      ["an array instead of an object", "orgs", [1, 2]],
    ])("%s", async (_n, route, body) => {
      const r = await call(route as RouteName, "POST", person("p"), { body });
      expect(r.status).toBe(400);
      expect(r.headers.get("cache-control")).toBe("no-store");
    });

    it("site: no data origin, a wrong data origin, a bad country and a bad organisation id are each refused", async () => {
      const t = await team();
      const base = { orgId: t.org, name: `S ${uid()}`, dataOrigin: "test" };
      for (const bad of [{ dataOrigin: undefined }, { dataOrigin: "demo" }, { dataOrigin: "PRODUCTION" }, { country: "Germany" }, { country: "D1" }, { orgId: "nope" }, { name: "" }]) {
        const r = await call("sites", "POST", t.editor, { body: { ...base, ...bad } });
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.body.issues.length).toBeGreaterThan(0);
      }
    });

    it("member: a bad email and a role outside owner/editor/viewer are refused", async () => {
      const t = await team();
      for (const bad of [{ email: "not-an-email" }, { email: "a b@c.example" }, { role: "admin" }, { role: "OWNER" }, { role: undefined }]) {
        expect((await call("members", "POST", t.owner, { id: t.org, body: { email: person("m"), role: "viewer", ...bad } })).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it("input: every shape the form could get wrong is refused before it reaches the database", async () => {
      const t = await team();
      const ev = "00000000-0000-4000-8000-0000000000ee";
      const bad: Record<string, unknown>[] = [
        { fieldPath: "grid..x" }, { fieldPath: "grid x" }, { fieldPath: "1grid" }, { fieldPath: "grid.x[1234]" }, { fieldPath: "g".repeat(121) },
        { value: [1] }, { value: { a: 1 } }, { value: "" }, { value: 1e16 },
        { unit: "MVA", value: "busway" }, { unit: "MVA;drop" }, { unit: "M\u202eVA" }, { unit: "<b>" },
        { origin: "vendor", evidenceClass: "E5" },                              // a vendor figure with no file: at most E3
        { origin: "observed", evidenceClass: "E4", intakeEvidenceFileId: ev },  // a purchased engagement's file is not reviewable: at most E3
        { evidenceClass: "E8" }, { evidenceClass: "e1" }, { origin: "guess" },
        { asOf: "yesterday" }, { asOf: "2026-02-30" }, { asOf: undefined },
        { supersedes: "not-a-uuid" },
        { origin: "missing" },                                                  // a missing input with a value
        { origin: "missing", value: null, evidenceClass: "E1" },               // ...or above E0
        { value: null },                                                        // a value-less input that is not missing
        { origin: "measured", evidenceClass: "E5" },                            // measured, no source
        { origin: "observed", evidenceClass: "E5" }, { origin: "quotation", evidenceClass: "E5" },
        { origin: "measured", evidenceClass: "E5", projectEvidenceId: ev, intakeEvidenceFileId: ev },   // two sources
        { origin: "assumed", evidenceClass: "E4" }, { origin: "modelled", evidenceClass: "E7" },
      ];
      for (const b of bad) {
        const r = await record(t.editor, t.hall, b);
        expect(r.status, JSON.stringify(b)).toBe(400);
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
      expect((await call("inputs", "GET", t.editor, { id: t.hall })).body.inputs).toEqual([]);     // nothing was written
    });

    it("a body larger than the ceiling is a 413, and an unreadable body a 400", async () => {
      const t = await team();
      expect((await call("orgs", "POST", t.owner, { body: { name: "x", pad: "y".repeat(9000) } })).status).toBe(413);
      const mod = await ROUTES.orgs();
      const res = await mod.POST(new Request(siteUrl("/api/orgs"), { method: "POST", headers: { authorization: `Bearer ${tokenFor(t.owner)}`, "x-forwarded-for": ip, "content-type": "application/json" }, body: "{not json" }));
      expect(res.status).toBe(400);
    });

    it("an id in the path that is not a uuid is a 400 (after the caller is identified)", async () => {
      const who = person("p");
      for (const [route, method] of [["halls", "GET"], ["inputs", "GET"], ["timeline", "GET"], ["members", "GET"]] as const) {
        expect((await call(route, method, who, { id: "not-a-uuid" })).status, route).toBe(400);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------- organisations, members, roles

  describe("organisations, members and roles", () => {
    it("the creator is the owner; the list carries the role and nothing of anyone else's", async () => {
      const a = person("a"), b = person("b");
      const orgA = await mkOrg(a, "Alpha"), orgB = await mkOrg(b, "Beta");
      const la = await call("orgs", "GET", a);
      expect(la.status).toBe(200);
      expect(la.headers.get("cache-control")).toBe("no-store");
      expect(la.body.orgs.map((o: any) => [o.id, o.name, o.role])).toEqual([[orgA, "Alpha", "owner"]]);
      expect(JSON.stringify(la.body)).not.toContain(orgB);
    });

    it("the address is stored lower-cased and a person is found whatever the case they sign in with", async () => {
      const mixed = `Mixed.Case-${uid()}@Registry.Example`;
      const org = await mkOrg(mixed);
      const added = await addMember(mixed, org, `New.Hire-${uid()}@Registry.Example`, "viewer");
      expect(added.status).toBe(201);
      const members = await call("members", "GET", mixed, { id: org });
      expect(members.body.members.map((m: any) => m.email).every((e: string) => e === e.toLowerCase())).toBe(true);
    });

    it("only an owner adds members; an editor and a viewer are refused; a duplicate is a 409", async () => {
      const t = await team();
      expect((await addMember(t.editor, t.org, person("x"), "viewer")).status).toBe(403);
      expect((await addMember(t.viewer, t.org, person("x"), "viewer")).status).toBe(403);
      expect((await addMember(t.owner, t.org, t.editor, "viewer")).status).toBe(409);
      expect((await call("members", "GET", t.viewer, { id: t.org })).status).toBe(200);          // any member may read the roster
    });

    it("a viewer reads but never writes; an editor builds the registry", async () => {
      const t = await team();
      expect((await call("sites", "POST", t.viewer, { body: { orgId: t.org, name: "V", dataOrigin: "test" } })).status).toBe(403);
      expect((await call("halls", "POST", t.viewer, { id: t.site, body: { label: "V" } })).status).toBe(403);
      expect((await record(t.viewer, t.hall)).status).toBe(403);
      expect((await call("sites", "GET", t.viewer)).body.sites.map((s: any) => s.id)).toEqual([t.site]);
      expect((await call("halls", "GET", t.viewer, { id: t.site })).body.halls.map((h: any) => h.id)).toEqual([t.hall]);
      expect((await record(t.editor, t.hall)).status).toBe(201);
    });

    it("the last owner cannot be removed; a second owner can leave; a member can leave on their own; others cannot remove a member", async () => {
      const t = await team();
      const roster = async () => (await call("members", "GET", t.owner, { id: t.org })).body.members as any[];
      const byEmail = async (e: string) => (await roster()).find((m) => m.email === e).id as string;
      const del = (as: string, id: string) => call("members", "DELETE", as, { id: t.org, query: `?id=${id}` });
      const last = await del(t.owner, await byEmail(t.owner));
      expect(last.status).toBe(409);
      expect(last.body.reason).toBe("last_owner");
      expect((await del(t.editor, await byEmail(t.viewer))).status).toBe(403);
      expect((await del(t.viewer, await byEmail(t.viewer))).status).toBe(200);                  // leaving
      expect((await call("sites", "GET", t.viewer)).body.sites).toEqual([]);                     // and the access is gone at once
      const second = person("second");
      await addMember(t.owner, t.org, second, "owner");
      expect((await del(second, await byEmail(second))).status).toBe(200);
      expect((await del(t.owner, await byEmail(t.owner))).body.reason).toBe("last_owner");
    });

    it("a site name is unique per organisation (409), free across organisations; a hall label per site", async () => {
      const t = await team();
      const dup = await call("sites", "POST", t.editor, { body: { orgId: t.org, name: "Dublin Campus", dataOrigin: "test" } });
      expect(dup.status).toBe(201);
      expect((await call("sites", "POST", t.owner, { body: { orgId: t.org, name: "dublin campus", dataOrigin: "test" } })).status).toBe(409);
      const other = person("other");
      const orgB = await mkOrg(other);
      expect((await call("sites", "POST", other, { body: { orgId: orgB, name: "Dublin Campus", dataOrigin: "test" } })).status).toBe(201);
      expect((await call("halls", "POST", t.editor, { id: t.site, body: { label: "Hall 1" } })).status).toBe(201);
      expect((await call("halls", "POST", t.editor, { id: t.site, body: { label: "hall 1" } })).status).toBe(409);
    });

    it("a site says what kind of data it holds, and the listing repeats it", async () => {
      const t = await team();
      await mkSite(t.owner, t.org, "Real asset", "production");
      const sites = (await call("sites", "GET", t.viewer, { query: `?org=${t.org}` })).body.sites as any[];
      expect(sites.find((s) => s.name === "Real asset").dataOrigin).toBe("production");
      expect(sites.every((s) => ["production", "test", "synthetic"].includes(s.dataOrigin))).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------------- isolation

  describe("a member of one organisation reaches nothing of another", () => {
    it("every read and write on B's ids by A's members is a 404 (the answer for an id that does not exist) and carries none of B's data", async () => {
      const a = await team();
      const b = await team();
      const secretSite = await mkSite(b.owner, b.org, `Secret Campus ${SECRET}`);
      const secretHall = await mkHall(b.owner, secretSite, `Secret Hall ${SECRET}`);
      expect((await record(b.owner, secretHall, { fieldPath: "grid.contracted_mw", value: 987.654, unit: "MW" })).status).toBe(201);
      for (const who of [a.owner, a.editor, a.viewer]) {
        const attempts: Res[] = [
          await call("members", "GET", who, { id: b.org }),
          await call("members", "POST", who, { id: b.org, body: { email: who, role: "owner" } }),
          await call("members", "DELETE", who, { id: b.org, query: `?id=${GHOST}` }),
          await call("sites", "GET", who, { query: `?org=${b.org}` }),
          await call("sites", "POST", who, { body: { orgId: b.org, name: "Intruder", dataOrigin: "test" } }),
          await call("halls", "GET", who, { id: secretSite }),
          await call("halls", "POST", who, { id: secretSite, body: { label: "Intruder" } }),
          await call("inputs", "GET", who, { id: secretHall }),
          await call("inputs", "GET", who, { id: secretHall, query: "?history=1" }),
          await record(who, secretHall, { fieldPath: "hall.clear_height_m", unit: "m" }),
          await call("timeline", "GET", who, { id: secretHall }),
          await call("projects", "POST", who, { id: secretHall, body: { projectToken: "0123456789abcdef" } }),
          await call("projects", "DELETE", who, { id: secretHall, query: `?project=${GHOST}` }),
        ];
        for (const r of attempts) {
          expect(r.status).toBe(404);
          expect(r.body).toEqual({ ok: false, error: "No such item.", reason: "not_found" });
          expect(r.headers.get("cache-control")).toBe("no-store");
          expect(JSON.stringify(r.body)).not.toMatch(/Secret|987\.654|SECRET/);
        }
        const mine = await call("sites", "GET", who);
        expect(JSON.stringify(mine.body)).not.toMatch(/Secret|SECRET/);
        expect(mine.body.sites.every((s: any) => s.orgId === a.org)).toBe(true);
      }
      // B's own world is intact
      expect((await call("inputs", "GET", b.owner, { id: secretHall })).body.inputs).toHaveLength(1);
    });

    it("a person who is an editor in A and only a viewer in B has exactly those powers in each", async () => {
      const a = await team();
      const b = await team();
      await addMember(b.owner, b.org, a.editor, "viewer");
      expect((await call("halls", "POST", a.editor, { id: b.site, body: { label: "nope" } })).status).toBe(403);
      expect((await call("halls", "GET", a.editor, { id: b.site })).status).toBe(200);
      expect((await call("halls", "POST", a.editor, { id: a.site, body: { label: `ok ${uid()}` } })).status).toBe(201);
    });

    it("an id that exists in someone else's organisation and an id that exists nowhere get the SAME answer, status and body", async () => {
      const t = await team();
      const other = await team();
      const theirs = { site: other.site, hall: other.hall, org: other.org };
      const pairs: [Res, Res][] = [
        [await call("halls", "GET", t.viewer, { id: theirs.site }), await call("halls", "GET", t.viewer, { id: GHOST })],
        [await call("inputs", "GET", t.viewer, { id: theirs.hall }), await call("inputs", "GET", t.viewer, { id: GHOST })],
        [await call("timeline", "GET", t.viewer, { id: theirs.hall }), await call("timeline", "GET", t.viewer, { id: GHOST })],
        [await call("members", "GET", t.viewer, { id: theirs.org }), await call("members", "GET", t.viewer, { id: GHOST })],
        [await record(t.editor, theirs.hall), await record(t.editor, GHOST)],
        [await call("sites", "POST", t.editor, { body: { orgId: theirs.org, name: "x", dataOrigin: "test" } }), await call("sites", "POST", t.editor, { body: { orgId: GHOST, name: "x", dataOrigin: "test" } })],
      ];
      for (const [real, ghost] of pairs) {
        expect(real.status).toBe(404);
        expect({ status: real.status, body: real.body }).toEqual({ status: ghost.status, body: ghost.body });
      }
    });

    it("a file or an earlier figure that cannot be used has ONE answer, whether it is missing, another hall's or another organisation's", async () => {
      const t = await team();
      const other = await team();
      const otherProject = await seedProject({ as: other.editor, hall: other.hall });
      const theirFile = await seedEvidence(otherProject.id);
      const theirs = (await record(other.editor, other.hall)).body.id as string;
      const mine = (await record(t.editor, t.hall)).body.id as string;
      const answers = [
        await record(t.editor, t.hall, { fieldPath: "hall.a1", origin: "measured", evidenceClass: "E3", projectEvidenceId: theirFile }),
        await record(t.editor, t.hall, { fieldPath: "hall.a2", origin: "measured", evidenceClass: "E3", projectEvidenceId: GHOST }),
        await record(t.editor, t.hall, { fieldPath: "hall.a3", origin: "observed", evidenceClass: "E3", intakeEvidenceFileId: GHOST }),
        await record(t.editor, t.hall, { supersedes: theirs }),
        await record(t.editor, t.hall, { supersedes: GHOST }),
        await record(t.editor, t.hall, { fieldPath: "grid.other", supersedes: mine }),
      ];
      for (const r of answers) expect({ status: r.status, error: r.body.error, reason: r.body.reason }).toEqual({ status: 422, error: "That file or earlier figure cannot be used for this hall.", reason: "invalid_reference" });
    });
  });

  // ------------------------------------------------------------------------------------------------- inputs

  describe("hall inputs: append-only, declared, never overwritten", () => {
    it("a recorded figure is returned with its origin, class, date, unit and who recorded it", async () => {
      const t = await team();
      const r = await record(t.editor, t.hall);
      expect(r.status).toBe(201);
      const got = (await call("inputs", "GET", t.viewer, { id: t.hall })).body;
      expect(got.hall).toMatchObject({ id: t.hall, orgId: t.org, dataOrigin: "synthetic" });
      expect(got.inputs).toEqual([expect.objectContaining({
        id: r.body.id, fieldPath: "grid.firm_capacity_mva", value: 40, unit: "MVA", evidenceClass: "E1", origin: "assumed", asOf: "2026-01-15",
        recordedBy: t.editor, supersedesId: null, superseded: false, source: null,
      })]);
    });

    it("a second record of the same field is refused unless it names what it replaces; a correction keeps the old figure in history", async () => {
      const t = await team();
      const first = (await record(t.editor, t.hall)).body.id as string;
      const again = await record(t.editor, t.hall, { value: 99 });
      expect(again.status).toBe(409);
      expect(again.body.reason).toBe("field_already_recorded");
      expect(again.body.currentId).toBe(first);
      const second = await record(t.editor, t.hall, { value: 42, supersedes: first });
      expect(second.status).toBe(201);
      const cur = (await call("inputs", "GET", t.viewer, { id: t.hall })).body.inputs;
      expect(cur.map((i: any) => i.value)).toEqual([42]);
      const hist = (await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1" })).body;
      expect(hist.history).toBe(true);
      expect(hist.inputs.map((i: any) => [i.value, i.superseded]).sort()).toEqual([[40, true], [42, false]]);
    });

    it("two corrections of one figure cannot both land: the second is a 409 that says who is current", async () => {
      const t = await team();
      const first = (await record(t.editor, t.hall)).body.id as string;
      const win = await record(t.editor, t.hall, { value: 41, supersedes: first });
      const late = await record(t.owner, t.hall, { value: 43, supersedes: first });
      expect(late.status).toBe(409);
      expect(late.body.reason).toBe("superseded");
      expect(late.body.currentId).toBe(win.body.id);
    });

    it("a correction cannot name another field's figure, another hall's, or another organisation's", async () => {
      const t = await team();
      const other = await team();
      const hall2 = await mkHall(t.editor, t.site);
      const mine = (await record(t.editor, t.hall)).body.id as string;
      const theirs = (await record(other.editor, other.hall)).body.id as string;
      for (const r of [
        await record(t.editor, t.hall, { fieldPath: "grid.contracted_mw", unit: "MW", supersedes: mine }),
        await record(t.editor, hall2, { supersedes: mine }),
        await record(t.editor, t.hall, { supersedes: theirs }),
      ]) {
        expect(r.status).toBe(422);
        expect(r.body.reason).toBe("invalid_reference");
      }
    });

    it("a measured figure carries its source and the read shows the file's NAME and review status, never its storage location", async () => {
      const t = await team();
      const proj = await seedProject({ as: t.editor, hall: t.hall });
      const ev = await seedEvidence(proj.id);
      const r = await record(t.editor, t.hall, { origin: "measured", evidenceClass: "E5", projectEvidenceId: ev });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.input).toMatchObject({ origin: "measured", evidenceClass: "E5", source: { kind: "project_evidence", id: ev, reviewStatus: "verified" } });
      const got = (await call("inputs", "GET", t.viewer, { id: t.hall })).body;
      expect(got.inputs[0].source).toEqual({ kind: "project_evidence", id: ev, filename: "connection-agreement.pdf", reviewStatus: "verified" });
      expect(JSON.stringify(got)).not.toMatch(/storage_ref|project-evidence\/|SECRET|sha256/);
    });

    it("a file of a project that is not this hall's, or that was rejected, cannot be cited", async () => {
      const t = await team();
      const elsewhere = await seedProject();                                    // attached to nothing
      const foreign = await team();
      const foreignProject = await seedProject({ as: foreign.editor, hall: foreign.hall });
      const mine = await seedProject({ as: t.editor, hall: t.hall });
      const rejected = await seedEvidence(mine.id, "rejected");
      for (const ev of [await seedEvidence(elsewhere.id), await seedEvidence(foreignProject.id)]) {
        const r = await record(t.editor, t.hall, { origin: "measured", evidenceClass: "E5", projectEvidenceId: ev });
        expect(r.status).toBe(422);
        expect(r.body.reason).toBe("invalid_reference");
      }
      const rej = await record(t.editor, t.hall, { origin: "measured", evidenceClass: "E5", projectEvidenceId: rejected });
      expect(rej.status).toBe(422);
      expect(rej.body.reason).toBe("source_rejected");
    });

    it("an input recorded as missing is returned as missing: no value, no source, class E0", async () => {
      const t = await team();
      expect((await record(t.editor, t.hall, { origin: "missing", value: null, unit: "MVA", evidenceClass: "E0" })).status).toBe(201);
      const i = (await call("inputs", "GET", t.viewer, { id: t.hall })).body.inputs[0];
      expect(i).toMatchObject({ origin: "missing", value: null, evidenceClass: "E0", source: null, unit: "MVA" });
    });

    it("a declared class above E3 needs a reviewed, verified project file; an unreviewed one supports E3", async () => {
      const t = await team();
      const proj = await seedProject({ as: t.editor, hall: t.hall });
      const unreviewed = await seedEvidence(proj.id, "unverified");
      const refused = await record(t.editor, t.hall, { origin: "measured", evidenceClass: "E4", projectEvidenceId: unreviewed });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/reviewed and verified/);
      const e3 = await record(t.editor, t.hall, { origin: "measured", evidenceClass: "E3", projectEvidenceId: unreviewed, fieldPath: "grid.contracted_mw", unit: "MW" });
      expect(e3.status, JSON.stringify(e3.body)).toBe(201);
      expect(e3.body.input.source.reviewStatus).toBe("unverified");
      const verified = await record(t.editor, t.hall, { origin: "vendor", evidenceClass: "E6", projectEvidenceId: await seedEvidence(proj.id), fieldPath: "hall.vv" });
      expect(verified.status).toBe(201);
    });

    it("a field is lower-cased: two spellings are one field", async () => {
      const t = await team();
      expect((await record(t.editor, t.hall, { fieldPath: "Grid.Firm_Capacity_MVA" })).body.input.fieldPath).toBe("grid.firm_capacity_mva");
      const again = await record(t.editor, t.hall, { fieldPath: "GRID.firm_capacity_mva", value: 41 });
      expect(again.status).toBe(409);
      expect(again.body.reason).toBe("field_already_recorded");
    });

    it("the history of one field is asked for with ?history=1&field= and is newest first and bounded", async () => {
      const t = await team();
      const a = (await record(t.editor, t.hall, { value: 1 })).body.id as string;
      const b = (await record(t.editor, t.hall, { value: 2, supersedes: a })).body.id as string;
      await record(t.editor, t.hall, { value: 3, supersedes: b });
      await record(t.editor, t.hall, { fieldPath: "grid.contracted_mw", unit: "MW" });
      const h = (await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1&field=Grid.Firm_Capacity_MVA" })).body;
      expect(h.inputs.map((i: any) => [i.value, i.superseded])).toEqual([[3, false], [2, true], [1, true]]);
      expect(h.truncated).toBe(false);
      const cut = (await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1&limit=2" })).body;
      expect(cut.inputs).toHaveLength(2);
      expect(cut.truncated).toBe(true);
      expect((await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1&field=not%20a%20path" })).status).toBe(400);
    });

    it("a hall holds at most 50 values per field: the 51st is a 409 that says so", async () => {
      const t = await team();
      let prev = (await record(t.editor, t.hall, { value: 0 })).body.id as string;
      for (let i = 1; i < 50; i++) prev = (await record(t.editor, t.hall, { value: i, supersedes: prev })).body.id as string;
      const r = await record(t.editor, t.hall, { value: 99, supersedes: prev });
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("correction_limit");
    }, 120_000);

    it("names and labels with direction-changing or zero-width characters are refused, and surrounding no-break spaces are stripped", async () => {
      const t = await team();
      for (const bad of ["\u202eevil", "a\u200bb", "x\u2066y"]) {
        expect((await call("orgs", "POST", t.owner, { body: { name: bad } })).status, bad).toBe(400);
        expect((await call("halls", "POST", t.editor, { id: t.site, body: { label: bad } })).status, bad).toBe(400);
      }
      const r = await call("halls", "POST", t.editor, { id: t.site, body: { label: "\u00a0Hall Z\u00a0" } });
      expect(r.status).toBe(201);
      expect(r.body.hall.label).toBe("Hall Z");
    });

    it("text and true/false values are accepted for fields that are not quantities", async () => {
      const t = await team();
      expect((await record(t.editor, t.hall, { fieldPath: "lv.busway", value: "present", unit: undefined, origin: "vendor" })).status).toBe(201);
      expect((await record(t.editor, t.hall, { fieldPath: "thermal.has_cdu", value: true, unit: undefined, origin: "vendor" })).status).toBe(201);
    });
  });

  // ------------------------------------------------------------------------------------------------- projects and the timeline

  describe("projects attach to a hall and the timeline shows what happened there", () => {
    it("attaching needs the project's link token, which is never returned; a project belongs to one hall", async () => {
      const t = await team();
      const hall2 = await mkHall(t.editor, t.site);
      const proj = await seedProject();
      const ok = await call("projects", "POST", t.editor, { id: t.hall, body: { projectToken: proj.token } });
      expect(ok.status).toBe(201);
      expect(JSON.stringify(ok.body)).not.toContain(proj.token);
      expect(ok.body).toMatchObject({ ok: true, projectId: proj.id, alreadyAttached: false });
      const again = await call("projects", "POST", t.owner, { id: t.hall, body: { projectToken: proj.token } });
      expect(again.status).toBe(200);
      expect(again.body.alreadyAttached).toBe(true);
      const other = await call("projects", "POST", t.editor, { id: hall2, body: { projectToken: proj.token } });
      expect(other.status).toBe(409);
      expect(other.body.reason).toBe("project_in_other_hall");
      expect((await call("projects", "POST", t.editor, { id: t.hall, body: { projectToken: "this-token-does-not-exist" } })).status).toBe(404);
      expect((await call("projects", "POST", t.viewer, { id: hall2, body: { projectToken: "this-token-does-not-exist" } })).status).toBe(403);   // a member without the role
    });

    it("an owner detaches a project; an editor cannot; the timeline stops showing its log, keeps the fact of both, and the project can go to another hall", async () => {
      const t = await team();
      const hall2 = await mkHall(t.editor, t.site);
      const proj = await seedProject({ as: t.editor, hall: t.hall });
      await rest("POST", "project_events", { project_id: proj.id, event_type: "project_created", actor: "e@a.example", occurred_at: "2026-01-10T09:00:00Z" });
      const kinds = async (hall: string) => ((await call("timeline", "GET", t.viewer, { id: hall })).body.events as any[]).map((e) => e.kind).sort();
      expect(await kinds(t.hall)).toEqual(["project_attached", "project_event"]);
      expect((await call("projects", "DELETE", t.editor, { id: t.hall, query: `?project=${proj.id}` })).status).toBe(403);
      expect((await call("projects", "DELETE", t.owner, { id: t.hall, query: "?project=not-a-uuid" })).status).toBe(400);
      expect((await call("projects", "DELETE", t.owner, { id: t.hall, query: `?project=${GHOST}` })).status).toBe(404);
      const d = await call("projects", "DELETE", t.owner, { id: t.hall, query: `?project=${proj.id}` });
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(await kinds(t.hall)).toEqual(["project_attached", "project_detached"]);
      expect((await call("projects", "DELETE", t.owner, { id: t.hall, query: `?project=${proj.id}` })).status).toBe(404);
      expect((await call("projects", "POST", t.editor, { id: hall2, body: { projectToken: proj.token } })).status).toBe(201);
      expect(await kinds(hall2)).toContain("project_event");
      const log = await rest<any[]>("GET", `project_events?project_id=eq.${proj.id}&select=event_type,actor,payload`);
      const types = ((log as any).data as any[]).map((e) => e.event_type);
      expect(types).toEqual(expect.arrayContaining(["project_attached_to_hall", "project_detached_from_hall"]));
      expect(JSON.stringify((log as any).data)).not.toContain(t.editor);
    });

    it("the timeline shows the hall's figures and its attached projects' log, newest first, labelled, with no token or payload", async () => {
      const t = await team();
      const proj = await seedProject({ as: t.editor, hall: t.hall });
      const log = await rest("POST", "project_events", { project_id: proj.id, event_type: "project_created", actor: "engineer@a.example", occurred_at: "2026-01-10T09:00:00Z", payload: { case_token: SECRET } });
      expect(log.ok).toBe(true);
      expect((await record(t.editor, t.hall)).status).toBe(201);
      const r = await call("timeline", "GET", t.viewer, { id: t.hall });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const kinds = r.body.events.map((e: any) => e.kind);
      expect([...kinds].sort()).toEqual(["input_recorded", "project_attached", "project_event"]);
      expect(kinds[2]).toBe("project_event");                                       // the attachment and the input were made now; the log entry is from January
      const times = r.body.events.map((e: any) => e.occurredAt);
      expect(times).toEqual([...times].sort().reverse());
      for (const e of r.body.events) expect(e.basis).toBeTruthy();
      expect(r.body.events[2]).toMatchObject({ origin: "recorded", evidenceClass: null, projectId: proj.id });
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(proj.token);
      expect(text).not.toMatch(/payload|storage_ref|project_token|case_token/);
    });

    it("a project of another hall never appears on this hall's timeline", async () => {
      const t = await team();
      const hall2 = await mkHall(t.editor, t.site);
      const p2 = await seedProject({ as: t.editor, hall: hall2 });
      await rest("POST", "project_events", { project_id: p2.id, event_type: "project_created", actor: "x@a.example" });
      const mine = (await call("timeline", "GET", t.viewer, { id: t.hall })).body.events;
      expect(mine).toEqual([]);
      const second = await call("timeline", "GET", t.viewer, { id: hall2 });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(second.body.events.filter((e: any) => e.kind === "project_event")).toHaveLength(1);
    });

    it("walking the whole timeline by nextCursor yields every event exactly once, whatever the page size, even with equal timestamps", async () => {
      const t = await team();
      const proj = await seedProject({ as: t.editor, hall: t.hall });
      for (let i = 0; i < 6; i++) await rest("POST", "project_events", { project_id: proj.id, event_type: "evidence_attached", actor: "x@a.example", occurred_at: "2026-01-10T09:00:00.000000Z" });
      for (let i = 0; i < 3; i++) await rest("POST", "project_events", { project_id: proj.id, event_type: "evidence_attached", actor: "x@a.example", occurred_at: `2026-01-11T09:00:00.00000${i}Z` });
      expect((await record(t.editor, t.hall)).status).toBe(201);
      const all = (await call("timeline", "GET", t.viewer, { id: t.hall, query: "?limit=500" })).body;
      expect(all.truncated).toBe(false);
      expect(all.nextCursor).toBeNull();
      expect(all.events).toHaveLength(11);                       // attachment, input, nine log lines
      for (const size of [1, 2, 3, 4, 7]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 40; guard++) {
          const page: Res = await call("timeline", "GET", t.viewer, { id: t.hall, query: `?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` });
          expect(page.status).toBe(200);
          seen.push(...page.body.events.map((e: any) => `${e.sourceTable}|${e.sourceId}|${e.subject}`));
          if (!page.body.truncated) { expect(page.body.nextCursor).toBeNull(); break; }
          expect(typeof page.body.nextCursor).toBe("string");
          cursor = page.body.nextCursor;
        }
        expect(seen).toHaveLength(11);
        expect(new Set(seen).size).toBe(11);
        expect(seen).toEqual(all.events.map((e: any) => `${e.sourceTable}|${e.sourceId}|${e.subject}`));
      }
    });

    it("a cursor that is not ours is a 400, and the old ?before= is not a thing", async () => {
      const t = await team();
      for (const c of ["x", "not-json-at-all", "[]", "{}", encodeURIComponent('{"occurred_at":"nope","source_table":"a","source_id":"b","subject":"c"}')]) {
        expect((await call("timeline", "GET", t.viewer, { id: t.hall, query: `?cursor=${c}` })).status, c).toBe(400);
      }
      expect((await call("timeline", "GET", t.viewer, { id: t.hall, query: "?before=yesterday" })).status).toBe(200);   // ignored
    });
  });
}
