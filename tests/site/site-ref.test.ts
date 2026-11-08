/**
 * The keyed site reference (lib/site-ref.ts): HMAC parity with the Python implementation on shared vectors, the key rules, and what the observation
 * route does with it. Migration 0053 (the database storing the value it is given) is proved against real PostgreSQL by
 * tests/test_salted_site_ref_migration.py; the in-memory fake here mirrors it.
 *
 * tests/site_ref_vectors.json is read by this file AND tests/test_site_ref_hmac.py: both must reproduce every vector.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import {
  SITE_REF_FALLBACK_KEY, SITE_REF_NOT_CONFIGURED, SITE_REF_PATTERN, SITE_REF_SECRET_MIN, normaliseSiteLabel, resetSiteRefWarning, siteRefFor, siteRefFromEnv, siteRefKey,
} from "@/lib/site-ref";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const VECTORS: { key: string; label: string; expected: string | null }[] = JSON.parse(fs.readFileSync("tests/site_ref_vectors.json", "utf8")).vectors;
const K1 = "vector-key-one-0123456789abcdef";
const K2 = "vector-key-two-0123456789abcdef";
const unsalted = (label: string) => "site_" + createHash("sha256").update(label.trim().toLowerCase()).digest("hex").slice(0, 12);

describe("parity with the Python implementation", () => {
  it("reproduces every shared vector (null = no label, no reference)", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(VECTORS.map((v) => v.key))).toEqual(new Set([K1, K2]));
    expect(VECTORS.some((v) => v.expected === null) && VECTORS.some((v) => v.expected !== null)).toBe(true);
    for (const v of VECTORS) expect(siteRefFor(v.label, v.key), JSON.stringify(v.label).slice(0, 60)).toBe(v.expected);
  });

  it("a different secret gives a different reference; the same label and secret a stable one; and it is not the old bare hash", () => {
    for (const label of ["Hall A", "Dublin DC1", "x"]) {
      expect(siteRefFor(label, K1)).toBe(siteRefFor(label, K1));
      expect(siteRefFor(label, K1)).not.toBe(siteRefFor(label, K2));
      expect(siteRefFor(label, K1)).not.toBe(unsalted(label));
    }
    expect(siteRefFor("Hall A", K1)).not.toBe(siteRefFor("Hall B", K1));
  });

  it("case and surrounding whitespace do not make a new site; inner changes do", () => {
    const base = siteRefFor("Dublin DC1", K1);
    for (const s of ["dublin dc1", "DUBLIN DC1", "  Dublin DC1  ", "\tDublin DC1\n", " Dublin DC1　", "﻿Dublin DC1 "]) expect(siteRefFor(s, K1), JSON.stringify(s)).toBe(base);
    for (const s of ["Dublin  DC1", "Dublin-DC1", "DublinDC1", "Dublin DC 1"]) expect(siteRefFor(s, K1), s).not.toBe(base);
    expect(normaliseSiteLabel("  ABC \n")).toBe("abc");
  });

  it("the format is site_ and twelve lowercase hex", () => {
    for (const v of VECTORS) if (v.expected) expect(v.expected).toMatch(SITE_REF_PATTERN);
    for (const bad of ["site_0123456789AB", "site_0123456789a", "site_0123456789abc", "Site_0123456789ab", "site-0123456789ab", " site_0123456789ab"]) expect(SITE_REF_PATTERN.test(bad), bad).toBe(false);
  });

  it.each(["", "   ", "\t\n", " 　", null, undefined, 5, {}, []])("%j has no reference", (label) => {
    expect(siteRefFor(label, K1)).toBeNull();
  });

  it.each([
    "'; drop table projects; --", "<script>alert(1)</script>", "a\u0000b", "‮Hall A", "x".repeat(100_000), "\u{1F3ED}".repeat(500), "\ud800", "../../etc/passwd", "%s%s%n", "{{7*7}}", "İİ",
  ])("hostile label %j gives a well-formed reference that contains none of it", (label) => {
    const ref = siteRefFor(label, K1)!;
    expect(ref).toMatch(SITE_REF_PATTERN);
    expect(ref.length).toBe(17);
  });
});

describe("which key", () => {
  beforeEach(() => { resetSiteRefWarning(); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("GRIDFORGE_SITE_REF_SECRET (16+ characters) wins, then GRIDFORGE_KEY_SECRET, then the fixed public fallback outside production", () => {
    const long = "d".repeat(SITE_REF_SECRET_MIN);
    expect(siteRefKey({ GRIDFORGE_SITE_REF_SECRET: long, GRIDFORGE_KEY_SECRET: "signing" })).toEqual({ ok: true, key: long, source: "GRIDFORGE_SITE_REF_SECRET" });
    expect(siteRefKey({ GRIDFORGE_SITE_REF_SECRET: "short", GRIDFORGE_KEY_SECRET: "signing" })).toEqual({ ok: true, key: "signing", source: "GRIDFORGE_KEY_SECRET" });
    expect(siteRefKey({ GRIDFORGE_KEY_SECRET: "signing" })).toEqual({ ok: true, key: "signing", source: "GRIDFORGE_KEY_SECRET" });
    expect(siteRefKey({})).toEqual({ ok: true, key: SITE_REF_FALLBACK_KEY, source: "fallback" });
    expect(siteRefKey({ GRIDFORGE_SITE_REF_SECRET: "", GRIDFORGE_KEY_SECRET: "", VERCEL_ENV: "preview" })).toEqual({ ok: true, key: SITE_REF_FALLBACK_KEY, source: "fallback" });
  });

  it("warns ONCE when it is not using the dedicated secret, and never prints a key", () => {
    siteRefKey({ GRIDFORGE_KEY_SECRET: "signing-secret-not-real" });
    siteRefKey({ GRIDFORGE_KEY_SECRET: "signing-secret-not-real" });
    siteRefKey({});
    const warned = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" "));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/GRIDFORGE_SITE_REF_SECRET is not set/);
    expect(warned[0]).toMatch(/rotated/);
    expect(warned.join("")).not.toContain("signing-secret-not-real");
    resetSiteRefWarning();
    siteRefKey({});
    const again = (console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" ")).pop()!;
    expect(again).toMatch(/PUBLIC fallback/);
    expect(again).not.toContain(SITE_REF_FALLBACK_KEY);
  });

  it("a PRODUCTION deployment with no secret has no fallback: it refuses, loudly, and the refusal names the variable but no value", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { VERCEL_ENV: "production", GRIDFORGE_SITE_REF_SECRET: "too-short" }, { VERCEL_ENV: "production", GRIDFORGE_KEY_SECRET: "" }]) {
      const k = siteRefKey(env);
      expect(k).toEqual({ ok: false, error: SITE_REF_NOT_CONFIGURED });
    }
    expect(SITE_REF_NOT_CONFIGURED).toMatch(/^site reference secret not configured/);
    expect((console.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    // a production deployment WITH a secret is fine, and a label-less project needs none
    expect(siteRefKey({ VERCEL_ENV: "production", GRIDFORGE_KEY_SECRET: "signing" }).ok).toBe(true);
    expect(siteRefFromEnv(null, { VERCEL_ENV: "production" })).toEqual({ ok: true, ref: null });
    expect(siteRefFromEnv("  ", { VERCEL_ENV: "production" })).toEqual({ ok: true, ref: null });
    expect(siteRefFromEnv("Hall A", { VERCEL_ENV: "production" })).toEqual({ ok: false, error: SITE_REF_NOT_CONFIGURED });
    expect(siteRefFromEnv("Hall A", { VERCEL_ENV: "production", GRIDFORGE_SITE_REF_SECRET: K1 })).toEqual({ ok: true, ref: siteRefFor("Hall A", K1) });
  });

  it("only VERCEL_ENV=production is production here, like the data origin (NODE_ENV alone is not)", () => {
    expect(siteRefKey({ NODE_ENV: "production" }).ok).toBe(true);
    expect(siteRefKey({ VERCEL_ENV: "Production" }).ok).toBe(true);
    expect(fs.readFileSync("lib/project-observations.ts", "utf8")).toContain('env.VERCEL_ENV === "production"');
  });
});

// ------------------------------------------------------------------------------------------------ the observation route

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

let db: PostgrestFake;
let restore: () => void;
const ARCH = "GRID + BESS + GENERATION";
const CASES = ["case-tok-1", "case-tok-2", "case-tok-3", "case-tok-4"];     // a case belongs to one project: each project gets its own

describe("the observation route", () => {
  beforeEach(() => {
    jar.length = 0; resetSiteRefWarning(); caseNo = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    db = new PostgrestFake(["projects", "project_links", "project_events", "project_evidence", "project_observations", "project_observation_reviews", "power_deployment_cases", "calibration_permissions"]);
    db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
    installProjectRpcs(db);
    db.seed("power_deployment_cases", CASES.map((case_token) => ({
      case_token, revision: 1, email: null, request: {}, changed_fields: [], created_at: "2026-03-02T09:00:00Z", case_digest: "b".repeat(64),
      engine_provenance: { digest: "c".repeat(64), report_date: "2026-03-01", engine_version: "test" },
      result: { capacity: { target_MW: 35, grid_firm_MW: 10, gap_MW: 25 }, architectures: [{ label: ARCH, status: "pass", available_MW: 36.4, margin_MW: 1.4, rfq_ready: true, readiness_gates: [] }] },
    })));
    restore = db.install();
  });
  afterEach(() => {
    restore(); vi.restoreAllMocks();
    for (const k of ["ADMIN_PASSWORD", "VERCEL_ENV", "GRIDFORGE_SITE_REF_SECRET", "GRIDFORGE_KEY_SECRET", "GRIDFORGE_DATA_ORIGIN"]) delete process.env[k];
  });

  const json = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
  let caseNo = 0;
  async function project(site_label: string | null = "Dublin DC1") {
    const caseToken = CASES[caseNo++];
    const { POST } = await import("@/app/api/projects/route");
    const made: any = await (await POST(json("/api/projects", { project_name: "Hall A", ...(site_label ? { site_label } : {}) }))).json();
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    await attach(json("/x", { case_token: caseToken }), ctx({ token: made.project_token }));
    return { token: made.project_token as string, caseToken, id: db.rows("projects").find((p) => p.project_token === made.project_token)!.id as string };
  }
  const body = (project: { id: string; caseToken: string }, over: Record<string, unknown> = {}) => ({
    calibration_key: "btm.firm_MW", case_token: project.caseToken, architecture: ARCH, observed_value: 33.0, observed_on: "2026-09-30", method: "revenue meter, 30-day export trend",
    submitted_by: "A. Rivera", measurement_kind: "metered",
    evidence_id: db.insertRow("project_evidence", { project_id: project.id, filename: "m.csv", media_type: "text/csv", sha256: "a".repeat(64), byte_size: 10, storage_ref: "b/x", source_category: "load_data", evidence_class: null, review_status: "verified" }).id,
    attests_installed_architecture: true, installed_basis: "commissioning certificate CC-114", ...over,
  });
  async function submit(token: string, b: Record<string, unknown>) {
    const { POST } = await import("@/app/api/projects/[token]/observations/route");
    const res = await POST(json("/x", b), ctx({ token }));
    return { res, body: (await res.json()) as any };
  }
  const stored = () => db.rows("project_observations");

  it("a production deployment with no secret refuses with 503 'site reference secret not configured', and writes nothing", async () => {
    process.env.VERCEL_ENV = "production";
    const p = await project();
    const r = await submit(p.token, body(p));
    expect(r.res.status).toBe(503);
    expect(r.body.error).toMatch(/^site reference secret not configured/);
    expect(JSON.stringify(r.body)).not.toContain(p.token);
    expect(stored()).toHaveLength(0);
    expect(db.rows("project_events").filter((e) => e.event_type === "observation_submitted")).toHaveLength(0);
  });

  it("a production deployment WITH a secret stores the keyed reference, not the bare hash, and not one the request chose; the secret appears nowhere", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.GRIDFORGE_SITE_REF_SECRET = K1;
    const p = await project();
    const r = await submit(p.token, body(p, { site_ref: "site_000000000000" }));
    expect(r.res.status).toBe(201);
    expect(stored()[0].site_ref).toBe(siteRefFor("Dublin DC1", K1));
    expect(stored()[0].site_ref).not.toBe(unsalted("Dublin DC1"));
    expect(stored()[0].site_ref).not.toBe("site_000000000000");
    expect(JSON.stringify(r.body)).not.toContain(K1);
    const logs = [...(console.warn as ReturnType<typeof vi.fn>).mock.calls, ...(console.error as ReturnType<typeof vi.fn>).mock.calls].map((c) => c.join(" ")).join("\n");
    expect(logs).not.toContain(K1);
  });

  it("two spellings of one label are one reference; another secret is another reference (a rotation makes every site look new)", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.GRIDFORGE_SITE_REF_SECRET = K1;
    const a = await project("Dublin DC1"), b = await project("  DUBLIN dc1 ");
    expect((await submit(a.token, body(a))).res.status).toBe(201);
    expect((await submit(b.token, body(b))).res.status).toBe(201);
    expect(stored()[0].site_ref).toBe(stored()[1].site_ref);
    process.env.GRIDFORGE_SITE_REF_SECRET = K2;
    const c = await project("Dublin DC1");
    expect((await submit(c.token, body(c))).res.status).toBe(201);
    expect(stored()[2].site_ref).not.toBe(stored()[0].site_ref);
  });

  it("a project with no site label needs no secret even in production, and gets no reference (so it is never exported)", async () => {
    process.env.VERCEL_ENV = "production";
    const p = await project(null);
    const r = await submit(p.token, body(p));
    expect(r.res.status).toBe(201);
    expect(stored()[0].site_ref).toBeNull();
  });

  it("outside production with no secret it uses the fixed fallback key (stable, hermetic) and warns once", async () => {
    const p = await project();
    expect((await submit(p.token, body(p))).res.status).toBe(201);
    expect(stored()[0].site_ref).toBe(siteRefFor("Dublin DC1", SITE_REF_FALLBACK_KEY));
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" ")).filter((m) => /PUBLIC fallback/.test(m))).toHaveLength(1);
    expect(stored()[0].data_origin).toBe("test");            // and it can never be production data
  });

  it("BEFORE 0053 (a database that ignores the key and derives the unsalted hash) the submission still succeeds, and the log says the reference is unsalted", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.GRIDFORGE_SITE_REF_SECRET = K1;
    const real = db.rpcs.get("gf_submit_observation")!;
    db.rpcs.set("gf_submit_observation", (a: any, d: any) => { const { site_ref: _ignored, ...rest } = a.p; void _ignored; return real({ ...a, p: rest }, d); });
    const p = await project();
    const r = await submit(p.token, body(p));
    expect(r.res.status).toBe(201);
    expect(stored()[0].site_ref).toBe(unsalted("Dublin DC1"));
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/migration 0053 is not applied.*UNSALTED/);
  });

  it("AFTER 0053 there is no such warning, and a database that refuses a malformed reference is mapped to a refusal, not a crash", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.GRIDFORGE_SITE_REF_SECRET = K1;
    const p = await project();
    expect((await submit(p.token, body(p))).res.status).toBe(201);
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/0053/);
    const q = await project("Other");
    const { PgError } = await import("./postgrest-fake");
    db.rpcs.set("gf_submit_observation", () => { throw new PgError("23514", "site_ref must be site_ followed by 12 lowercase hex characters", 400); });
    const r = await submit(q.token, body(q, { observed_on: "2026-09-29" }));
    expect(r.res.status).toBe(422);
  });

  it("the route builds the payload itself: a site_ref, engine digest or data origin in the request body is never passed through", () => {
    const src = fs.readFileSync("lib/project-observations.ts", "utf8");
    expect(src).not.toMatch(/input\.site_ref|input\["site_ref"\]|body\.site_ref/);
    expect(src).toContain("siteRefFromEnv(project.site_label)");
    expect(src).toMatch(/\.\.\.\(siteRef\.ref \? \{ site_ref: siteRef\.ref \} : \{\}\)/);
  });
});
