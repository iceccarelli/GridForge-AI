/**
 * POST /api/halls/[id]/diff - the engine-backed capacity diff - as a CALLER meets it, against the REAL Python engine (spawned, not stubbed; tests/site/_engine-guard.ts
 * makes a missing python3 a failure where CI requires the engine), on a synthetic reference hall. Written once and run against two backends, like the registry's own scenarios:
 *
 *   tests/site/site-registry.test.ts           an in-memory PostgREST that mirrors the SQL (runs anywhere; SUPPLEMENTAL)
 *   tests/site/site-registry.realdb.test.ts    REAL PostgreSQL through REAL PostgREST (the proof the route and the functions agree)
 *
 * Everything goes through the route handlers and the real data layer. Stubbed: Supabase Auth's /auth/v1/user, and (for the cases that need an engine that is down,
 * lacks the route, or answers badly) the engine's HTTP answer. Nothing else.
 */
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { rest } from "@/lib/pgrest";
import { RATE_POLICIES, accountSubject, subjectOf } from "@/lib/rate-limit";
import { installAuth, tokenFor, unconfirmedBearerFor } from "./auth-fake";
import { engineAvailable } from "./_engine-guard";
import { RECORDED_MINIMUM } from "@/lib/site-registry-engine";
import { REFERENCE_HALL, type RefFigure } from "./site-registry-reference-hall";
import type { Backend } from "./site-registry-scenarios";

const ROOT = path.resolve(__dirname, "../..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "registry-engine-diff-scenarios-key";
const realFetch = globalThis.fetch;
const uid = () => crypto.randomBytes(5).toString("hex");
const GHOST = "00000000-0000-4000-8000-00000000dead";
const SECRET = `SECRET-${uid()}-do-not-leak`;

type Res = { status: number; body: any; headers: Headers };
type Mode = "real" | "down" | "missing" | "garbage" | "refuse" | "old";

/** A backend may also be able to move the time a claim was recorded (the in-memory store can; a real database's rows are append-only), for the days-apart scenarios. */
export interface EngineBackend extends Backend {
  backdate?(recordedAt: string): void;
}

export function defineEngineDiffScenarios(backend: EngineBackend): void {
  let engine: ChildProcess | null = null;
  let ENGINE = "";
  let mode: Mode = "real";
  let engineCalls: { path: string; body: any }[] = [];
  let restore: () => void;
  let ip: string;

  beforeAll(async () => {
    if (!hasPython) return;
    const code = [
      "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
      "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0", "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
    ].join("\n");
    engine = spawn("python3", ["-c", code], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    ENGINE = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
      engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
    });
  }, 30_000);
  afterAll(() => engine?.kill());

  beforeEach(async () => {
    const undoBackend = await backend.install();
    const auth = installAuth();
    const layered = globalThis.fetch;
    mode = "real";
    engineCalls = [];
    process.env.GRIDFORGE_API_URL = ENGINE;
    process.env.GRIDFORGE_API_KEY = KEY;
    // The store (fake or real) answers everything but the engine; the engine's URL is routed to the real engine, or to a stand-in for the cases that need one that misbehaves.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!ENGINE || !url.startsWith(ENGINE)) return layered(input, init);
      const p = new URL(url).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (p === "/v1/diff") engineCalls.push({ path: p, body });
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (p === "/v1/diff") {
        if (mode === "down") throw new TypeError("fetch failed");
        if (mode === "missing") return json(404, { error: "not found", endpoints: ["/v1/qualify", "/v1/screen"] });
        if (mode === "garbage") return json(200, { surprise: true });
        if (mode === "refuse") return json(422, { error: "unknown platform 'warp_drive'. Available: gb200_nvl72, gb300_nvl72" });
        if (mode === "old" && body && "cost_evidence" in body) return json(422, { error: "/v1/diff does not take cost_evidence" });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    restore = () => { globalThis.fetch = layered; auth.restore(); undoBackend(); };
    ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  });
  afterEach(() => restore());

  // ------------------------------------------------------------------------------------------------- helpers

  const person = (n: string) => `${n}-${uid()}@registry.example`;
  const today = () => new Date().toISOString().slice(0, 10);

  async function route(name: "orgs" | "members" | "sites" | "halls" | "inputs" | "projects" | "diff") {
    switch (name) {
      case "orgs": return import("@/app/api/orgs/route");
      case "members": return import("@/app/api/orgs/[id]/members/route");
      case "sites": return import("@/app/api/sites/route");
      case "halls": return import("@/app/api/sites/[id]/halls/route");
      case "inputs": return import("@/app/api/halls/[id]/inputs/route");
      case "projects": return import("@/app/api/halls/[id]/projects/route");
      case "diff": return import("@/app/api/halls/[id]/diff/route");
    }
  }
  const PATH = { orgs: () => "/api/orgs", members: (id: string) => `/api/orgs/${id}/members`, sites: () => "/api/sites", halls: (id: string) => `/api/sites/${id}/halls`, inputs: (id: string) => `/api/halls/${id}/inputs`, projects: (id: string) => `/api/halls/${id}/projects`, diff: (id: string) => `/api/halls/${id}/diff` };

  async function call(name: keyof typeof PATH, method: string, as: string | { raw: Record<string, string> } | undefined, opts: { id?: string; body?: unknown; rawBody?: string; query?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = { "x-forwarded-for": ip };
    if (typeof as === "string") headers.authorization = `Bearer ${tokenFor(as)}`;
    else if (as) Object.assign(headers, as.raw);
    const text = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    if (text !== undefined) headers["content-type"] = "application/json";
    const mod = (await route(name)) as unknown as Record<string, (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>>;
    const id = opts.id ?? GHOST;
    const res = await mod[method]!(new Request(siteUrl(PATH[name](id) + (opts.query ?? "")), { method, headers, body: text }), { params: Promise.resolve({ id }) });
    const t = await res.text();
    let body: any = null;
    try { body = t ? JSON.parse(t) : null; } catch { body = t; }
    return { status: res.status, body, headers: res.headers };
  }
  const diff = (as: string | undefined, hall: string, from: unknown, to: unknown) => call("diff", "POST", as, { id: hall, body: { from, to } });

  async function team() {
    const owner = person("owner"), editor = person("editor"), viewer = person("viewer");
    const org = (await call("orgs", "POST", owner, { body: { name: `Org ${uid()}` } })).body.org.id as string;
    expect((await call("members", "POST", owner, { id: org, body: { email: editor, role: "editor" } })).status).toBe(201);
    expect((await call("members", "POST", owner, { id: org, body: { email: viewer, role: "viewer" } })).status).toBe(201);
    const site = (await call("sites", "POST", editor, { body: { orgId: org, name: `Site ${uid()}`, country: "DE", dataOrigin: "synthetic" } })).body.site.id as string;
    const hall = (await call("halls", "POST", editor, { id: site, body: { label: `Hall ${uid()}` } })).body.hall.id as string;
    return { owner, editor, viewer, org, site, hall };
  }

  /** A project the hall owns, with a reviewed and verified file (the way production gets one, 0048), carrying a storage reference that must never come back. */
  async function verifiedFile(t: { editor: string; hall: string }, review: "verified" | "rejected" | "unverified" = "verified") {
    const token = `tok-${uid()}${uid()}`;
    const p = await rest<any[]>("POST", "projects", { project_token: token, project_name: "North hall build" });
    expect(p.ok, JSON.stringify(p)).toBe(true);
    const projectId = (p as any).data[0].id as string;
    expect((await call("projects", "POST", t.editor, { id: t.hall, body: { projectToken: token } })).status).toBe(201);
    const sha = uid().repeat(7).slice(0, 64).padEnd(64, "a");
    const e = await rest<any[]>("POST", "project_evidence", {
      project_id: projectId, filename: "nameplate.pdf", media_type: "application/pdf", sha256: sha, byte_size: 100, storage_ref: `project-evidence/${SECRET}`, review_status: "unverified",
    });
    expect(e.ok, JSON.stringify(e)).toBe(true);
    const id = (e as any).data[0].id as string;
    if (review !== "unverified") {
      const r = await rest("POST", "rpc/gf_review_evidence", {
        p: { evidence_id: id, decision: review, reviewer: "F. Keane", reason: "checked against the stored object", ...(review === "verified" ? { sha256_confirmed: sha } : {}) },
        p_event: { event_type: "evidence_reviewed", actor: "reviewer@desk.example", payload: {} },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    return { projectId, token, evidenceId: id };
  }

  const body = (f: RefFigure, over: Record<string, unknown> = {}) => ({
    fieldPath: f.fieldPath, value: f.value, unit: f.unit, evidenceClass: f.evidenceClass, origin: f.origin, asOf: "2026-01-15", ...over,
  });
  const record = (as: string, hall: string, f: Partial<RefFigure> & { fieldPath: string }, over: Record<string, unknown> = {}) =>
    call("inputs", "POST", as, { id: hall, body: { value: null, unit: null, evidenceClass: "E1", origin: "assumed", asOf: "2026-01-15", ...f, ...over } });

  /** Record the whole reference hall, citing one verified file for the figures that need it. Returns what the hall needs to be asked about. */
  async function recordReference(t: { editor: string; hall: string }, drop: string[] = []) {
    const file = await verifiedFile(t);
    const ids = new Map<string, string>();
    for (const f of REFERENCE_HALL) {
      if (drop.includes(f.fieldPath)) continue;
      const r = await call("inputs", "POST", t.editor, { id: t.hall, body: body(f, f.file ? { projectEvidenceId: file.evidenceId } : {}) });
      expect(r.status, `${f.fieldPath}: ${JSON.stringify(r.body)}`).toBe(201);
      ids.set(f.fieldPath, r.body.id);
    }
    return { ...file, ids };
  }
  const correct = (as: string, hall: string, ids: Map<string, string>, fieldPath: string, over: Record<string, unknown>) => {
    const f = REFERENCE_HALL.find((x) => x.fieldPath === fieldPath)!;
    return call("inputs", "POST", as, { id: hall, body: { ...body(f), supersedes: ids.get(fieldPath), ...over } });
  };
  const row = (cells: Record<string, unknown>, n = 1) => ({ n, fromCsv: false, cells });

  /** Hits counted in a bucket for one subject (the database is shared by every test of a file, so a count is always for one account or one hall). */
  const spent = (bucket: string, email: string) => hits(bucket, accountSubject(email));
  const spentHall = (hall: string) => hits("registry_diff_hall", subjectOf(`hall-diff:${hall}`));
  const hits = async (bucket: string, subject?: string | null) => {
    const r = await rest<any[]>("GET", `rate_limit_windows?bucket=eq.${bucket}&select=hits${subject ? `&subject=eq.${subject}` : ""}`);
    expect(r.ok).toBe(true);
    return ((r as any).data as { hits: number }[]).reduce((n, x) => n + x.hits, 0);
  };
  const spend = async (bucket: string, subject: string, times: number, limit: number, windowSeconds: number) => {
    for (let i = 0; i < times; i++) expect((await rest("POST", "rpc/gf_rate_limit_hit", { p_bucket: bucket, p_subject: subject, p_limit: limit, p_window_seconds: windowSeconds })).ok).toBe(true);
  };

  const WHITELIST_TOP = ["ok", "ran", "reason", "message", "hall", "from", "to", "label", "units", "historyTruncated", "missing", "classNotes", "placeholders", "notUsed", "ceiling", "classChanges", "engine", "diff", "carriedBy"];
  const WHITELIST_DIFF = ["headline", "material", "racksDelta", "explainedRacks", "unexplainedRacks", "before", "after", "bindingMoved", "racksClass", "drivers", "weeks", "inputs", "notAttributed"];

  // ------------------------------------------------------------------------------------------------- the door and the hall

  describe("POST /api/halls/{id}/diff: who may ask", () => {
    it("no token -> 401, a forged token -> 401, an unconfirmed address -> 403, each no-store; an unconfigured store is a 503", async () => {
      const ok = { from: { now: true }, to: { asOf: "2026-01-01" } };
      const none = await call("diff", "POST", undefined, { body: ok });
      const forged = await call("diff", "POST", { raw: { authorization: "Bearer forged.jwt.value" } }, { body: ok });
      const unconfirmed = await call("diff", "POST", { raw: unconfirmedBearerFor(person("unconfirmed")) }, { body: ok });
      expect([none.status, forged.status, unconfirmed.status]).toEqual([401, 401, 403]);
      expect(unconfirmed.body.error).toBe("Confirm your email address by signing in with the emailed link, then try again.");
      for (const r of [none, forged, unconfirmed]) expect(r.headers.get("cache-control")).toBe("no-store");
      const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      try {
        const r = await call("diff", "POST", person("anyone"), { body: ok });
        expect(r.status).toBe(503);
        expect(r.headers.get("cache-control")).toBe("no-store");
      } finally { process.env.SUPABASE_URL = url; process.env.SUPABASE_SERVICE_ROLE_KEY = key; }
      expect(engineCalls).toEqual([]);
    });

    it("a non-member gets exactly the answer for a hall that does not exist - status, body and headers - with no engine call and nothing counted against anyone", async () => {
      const t = await team();
      await recordReference(t);
      const stranger = person("stranger");
      const probe = { from: { now: true }, to: { asOf: "2026-01-01" } };
      const real = await diff(stranger, t.hall, probe.from, probe.to);
      const ghost = await diff(stranger, GHOST, probe.from, probe.to);
      expect(real.status).toBe(404);
      expect(ghost.status).toBe(404);
      expect(real.body).toEqual(ghost.body);
      expect(real.body).toEqual({ ok: false, error: "No such item.", reason: "not_found" });
      expect(real.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(real.body)).not.toMatch(/Hall|Site|Org|reference/i);
      expect(engineCalls).toEqual([]);
      expect(await spent("registry_diff", stranger)).toBe(0);
      expect(await spentHall(t.hall)).toBe(0);
    });

    it("a member of ANOTHER organisation is a stranger too, even one with a hall of their own", async () => {
      const mine = await team(), theirs = await team();
      await recordReference(theirs);
      const r = await diff(mine.owner, theirs.hall, { now: true }, { asOf: "2026-01-01" });
      const ghost = await diff(mine.owner, GHOST, { now: true }, { asOf: "2026-01-01" });
      expect(r.status).toBe(404);
      expect(r.body).toEqual(ghost.body);
      expect(engineCalls).toEqual([]);
    });

    it("a viewer may ask (it reads, it writes nothing), and so may an editor and an owner", async () => {
      const t = await team();
      await recordReference(t);
      for (const who of [t.viewer, t.editor, t.owner]) {
        const r = await diff(who, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.ran).toBe(true);
      }
      expect(engineCalls).toHaveLength(3);
    });

    it("an id in the path that is not a uuid is a 400, after the caller is identified", async () => {
      const r = await call("diff", "POST", person("p"), { id: "not-a-uuid", body: { from: { now: true }, to: { asOf: "2026-01-01" } } });
      expect(r.status).toBe(400);
    });
  });

  describe("a malformed request is a 400 that spends nothing", () => {
    const ok = { from: { now: true }, to: { asOf: "2026-01-01" } };
    it.each([
      ["no body", undefined],
      ["not json", "{nope"],
      ["an extra key", { ...ok, email: "x@y.example" }],
      ["a missing side", { from: { now: true } }],
      ["a point with two kinds", { from: { now: true, asOf: "2026-01-01" }, to: { now: true } }],
      ["now: false", { from: { now: false }, to: { asOf: "2026-01-01" } }],
      ["the same point twice (now)", { from: { now: true }, to: { now: true } }],
      ["the same day twice", { from: { asOf: "2026-01-01" }, to: { asOf: "2026-01-01" } }],
      ["a date that does not exist", { from: { asOf: "2026-02-30" }, to: { now: true } }],
      ["a date written another way", { from: { asOf: "01/02/2026" }, to: { now: true } }],
      ["a day that has not happened yet", { from: { asOf: "2999-01-01" }, to: { now: true } }],
      ["a day before the registry's earliest", { from: { asOf: "1989-12-31" }, to: { now: true } }],
      ["an empty pending import", { from: { now: true }, to: { proposed: [] } }],
      ["a pending import of 201 rows", { from: { now: true }, to: { proposed: Array.from({ length: 201 }, (_, i) => row({ field_path: "grid.contracted_mw" }, i + 1)) } }],
      ["a pending row with a key that is not an import column", { from: { now: true }, to: { proposed: [{ cells: { field_path: "a", bogus: 1 } }] } }],
      ["a pending row cell that is an object", { from: { now: true }, to: { proposed: [row({ field_path: { a: 1 } })] } }],
    ])("%s", async (_n, b) => {
      const t = await team();
      const r = typeof b === "string" ? await call("diff", "POST", t.viewer, { id: t.hall, rawBody: b }) : b === undefined ? await call("diff", "POST", t.viewer, { id: t.hall }) : await call("diff", "POST", t.viewer, { id: t.hall, body: b });
      expect(r.status).toBe(400);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.body.ok).toBe(false);
      expect(JSON.stringify(r.body)).not.toMatch(/x@y\.example/);
      expect(engineCalls).toEqual([]);
      expect(await spent("registry_diff", t.viewer)).toBe(0);
    });

    it("a body over the ceiling is a 413", async () => {
      const t = await team();
      const r = await call("diff", "POST", t.viewer, { id: t.hall, body: { ...ok, pad: "y".repeat(170 * 1024) } });
      expect(r.status).toBe(413);
      expect(engineCalls).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------- what is missing

  describe("figures the engine needs that are not recorded", () => {
    it("are named, with a reason, and the engine is NOT called and nothing is counted or charged", async () => {
      const t = await team();
      await record(t.editor, t.hall, { fieldPath: "grid.firm_capacity_mva", value: 14, unit: "MVA", evidenceClass: "E1" });
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.firm_capacity_mva", value: 9, unit: "MVA", origin: "assumed", class: "E1", as_of: "2026-02-01" })] });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, ran: false, reason: "missing", units: 0 });
      expect(r.body.message).toMatch(/engine was not run.*no units were used/);
      const paths = r.body.missing.map((m: any) => m.path);
      expect(paths).toEqual(expect.arrayContaining(["compute.platform", "transformers[0].unit_rating_mva", "transformers[0].units", "ups[0].redundancy", "hall.rack_positions", "grid.contracted_mw", "hall.positions_available"]));
      expect(paths).not.toContain("grid.firm_capacity_mva");
      const platform = r.body.missing.find((m: any) => m.path === "compute.platform");
      expect(platform).toMatchObject({ label: "Target platform", sides: ["from", "to"], need: "engine_required", inTemplate: false, reason: "It is not recorded." });
      expect(r.body.missing.find((m: any) => m.path === "hall.rack_positions")).toMatchObject({ need: "no_gap_default", inTemplate: true });
      expect(r.body).not.toHaveProperty("diff");
      expect(engineCalls).toEqual([]);
      expect(await spent("registry_diff", t.viewer)).toBe(0);
      expect(await spentHall(t.hall)).toBe(0);
    });

    it("a hall with nothing recorded is missing the whole minimum; a day before anything was recorded is the same, and says what was asked", async () => {
      const t = await team();
      const r = await diff(t.viewer, t.hall, { asOf: "2020-01-01" }, { now: true });
      expect(r.body).toMatchObject({ ran: false, reason: "missing", from: { kind: "asOf", asOf: "2020-01-01" }, to: { kind: "now", asOf: today() } });
      expect(r.body.missing.map((m: any) => m.path).sort()).toEqual([...RECORDED_MINIMUM].sort());
    });

    it("a rating that is only an assumption is not sent either, because the engine would read it as customer data: it is missing, with that reason", async () => {
      const t = await team();
      await recordReference(t);
      const ids = new Map<string, string>(((await call("inputs", "GET", t.viewer, { id: t.hall })).body.inputs as any[]).map((i) => [i.fieldPath, i.id]));
      expect((await correct(t.editor, t.hall, ids, "transformers[0].unit_rating_mva", { origin: "assumed", evidenceClass: "E3", projectEvidenceId: null })).status).toBe(201);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] });
      expect(r.body).toMatchObject({ ran: false, reason: "missing" });
      expect(r.body.missing.map((m: any) => m.path)).toEqual(["transformers[0].unit_rating_mva"]);
      expect(r.body.missing[0].reason).toMatch(/reads this figure as E5 whatever class is sent/);
      expect(engineCalls).toEqual([]);
    });

    it("two points that hold the same figures are not sent to the engine at all", async () => {
      const t = await team();
      await recordReference(t);
      const r = await diff(t.viewer, t.hall, { asOf: today() }, { now: true });
      expect(r.body).toMatchObject({ ran: false, reason: "identical", units: 0 });
      expect(r.body.message).toMatch(/the same at these two points/);
      expect(engineCalls).toEqual([]);
      expect(await spent("registry_diff", t.viewer)).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------- the engine's answer

  describe.runIf(hasPython)("the engine's answer on the reference hall", () => {
    it("a pending change to the firm capacity: the engine attributes it to that input, with the recorder's declaration, the engine's build, and what the weeks rest on", async () => {
      const t = await team();
      await recordReference(t);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.firm_capacity_mva", value: 9, unit: "MVA", origin: "assumed", class: "E1", as_of: "2026-02-01" })] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      const b = r.body;
      expect(b).toMatchObject({ ok: true, ran: true, units: 2, hall: { id: t.hall }, from: { kind: "now" }, to: { kind: "proposed", rows: { used: 1, unchanged: 0, excluded: [] } }, missing: [] });
      expect(b.label).toBe("Modelled by the engine from the figures as recorded; origin and class are the recorder's declaration. Not a measurement.");
      expect(b.engine).toMatchObject({ version: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(b.diff.drivers.map((d: any) => [d.path, d.label, d.before, d.after])).toEqual([["grid.firm_capacity_mva", "Firm connection capacity", 14, 9]]);
      expect(b.diff.racksDelta).toBe(b.diff.explainedRacks + b.diff.unexplainedRacks);
      expect(b.diff.drivers[0].direction).toBe(b.diff.racksDelta < 0 ? "lowers" : b.diff.racksDelta > 0 ? "raises" : "no change");
      expect(typeof b.diff.headline).toBe("string");
      expect(b.diff.weeks.label.length).toBeGreaterThan(5);
      if (b.diff.weeks.delta !== null) expect(["assumed", "supported"]).toContain(b.diff.weeks.basis);
      expect(b.carriedBy).toMatch(/^E[0-5]$/);
      expect(b.ceiling.cls).toBe("E1");
      expect(Number(b.carriedBy.slice(1))).toBeLessThanOrEqual(1);          // counts and names carry no class: the answer is held to the weakest of them
      expect(b.placeholders.map((p: any) => p.path)).toEqual(expect.arrayContaining(["economics.electricity_eur_per_mwh", "lv.existing_busway_load_kw"]));
      expect(await spent("registry_diff", t.viewer)).toBe(1);
      expect(await hits("registry_diff", subjectOf(ip))).toBe(0);                                  // counted per verified ACCOUNT, never per address (an office behind one NAT)
      expect(await spentHall(t.hall)).toBe(1);
      expect(engineCalls).toHaveLength(1);
    });

    it("the response holds only what is whitelisted: no project link token, storage reference, file name or address, and no key the page does not read", async () => {
      const t = await team();
      const file = await recordReference(t);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] });
      expect(r.body.ran).toBe(true);
      const text = JSON.stringify(r.body);
      for (const secret of [SECRET, file.token, "nameplate.pdf", "project-evidence", t.editor, t.owner, t.viewer, "registry.example"]) expect(text, secret).not.toContain(secret);
      expect(text).not.toMatch(/@/);
      for (const k of Object.keys(r.body)) expect(WHITELIST_TOP, k).toContain(k);
      for (const k of Object.keys(r.body.diff)) expect(WHITELIST_DIFF, k).toContain(k);
      for (const k of Object.keys(r.body.diff.before)) expect(["racksAsFound", "racksAfterLadder", "bindingName", "bindingBasis", "scenario"], k).toContain(k);
      expect(text).not.toMatch(/capex_|capexEur|intake_digest|price_basis|storage_ref|project_token|"digest":"[0-9a-f]{16}"/i);
    });

    it("a class the registry cannot stand behind is held down on the way to the engine, and named: E6 on a verified file goes as E5; E5 on a file the preview cannot see goes as E3", async () => {
      const t = await team();
      const file = await recordReference(t);
      // a vendor figure may be declared E6 on a verified file (the registry allows it); the engine takes a declared class up to E5
      expect((await call("inputs", "POST", t.editor, { id: t.hall, body: { fieldPath: "grid.power_factor", value: 0.96, unit: null, evidenceClass: "E6", origin: "vendor", asOf: "2026-01-16", projectEvidenceId: file.evidenceId, supersedes: file.ids.get("grid.power_factor") } })).status).toBe(201);
      const unseen = "11111111-1111-4111-8111-111111111111";
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "measured", class: "E5", as_of: "2026-02-01", source_kind: "project", source_id: unseen })] });
      expect(r.body.ran, JSON.stringify(r.body)).toBe(true);
      const sent = engineCalls[0]!.body;
      expect(sent.before.grid.power_factor).toMatchObject({ value: 0.96, evidence: "E5", note: "declared vendor by the recorder; file reviewed and verified" });
      expect(sent.after.grid.contracted_MW).toMatchObject({ value: 9, evidence: "E3", note: "declared measured by the recorder; file not yet reviewed" });
      expect(sent.before.grid.firm_capacity_MVA).toMatchObject({ evidence: "E5" });                          // declared E5 on a verified file: carried as declared
      expect(r.body.classNotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "grid.power_factor", declared: "E6", sent: "E5", side: "from", why: expect.stringMatching(/calibration ledger/) }),
        expect.objectContaining({ path: "grid.contracted_mw", declared: "E5", sent: "E3", side: "to", why: expect.stringMatching(/not reviewed and verified now/) }),
      ]));
      for (const n of r.body.classNotes) expect(Number(n.sent.slice(1))).toBeLessThan(Number(n.declared.slice(1)));
    });

    it("every annotated figure in what the engine is sent is at most the class its recorder declared (a recorded E1 is sent as E1, a recorded E3 as E3), and carries the declaration", async () => {
      const t = await team();
      await recordReference(t);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "hall.net_white_space_m2", value: 2000, unit: "m2", origin: "assumed", class: "E0", as_of: "2026-02-01" })] });
      expect(r.body.ran, JSON.stringify(r.body)).toBe(true);
      expect(engineCalls).toHaveLength(1);
      const sent = engineCalls[0]!.body;
      expect(Object.keys(sent).sort()).toEqual(["after", "before", "cost_evidence"]);
      const declared = new Map(REFERENCE_HALL.map((f) => [f.engine, Number(f.evidenceClass.slice(1))]));
      let annotated = 0;
      const walk = (node: any, p: string) => {
        if (node && typeof node === "object" && !Array.isArray(node) && "value" in node) {
          annotated++;
          expect(node.evidence, p).toMatch(/^E[0-5]$/);
          const want = declared.get(p);
          if (want !== undefined && p !== "hall.net_white_space_m2") expect(Number(node.evidence.slice(1)), p).toBeLessThanOrEqual(want);
          expect(node.note, p).toMatch(/^declared (assumed|measured|vendor|modelled|observed|quotation) by the recorder; (no file cited|file reviewed and verified|file not yet reviewed|file rejected|file not reviewable)$/);
        } else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) if (!Array.isArray(v)) walk(v, p ? `${p}.${k}` : k); else (v as any[]).forEach((it) => expect(typeof it).toBe("object"));
      };
      walk(sent.before, ""); walk(sent.after, "");
      expect(annotated).toBeGreaterThan(30);
      // the pending change went out at the class it declared (E0), not the class of the figure it replaced (E1)
      expect(sent.after.hall.net_white_space_m2).toMatchObject({ value: 2000, evidence: "E0" });
      expect(sent.before.hall.net_white_space_m2).toMatchObject({ value: 2400, evidence: "E1" });
      expect(r.body.classChanges).toEqual([]);                                                             // the value changed too
      expect(JSON.stringify(sent)).not.toMatch(/@|nameplate|project-evidence|SECRET|storage/);
    });

    it("a class change with the value unchanged is reported as a change of evidence, and moves no input", async () => {
      const t = await team();
      await recordReference(t);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 12, unit: "MW", origin: "assumed", class: "E1", as_of: "2026-02-01" })] });
      expect(r.body.ran, JSON.stringify(r.body)).toBe(true);
      expect(r.body.classChanges).toEqual([{ path: "grid.contracted_mw", from: "E3", to: "E1" }]);
      expect(r.body.diff.drivers).toEqual([]);
      expect(r.body.diff.inputs).toBe("changed");
    });

    it("a pending import is judged by the import's rules: a refused row is left out and listed with its reason, the rest is run, and NOTHING is written", async () => {
      const t = await team();
      await recordReference(t);
      const api = async () => (await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1&limit=500" })).body;
      const before = await api();
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [
        row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" }, 1),
        row({ field_path: "grid.current_site_peak_mw", value: 8, unit: "MW", origin: "assumed", class: "E5", as_of: "2026-02-01" }, 2),
        row({ field_path: "grid.invented_figure", value: 1, origin: "assumed", class: "E1", as_of: "2026-02-01" }, 3),
        row({ field_path: "hall.floor_loading_kpa", value: 99, unit: "psf", origin: "assumed", class: "E1", as_of: "2026-02-01" }, 4),
        row({ field_path: "hall.rack_positions", value: 560, origin: "assumed", class: "E1", as_of: "2026-01-15" }, 5),
      ] });
      expect(r.body.ran, JSON.stringify(r.body)).toBe(true);
      expect(r.body.to.rows.used).toBe(1);
      expect(r.body.to.rows.unchanged).toBe(1);
      expect(r.body.to.rows.excluded.map((e: any) => e.n)).toEqual([2, 3, 4]);
      expect(r.body.to.rows.excluded[0].reason).toMatch(/cannot claim a class above E3/);
      expect(r.body.to.rows.excluded[1].reason).toMatch(/not a field this registry knows/);
      expect(r.body.to.rows.excluded[2].reason).toMatch(/Unit “psf” is not the unit/);
      expect(engineCalls[0]!.body.after.grid.contracted_MW.value).toBe(9);
      expect(engineCalls[0]!.body.after.hall.floor_loading_kPa.value).toBe(12);          // the refused row did not get in
      const after = await api();
      expect(after).toEqual(before);                                                       // not one claim written, replaced or added
      expect(after.inputs).toHaveLength(REFERENCE_HALL.length);
    });

    it("a pending row is held to the hall: it cannot reach a field the import would refuse, so a stranger's pending rows tell nothing about another hall", async () => {
      const t = await team(), other = await team();
      await recordReference(other);
      const r = await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] });
      expect(r.body).toMatchObject({ ran: false, reason: "missing" });
      expect(engineCalls).toEqual([]);
    });

    it("an earlier day compared with now: the record at the end of that day is what is asked about (an unrecorded day is missing, never defaulted)", async () => {
      const t = await team();
      await recordReference(t);
      const r = await diff(t.viewer, t.hall, { asOf: "2020-01-01" }, { now: true });
      expect(r.body).toMatchObject({ ran: false, reason: "missing", missing: expect.any(Array) });
      expect(r.body.missing.every((m: any) => m.sides.length === 1 && m.sides[0] === "from")).toBe(true);
      expect(engineCalls).toEqual([]);
    });

    it.runIf(typeof backend.backdate === "function")("a point is the record at the END of that UTC day: what was recorded by then, and nothing recorded after it", async () => {
      const t = await team();
      const rec = await recordReference(t);
      backend.backdate!("2026-01-20T10:00:00.000Z");                                    // everything so far was recorded on 20 January
      expect((await correct(t.editor, t.hall, rec.ids, "grid.contracted_mw", { value: 9, evidenceClass: "E3", asOf: "2026-02-01" })).status).toBe(201);   // recorded now
      const r = await diff(t.viewer, t.hall, { asOf: "2026-01-20" }, { now: true });
      expect(r.body.ran, JSON.stringify(r.body)).toBe(true);
      expect(r.body.from).toMatchObject({ kind: "asOf", asOf: "2026-01-20" });
      expect(r.body.diff.drivers.map((d: any) => [d.path, d.before, d.after])).toEqual([["grid.contracted_mw", 12, 9]]);
      expect(engineCalls[0]!.body.before.grid.contracted_MW.value).toBe(12);
      expect(engineCalls[0]!.body.after.grid.contracted_MW.value).toBe(9);
      // the day before the first claim: nothing was recorded yet, so everything is missing there and the engine is not asked
      const early = await diff(t.viewer, t.hall, { asOf: "2026-01-19" }, { now: true });
      expect(early.body).toMatchObject({ ran: false, reason: "missing" });
      expect(early.body.missing.every((m: any) => m.sides.length === 1 && m.sides[0] === "from")).toBe(true);
      expect(engineCalls).toHaveLength(1);
      // a day between the two recordings is the old state again, so it is the same as the 20th: nothing to compare between them
      expect((await diff(t.viewer, t.hall, { asOf: "2026-01-20" }, { asOf: "2026-03-01" })).body).toMatchObject({ ran: false, reason: "identical" });
    });

    it("the diff writes nothing: no claim, no timeline event, no attachment", async () => {
      const t = await team();
      await recordReference(t);
      const tl = async () => (await call("inputs", "GET", t.viewer, { id: t.hall, query: "?history=1&limit=500" })).body.inputs.length;
      const n = await tl();
      expect((await diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] })).body.ran).toBe(true);
      expect(await tl()).toBe(n);
      const projects = await rest<any[]>("GET", `hall_project_attachments?hall_id=eq.${t.hall}&select=id`);
      expect(projects.ok && (projects as any).data.length).toBe(1);            // the one the test made to cite a file
    });
  });

  // ------------------------------------------------------------------------------------------------- the engine is not there

  describe.runIf(hasPython)("when the engine cannot answer, there is a clean 503 and no partial data", () => {
    const ask = async () => {
      const t = await team();
      await recordReference(t);
      return diff(t.viewer, t.hall, { now: true }, { proposed: [row({ field_path: "grid.contracted_mw", value: 9, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })] });
    };
    const clean = (r: Res) => {
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(r.body).sort()).toEqual(["error", "ok", "reason"]);
      expect(r.body.ok).toBe(false);
      expect(r.body.error).toMatch(/nothing was run and nothing was charged/);
    };

    it("the engine is down", async () => {
      mode = "down";
      const r = await ask();
      expect(r.status).toBe(503);
      expect(r.body.reason).toBe("engine_unavailable");
      clean(r);
    });
    it("the deployed engine does not serve /v1/diff", async () => {
      mode = "missing";
      const r = await ask();
      expect(r.status).toBe(503);
      expect(r.body.reason).toBe("engine_route_missing");
      clean(r);
    });
    it("the engine key is not configured", async () => {
      const key = process.env.GRIDFORGE_API_KEY;
      delete process.env.GRIDFORGE_API_KEY;
      try {
        const r = await ask();
        expect(r.status).toBe(503);
        clean(r);
        expect(engineCalls).toEqual([]);
      } finally { process.env.GRIDFORGE_API_KEY = key; }
    });
    it("the engine answers in a form this site does not understand: nothing is shown", async () => {
      mode = "garbage";
      const r = await ask();
      expect(r.status).toBe(502);
      expect(r.body.reason).toBe("engine_answer_unreadable");
      expect(JSON.stringify(r.body)).not.toMatch(/surprise/);
    });
    it("the engine refuses the recorded figures: its words are passed on, with nothing else of its answer", async () => {
      mode = "refuse";
      const r = await ask();
      expect(r.status).toBe(422);
      expect(r.body.error).toMatch(/did not accept the recorded figures: unknown platform 'warp_drive'/);
      expect(r.body.reason).toBe("engine_refused");
    });
    it("an engine that predates provenance on a diff is asked once more without it, and the answer says it did not state its build", async () => {
      mode = "old";
      const r = await ask();
      expect(r.status).toBe(200);
      expect(r.body.ran).toBe(true);
      expect(r.body.engine).toBeNull();
      expect(engineCalls.map((c) => "cost_evidence" in c.body)).toEqual([true, false]);
    });
  });

  // ------------------------------------------------------------------------------------------------- the allowance

  describe.runIf(hasPython)("each run costs the operator units, so the allowance is small, per verified account and per hall", () => {
    const pending = (n = 9) => [row({ field_path: "grid.contracted_mw", value: n, unit: "MW", origin: "assumed", class: "E3", as_of: "2026-02-01" })];

    it("the account's hourly allowance: the run after the last is a 429 with Retry-After and no engine call; a colleague on another account is not locked out", async () => {
      const t = await team();
      await recordReference(t);
      const limit = RATE_POLICIES.registry_diff.limit;
      await spend("registry_diff", accountSubject(t.viewer)!, limit - 1, limit, 3600);
      const last = await diff(t.viewer, t.hall, { now: true }, { proposed: pending() });
      expect(last.status, JSON.stringify(last.body)).toBe(200);
      const over = await diff(t.viewer, t.hall, { now: true }, { proposed: pending(8) });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(over.headers.get("cache-control")).toBe("no-store");
      expect(engineCalls).toHaveLength(1);
      // the same account from another address is still over; a colleague is not
      ip = "10.77.7.7";
      expect((await diff(t.viewer, t.hall, { now: true }, { proposed: pending(7) })).status).toBe(429);
      expect((await diff(t.editor, t.hall, { now: true }, { proposed: pending(7) })).status).toBe(200);
    });

    it("a figure-missing answer, an identical answer and a refused request are free: they do not use the allowance", async () => {
      const t = await team();
      await diff(t.viewer, t.hall, { now: true }, { proposed: pending() });                    // missing
      await recordReference(t);
      await diff(t.viewer, t.hall, { asOf: today() }, { now: true });                          // identical
      await diff(t.viewer, t.hall, { now: true }, { asOf: "2999-01-01" });                     // refused
      expect(await spent("registry_diff", t.viewer)).toBe(0);
    });

    it("the hall's daily allowance, whoever asks; charged only after membership is known, so a stranger cannot spend it", async () => {
      const t = await team();
      await recordReference(t);
      const day = RATE_POLICIES.registry_diff_hall;
      await diff(person("stranger"), t.hall, { now: true }, { proposed: pending() });
      expect(await spentHall(t.hall)).toBe(0);
      await spend("registry_diff_hall", subjectOf(`hall-diff:${t.hall}`)!, day.limit - 1, day.limit, 86400);
      expect((await diff(t.viewer, t.hall, { now: true }, { proposed: pending() })).status).toBe(200);
      const over = await diff(t.editor, t.hall, { now: true }, { proposed: pending(8) });
      expect(over.status).toBe(429);
      expect(over.body.reason).toBe("hall_allowance");
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(engineCalls).toHaveLength(1);
    });

    it("fails closed: when the counter cannot be read the request is refused with 503, not run", async () => {
      const t = await team();
      await recordReference(t);
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("gf_rate_limit_hit") && typeof init?.body === "string" && init.body.includes("registry_diff")) return new Response("{}", { status: 503 });
        return real(input, init);
      }) as typeof fetch;
      try {
        const r = await diff(t.viewer, t.hall, { now: true }, { proposed: pending() });
        expect(r.status).toBe(503);
        expect(engineCalls).toEqual([]);
      } finally { globalThis.fetch = real; }
    });
  });

  describe("the real-engine scenarios cannot be skipped silently where they are required", () => {
    it("python3 is present whenever GRIDFORGE_REQUIRE_ENGINE=1 or CI=true", () => {
      const g = engineAvailable(hasPython);
      expect(g.ok, g.reason).toBe(true);
    });
  });
}
