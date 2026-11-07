/**
 * Calibration integrity (migrations 0046, 0047, 0048) at the application boundary, against the repository's in-memory PostgREST.
 *
 * What the fakes cannot prove (a trigger firing, a view returning one row) is proven against real PostgreSQL in
 * tests/test_forecast_freeze_migration.py, tests/test_calibration_consent_migration.py, tests/test_evidence_verification_migration.py and
 * tests/test_calibration_truth_table.py. This file proves the three admin routes and the review screen:
 *   POST /api/admin/calibration-permissions      record that a project's owner granted or withdrew permission
 *   POST /api/admin/evidence/[id]/review         verify or reject ONE file; the server re-reads it and hashes it
 *   /admin/reviews "Verify file"                 the screen that posts to it
 * each of which is admin-only, refuses a cross-site write, validates its body, and returns neither a storage path nor a token.
 * Every value is a SYNTHETIC fixture.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { dataOrigin, forecastPredatesOutcome, ledgerBlockers } from "@/lib/project-observations";
import { fileReviewBody, reviewProblems, reviewUrl } from "@/lib/project-review-ui";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));

let db: PostgrestFake;
let restore: () => void;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = U(1), FILE_A = U(2), FILE_B = U(3), OTHER_PROJECT = U(9);
const BYTES = new TextEncoder().encode("timestamp,kW\n2026-09-30T00:00:00,33000\n");
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const STORAGE_REF = `project-evidence/${PROJECT}/${DIGEST}-meter.csv`;
const DOC_A = createHash("sha256").update("signed letter A").digest("hex");      // a document digest, not a placeholder
const DOC_B = createHash("sha256").update("signed letter B").digest("hex");
const DOC_C = createHash("sha256").update("signed letter C").digest("hex");
const SECRET_TOKEN = "SECRET-PROJECT-TOKEN-0048";
const SERVICE_KEY = "sb_secret_test_key_0048";

beforeEach(() => {
  jar.length = 0;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  db = new PostgrestFake([
    "projects", "project_links", "project_events", "project_evidence", "project_evidence_reviews", "calibration_permissions",
    "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality",
    "procurement_packages", "procurement_responses", "power_deployment_cases",
  ]);
  installProjectRpcs(db);
  restore = db.install();
  db.seed("projects", [
    { id: PROJECT, project_token: SECRET_TOKEN, project_name: "Hall A (synthetic)", site_label: "Dublin 1", company: "Acme" },
    { id: OTHER_PROJECT, project_token: "other-token", project_name: "Hall B (synthetic)", site_label: null, company: null },
  ]);
  const file = (id: string, name: string, sha = DIGEST) => ({
    id, project_id: PROJECT, filename: name, media_type: "text/csv", sha256: sha, byte_size: BYTES.byteLength, storage_ref: STORAGE_REF,
    source_category: "load_data", review_status: "unverified", evidence_class: null, uploaded_at: "2026-10-01T00:00:00Z", note: null,
  });
  db.seed("project_evidence", [file(FILE_A, "meter.csv"), file(FILE_B, "other.csv", "b".repeat(64))]);
  db.objects.set(STORAGE_REF, { bytes: BYTES, contentType: "text/csv" });
});
afterEach(() => { restore(); delete process.env.ADMIN_PASSWORD; delete process.env.VERCEL_ENV; delete process.env.GRIDFORGE_DATA_ORIGIN; });

const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const permRoute = () => import("@/app/api/admin/calibration-permissions/route");
const fileRoute = () => import("@/app/api/admin/evidence/[id]/review/route");

const goodPermission = (over: Record<string, unknown> = {}) => ({
  project_id: PROJECT, kind: "granted", granted_by_email: "Owner@Example.TEST", document_sha256: DOC_A, note: "signed letter of 2026-10-01", ...over,
});
const goodDecision = (over: Record<string, unknown> = {}) => ({ decision: "verified", reviewer: "F. Keane", reason: "opened the file; it is the meter export", ...over });

// ------------------------------------------------------------------------------------------------ POST /api/admin/calibration-permissions

describe("POST /api/admin/calibration-permissions", () => {
  it("is admin-only: no cookie, a bad cookie => 401 and nothing is written", async () => {
    expect((await (await permRoute()).POST(post("/x", goodPermission()))).status).toBe(401);
    jar.push({ name: "gf_admin", value: "1.bogus.bogus" });
    expect((await (await permRoute()).POST(post("/x", goodPermission()))).status).toBe(401);
    expect(db.rows("calibration_permissions")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(0);
  });

  it("refuses a cross-site write even with the cookie (403), before reading anything", async () => {
    signIn();
    const crossSite: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }, { origin: "null" }];
    for (const headers of crossSite) {
      const r = await (await permRoute()).POST(post("/x", goodPermission(), headers));
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
    expect(db.rows("calibration_permissions")).toHaveLength(0);
  });

  it("records who, what and which document; normalises the address; and writes its history event without the address", async () => {
    signIn();
    const r = await (await permRoute()).POST(post("/x", goodPermission()));
    expect(r.status).toBe(201);
    const b = await r.json();
    expect(b.permission).toMatchObject({ scope_type: "project", scope_id: PROJECT, kind: "granted", granted_by_email: "owner@example.test", document_sha256: DOC_A, note: "signed letter of 2026-10-01" });
    expect(db.rows("calibration_permissions")).toHaveLength(1);
    const ev = db.rows("project_events").filter((e) => e.event_type === "calibration_permission_recorded");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0])).not.toContain("owner@example.test");
    expect(ev[0].payload).toMatchObject({ kind: "granted", document_sha256: DOC_A });
  });

  it("supports revoking: a revocation is a new row, and there must be a grant to revoke", async () => {
    signIn();
    const { POST } = await permRoute();
    expect((await POST(post("/x", goodPermission({ kind: "revoked" })))).status).toBe(409);       // nothing to revoke yet
    expect((await POST(post("/x", goodPermission()))).status).toBe(201);
    expect((await POST(post("/x", goodPermission({ kind: "revoked", document_sha256: DOC_B, note: "owner withdrew by e-mail" })))).status).toBe(201);
    expect((await POST(post("/x", goodPermission({ kind: "revoked" })))).status).toBe(409);       // already revoked
    expect((await POST(post("/x", goodPermission({ document_sha256: DOC_C })))).status).toBe(201);   // a new grant is a new row
    expect(db.rows("calibration_permissions").map((r) => r.kind)).toEqual(["granted", "revoked", "granted"]);
  });

  it("refuses a body that is not exactly the documented shape (zod, strict), naming the fields but never echoing the values", async () => {
    signIn();
    const { POST } = await permRoute();
    const bad: Record<string, unknown>[] = [
      { document_sha256: "xyz" }, { document_sha256: "a".repeat(63) }, { document_sha256: 5 }, { document_sha256: undefined },
      { granted_by_email: "not-an-address" }, { granted_by_email: "" }, { granted_by_email: undefined }, { granted_by_email: "a".repeat(250) + "@x.test" },
      { kind: "maybe" }, { kind: undefined }, { project_id: "not-a-uuid" }, { project_id: undefined }, { note: "x".repeat(1001) }, { note: 5 },
      { document_sha256: "0".repeat(64) }, { document_sha256: "a".repeat(64) },                // a placeholder, not a document digest
      { scope_type: "organisation" }, { surprise: true }, { id: U(77) }, { granted_at: "2020-01-01T00:00:00Z" },
    ];
    for (const over of bad) {
      const r = await POST(post("/x", goodPermission(over)));
      expect(r.status, JSON.stringify(over)).toBe(422);
      const body = await r.json();
      expect(body.ok).toBe(false);
      expect(JSON.stringify(body)).not.toContain("not-an-address");
    }
    expect((await POST(post("/x", [goodPermission()]))).status).toBe(400);                    // not an object
    expect((await POST(new Request(siteUrl("/x"), { method: "POST", body: "{nope", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect(db.rows("calibration_permissions")).toHaveLength(0);
  });

  it("an unknown project is 404 and writes nothing", async () => {
    signIn();
    const r = await (await permRoute()).POST(post("/x", goodPermission({ project_id: U(404) })));
    expect(r.status).toBe(404);
    expect(db.rows("calibration_permissions")).toHaveLength(0);
  });

  it("answers 503, not a fault, while the migration has not been applied", async () => {
    signIn();
    db.rpcs.delete("gf_record_calibration_permission");
    const r = await (await permRoute()).POST(post("/x", goodPermission()));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/not available/i);
  });

  it("a store failure is a 502 that says nothing was recorded", async () => {
    signIn();
    db.failEvents = true;
    const r = await (await permRoute()).POST(post("/x", goodPermission()));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/Nothing was recorded/);
    expect(db.rows("calibration_permissions")).toHaveLength(0);
  });

  it("says in every response that it is an assertion: the digest is not verified and the administrator is not identified", async () => {
    signIn();
    const b = await (await (await permRoute()).POST(post("/x", goodPermission()))).json();
    expect(b.notice).toMatch(/assertion/);
    expect(b.notice).toMatch(/does not verify the document digest/);
    expect(b.notice).toMatch(/one shared admin password/);
    expect(b.notice).toMatch(/not recalled/);
    const src = readFileSync("app/api/admin/calibration-permissions/route.ts", "utf8");
    expect(src).toMatch(/ASSERTION-ONLY/);
  });

  it("never returns a project token or a credential", async () => {
    signIn();
    const r = await (await permRoute()).POST(post("/x", goodPermission()));
    const text = JSON.stringify(await r.json());
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SERVICE_KEY);
    expect(text).not.toMatch(/project_token|storage_ref|Bearer/);
  });
});

// ------------------------------------------------------------------------------------------------ POST /api/admin/evidence/[id]/review

describe("POST /api/admin/evidence/[id]/review", () => {
  it("is admin-only: no cookie => 401, and nothing is read or written", async () => {
    const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(r.status).toBe(401);
    expect(db.rows("project_evidence_reviews")).toHaveLength(0);
    expect(db.calls.filter((c) => /storage|project_evidence/.test(c.url))).toHaveLength(0);
  });

  it("refuses a cross-site write even with the cookie (403)", async () => {
    signIn();
    const r = await (await fileRoute()).POST(post("/x", goodDecision(), { "sec-fetch-site": "cross-site" }), ctx(FILE_A));
    expect(r.status).toBe(403);
    expect(db.rows("project_evidence_reviews")).toHaveLength(0);
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("unverified");
  });

  it("verifies a file after the SERVER re-read it and hashed it; the response carries the decision and digest, never a path or a token", async () => {
    signIn();
    const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.review).toMatchObject({ evidence_id: FILE_A, decision: "verified", reviewer: "F. Keane", sha256_confirmed: DIGEST });
    const text = JSON.stringify(body);
    expect(text).not.toContain("project-evidence/");
    expect(text).not.toMatch(/storage_ref|project_token|Bearer/);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain(SERVICE_KEY);
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("verified");
    expect(db.rows("project_events").filter((e) => e.event_type === "evidence_reviewed")).toHaveLength(1);
    // it read the object with the private, authenticated route, and sent no digest of its own choosing through the request
    expect(db.calls.some((c) => c.method === "GET" && c.url.includes("/storage/v1/object/authenticated/"))).toBe(true);
  });

  it("the digest comes from the stored bytes, never the request: a body that offers one is refused", async () => {
    signIn();
    const { POST } = await fileRoute();
    for (const extra of [{ sha256_confirmed: DIGEST }, { sha256: DIGEST }, { storage_ref: STORAGE_REF }, { review_status: "verified" }]) {
      expect((await POST(post("/x", goodDecision(extra)), ctx(FILE_A))).status, JSON.stringify(extra)).toBe(422);
    }
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("unverified");
  });

  it("a stored object that no longer hashes to the recorded digest cannot be verified (409), and can still be rejected", async () => {
    signIn();
    db.objects.set(STORAGE_REF, { bytes: new TextEncoder().encode("tampered"), contentType: "text/csv" });
    const { POST } = await fileRoute();
    const r = await POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/no longer matches/);
    expect(db.rows("project_evidence_reviews")).toHaveLength(0);
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("unverified");
    const rej = await POST(post("/x", goodDecision({ decision: "rejected", reason: "the stored file is not the uploaded one" })), ctx(FILE_A));
    expect(rej.status).toBe(201);
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("rejected");
  });

  it("a missing or unreadable stored object cannot be verified, and nothing is recorded", async () => {
    signIn();
    db.objects.delete(STORAGE_REF);
    const { POST } = await fileRoute();
    const missing = await POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toMatch(/missing/);
    db.objects.set(STORAGE_REF, { bytes: BYTES, contentType: "text/csv" });
    db.failStorage = { status: 500, body: "boom" };
    const down = await POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(down.status).toBe(502);
    expect((await down.json()).error).toMatch(/Nothing was recorded/);
    expect(db.rows("project_evidence_reviews")).toHaveLength(0);
  });

  it("the read-back has a deadline, never reads an error body past 2 KB, and logs a status only", async () => {
    signIn();
    const seen: { signal?: AbortSignal | null }[] = [];
    const real = globalThis.fetch;
    const huge = new Uint8Array(5_000_000).fill(120);
    let pulled = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/storage/v1/object/authenticated/")) return real(input, init);
      seen.push({ signal: init?.signal });
      const stream = new ReadableStream<Uint8Array>({
        pull(c) { pulled += 65536; c.enqueue(huge.subarray(0, 65536)); if (pulled > 4_000_000) c.close(); },
      });
      return Promise.resolve(new Response(stream, { status: 400 }));        // an error whose body is enormous and is not JSON
    }) as typeof fetch;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
      expect(r.status).toBe(502);
      expect(seen).toHaveLength(1);
      expect(seen[0].signal).toBeInstanceOf(AbortSignal);                   // a deadline is passed to fetch
      expect(pulled).toBeLessThan(1_000_000);                                // the 5 MB body was not read
      expect(logs.join("\n")).toMatch(/HTTP 400/);
      expect(logs.join("\n")).not.toMatch(/xxxx/);                          // no body in the log
    } finally {
      spy.mockRestore();
      globalThis.fetch = real;
    }
  });

  it("a read-back that never answers is abandoned at the deadline and nothing is recorded", async () => {
    signIn();
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/storage/v1/object/authenticated/")) return real(input, init);
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      });
    }) as typeof fetch;
    const { READ_BACK_TIMEOUT_MS } = await import("@/lib/project-evidence-review");
    expect(READ_BACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(READ_BACK_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    const asked: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((ms: number) => { asked.push(ms); return realTimeout(30); }) as typeof AbortSignal.timeout;      // the deadline, shortened for the test
    try {
      const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
      expect(asked).toEqual([READ_BACK_TIMEOUT_MS]);
      expect(r.status).toBe(502);
      expect((await r.json()).error).toMatch(/Nothing was recorded/);
      expect(db.rows("project_evidence_reviews")).toHaveLength(0);
    } finally {
      AbortSignal.timeout = realTimeout;
      globalThis.fetch = real;
    }
  });

  it("decides once: a second decision, in either direction, is 409 'already been reviewed'", async () => {
    signIn();
    const { POST } = await fileRoute();
    expect((await POST(post("/x", goodDecision()), ctx(FILE_A))).status).toBe(201);
    for (const d of ["verified", "rejected"]) {
      const r = await POST(post("/x", goodDecision({ decision: d, reviewer: "Someone Else" })), ctx(FILE_A));
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/already been reviewed/);
    }
    expect(db.rows("project_evidence_reviews")).toHaveLength(1);
  });

  it("a reviewer and a reason are mandatory, within their limits; the decision is one of two words (zod)", async () => {
    signIn();
    const { POST } = await fileRoute();
    for (const over of [{ reviewer: "" }, { reviewer: "   " }, { reviewer: undefined }, { reviewer: "x".repeat(121) }, { reason: "" }, { reason: "  " },
      { reason: undefined }, { reason: "x".repeat(501) }, { decision: "maybe" }, { decision: undefined }, { decision: "VERIFIED" }, { reviewer: 5 }]) {
      const r = await POST(post("/x", goodDecision(over)), ctx(FILE_A));
      expect(r.status, JSON.stringify(over)).toBe(422);
    }
    expect((await POST(post("/x", [goodDecision()]), ctx(FILE_A))).status).toBe(400);
    expect(db.rows("project_evidence_reviews")).toHaveLength(0);
    expect(db.rows("project_evidence").find((e) => e.id === FILE_A)!.review_status).toBe("unverified");
  });

  it("an unknown or malformed id is 404 and nothing is read from storage", async () => {
    signIn();
    const { POST } = await fileRoute();
    expect((await POST(post("/x", goodDecision()), ctx(U(404)))).status).toBe(404);
    expect((await POST(post("/x", goodDecision()), ctx("not-a-uuid"))).status).toBe(404);
    expect((await POST(post("/x", goodDecision()), ctx("../../etc/passwd"))).status).toBe(404);
    expect(db.calls.filter((c) => c.url.includes("/storage/"))).toHaveLength(0);
  });

  it("never fetches a path this system did not write", async () => {
    signIn();
    for (const ref of ["project-evidence/../other-bucket/x", "other-bucket/a/b", `project-evidence/${PROJECT}/${DIGEST}-../../x`, "http://evil.example/x"]) {
      db.rows("project_evidence").find((e) => e.id === FILE_A)!.storage_ref = ref;
      const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
      expect(r.status, ref).toBe(409);
    }
    expect(db.calls.filter((c) => c.url.includes("/storage/"))).toHaveLength(0);
  });

  it("answers 503 while the migration has not been applied", async () => {
    signIn();
    db.rpcs.delete("gf_review_evidence");
    const r = await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A));
    expect(r.status).toBe(503);
  });

  it("verifying a file lets an observation resting on it be verified, and a rejected file never does", async () => {
    signIn();
    db.seed("power_deployment_cases", [{ case_token: "c1", revision: 1, request: {}, result: {}, changed_fields: [], created_at: "2026-03-02T09:00:00Z", case_digest: "b".repeat(64) }]);
    const mk = (n: number, ev: string) => db.insertRow("project_observations", {
      id: U(500 + n), project_id: PROJECT, prediction_ref: `power_deployment_case:c1:r1:A${n}`, case_token: "c1", case_revision: 1, architecture: `A${n}`,
      calibration_key: "btm.firm_MW", unit: "MW", predicted_value: 30, observed_value: 28, observed_on: "2026-09-30", method: "m", evidence_id: ev,
      installed_attested: true, installed_basis: "b", submitted_by: "A. Rivera", submitted_at: "2026-10-02T00:00:00Z", data_origin: "production",
    }).id as string;
    const o1 = mk(1, FILE_A), o2 = mk(2, FILE_B);
    const { POST: obsReview } = await import("@/app/api/admin/observations/[id]/review/route");
    const verifyObs = (id: string) => obsReview(post("/x", { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", reason: "ok" }), ctx(id));
    expect((await verifyObs(o1)).status).toBe(409);                                              // file not verified yet
    expect((await (await fileRoute()).POST(post("/x", goodDecision()), ctx(FILE_A))).status).toBe(201);
    expect((await verifyObs(o1)).status).toBe(201);
    expect((await (await fileRoute()).POST(post("/x", goodDecision({ decision: "rejected" })), ctx(FILE_B))).status).toBe(201);
    expect((await verifyObs(o2)).status).toBe(409);                                              // a rejected file verifies nothing
  });
});

// ------------------------------------------------------------------------------------------------ the observation side of the rules

describe("what the application states about the ledger gate", () => {
  it("stamps the data origin itself: production only on a production deployment, test everywhere else, and never from the request", () => {
    expect(dataOrigin({ VERCEL_ENV: "production" })).toBe("production");
    for (const e of [{}, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { NODE_ENV: "production" }, { VERCEL_ENV: "Production" }]) {
      expect(dataOrigin(e), JSON.stringify(e)).toBe("test");
    }
    // an explicit word can only lower the claim, never raise it
    expect(dataOrigin({ VERCEL_ENV: "production", GRIDFORGE_DATA_ORIGIN: "synthetic" })).toBe("synthetic");
    expect(dataOrigin({ VERCEL_ENV: "production", GRIDFORGE_DATA_ORIGIN: "test" })).toBe("test");
    expect(dataOrigin({ GRIDFORGE_DATA_ORIGIN: "production" })).toBe("test");
    expect(dataOrigin({ VERCEL_ENV: "production", GRIDFORGE_DATA_ORIGIN: "anything" })).toBe("production");
  });

  it("a forecast predates the outcome only if it was created before the start of the observed date (UTC)", () => {
    expect(forecastPredatesOutcome("2026-06-29T23:59:59Z", "2026-06-30")).toBeNull();
    for (const t of ["2026-06-30T00:00:00Z", "2026-06-30T08:00:00Z", "2026-07-01T00:00:00Z"]) {
      expect(forecastPredatesOutcome(t, "2026-06-30"), t).toMatch(/must predate the outcome/);
    }
    for (const t of [undefined, null, "", "not a date", 5]) expect(forecastPredatesOutcome(t, "2026-06-30"), String(t)).toMatch(/no recorded creation time/);
  });

  const o = { measurement_kind: "metered", site_ref: "site_abc", engine_provenance_digest: "c".repeat(64), submitted_by: "A. Rivera", data_origin: "production" } as const;
  const r = { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", evidence_sha256: "a".repeat(64) } as const;
  const ev = { review_status: "verified", sha256: "a".repeat(64) };

  it("ledgerBlockers names the data origin and the standing permission", () => {
    expect(ledgerBlockers(o, r, ev, "granted")).toEqual([]);
    expect(ledgerBlockers(o, r, ev, "revoked")).toEqual(["the project's permission to share its measurements was revoked"]);
    expect(ledgerBlockers(o, r, ev, "none")).toEqual(["no permission from the project's owner to share its measurements is on record"]);
    expect(ledgerBlockers(o, r, ev, undefined)).toEqual(["no permission from the project's owner to share its measurements is on record"]);   // absent = none: the safe direction
    expect(ledgerBlockers(o, r, ev, "unknown")).toEqual(["the project's permission record could not be read"]);
    for (const origin of ["test", "synthetic", "unclassified", undefined]) {
      expect(ledgerBlockers({ ...o, data_origin: origin as never }, r, ev, "granted")[0], String(origin)).toMatch(/data origin is not production/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the review screen

describe("the Verify file section of /admin/reviews", () => {
  async function page() {
    const { default: Page } = await import("@/app/admin/reviews/page");
    return renderToStaticMarkup(await Page());
  }

  it("lists the unverified files, whitelisted: name, type, size, digest, project; never a storage path or a token", async () => {
    signIn();
    const html = await page();
    expect(html).toContain("Verify file (2)");
    expect(html).toContain("meter.csv");
    expect(html).toContain(DIGEST);
    expect(html).toContain("Hall A (synthetic)");
    expect(html).not.toContain("project-evidence/");
    expect(html).not.toContain(SECRET_TOKEN);
    expect(html).not.toMatch(/storage_ref|project_token/);
  });

  it("selects only the whitelisted columns, filtered and ordered by the store", async () => {
    signIn();
    await page();
    const reads = db.calls.filter((c) => c.method === "GET" && c.url.includes("/project_evidence?") && decodeURIComponent(c.url).includes("review_status=eq.unverified"));
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) {
      const u = decodeURIComponent(c.url);
      expect(u).not.toMatch(/select=\*/);
      expect(u).not.toContain("storage_ref");
      expect(u).toContain("order=uploaded_at.desc,id.desc");
      expect(u).toMatch(/limit=100/);
    }
  });

  it("a verified or rejected file is no longer listed", async () => {
    signIn();
    db.rows("project_evidence").find((e) => e.id === FILE_B)!.review_status = "rejected";
    const html = await page();
    expect(html).toContain("Verify file (1)");
    expect(html).not.toContain("other.csv");
  });

  it("is bounded: the newest REVIEW_SHOW_MAX are shown and the count says how many wait", async () => {
    signIn();
    const { REVIEW_SHOW_MAX } = await import("@/lib/project-review-queue");
    db.tables.set("project_evidence", Array.from({ length: 130 }, (_, i) => ({
      id: U(1000 + i), project_id: PROJECT, filename: `f${i}.csv`, media_type: "text/csv", sha256: "a".repeat(64), byte_size: 10, storage_ref: STORAGE_REF,
      source_category: "other", review_status: "unverified", evidence_class: null, uploaded_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), note: null,
    })));
    const { reviewQueue } = await import("@/lib/project-review-queue");
    const q = await reviewQueue();
    if (!q.ok) throw new Error(q.error);
    expect(q.files).toHaveLength(REVIEW_SHOW_MAX);
    expect(q.files[0].filename).toBe("f129.csv");
    expect(q.counts.files).toEqual({ shown: REVIEW_SHOW_MAX, pending: 130, truncated: false });
    expect(await page()).toContain(`Showing ${REVIEW_SHOW_MAX} of 130 awaiting a decision, newest first`);
  });

  it("sends exactly what the route takes: decision, name, reason; never a digest, and the URL addresses the file by encoded id", () => {
    expect(fileReviewBody({ decision: "verified", reviewer: "  F. Keane ", reason: " ok " })).toEqual({ decision: "verified", reviewer: "F. Keane", reason: "ok" });
    expect(fileReviewBody({ decision: "rejected", reviewer: "F", reason: "r" })).toEqual({ decision: "rejected", reviewer: "F", reason: "r" });
    expect(reviewUrl("file", "a/b")).toBe("/api/admin/evidence/a%2Fb/review");
    expect(reviewProblems({ decision: "verified", reviewer: "", reason: "r" }, "")).toHaveLength(1);
    expect(reviewProblems({ decision: "verified", reviewer: "x", reason: " " }, "")).toHaveLength(1);
    // the screen's body is accepted by the route verbatim
  });

  it("the body the screen builds is accepted by the route, and a second send is the 409 the screen recognises", async () => {
    signIn();
    const { ALREADY_REVIEWED } = await import("@/lib/project-review-ui");
    const body = fileReviewBody({ decision: "verified", reviewer: "F. Keane", reason: "digest matches" });
    expect((await (await fileRoute()).POST(post("/x", body), ctx(FILE_A))).status).toBe(201);
    const again = await (await fileRoute()).POST(post("/x", body), ctx(FILE_A));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(ALREADY_REVIEWED);
  });

  it("states honestly what a name is, has no default decision, no bulk action and no automatic verification", async () => {
    signIn();
    const html = await page();
    expect(html).toMatch(/one shared password/);
    expect(html).toMatch(/not an authenticated identity/);
    expect(html).toMatch(/server read the stored file back/);
    expect(html).toMatch(/stored bytes are unchanged since upload/);
    expect(html).toMatch(/does not open the file/);                         // it claims no inspection the screen cannot offer
    expect(html).toMatch(/no way to withdraw a mistaken verdict/);
    expect(html).not.toMatch(/you (have )?(inspected|opened|read) the (file|document)/i);
    const src = readFileSync("components/ProjectEvidenceReview.tsx", "utf8");
    expect(src).not.toMatch(/approve all|verify all|bulk approve|auto-?verif/i);
    expect(src.match(/useState<Decision \| "">\(""\)/g)!.length).toBeGreaterThanOrEqual(2);       // both kinds of card start with nothing chosen
    expect(src.match(/fetch\(/g)).toHaveLength(1);                                                // one request per record, through one function
    expect(src).not.toMatch(/sha256_confirmed|storage_ref/);
    void React;
  });

  it("the project panel and the export route say what the gate does not do (unclassified rows, no withdrawal, no recall)", () => {
    const panel = readFileSync("components/ai/ProjectPanel.tsx", "utf8");
    expect(panel).toMatch(/recorded before origin was tracked\s+stay unclassified and are not exported/);
    expect(panel).toMatch(/decision for the owner/);
    const exp = readFileSync("app/api/admin/calibration-export/route.ts", "utf8");
    expect(exp).toMatch(/does not recall a row already imported/);
    expect(exp).toMatch(/no withdrawal of a mistaken verdict/);
    expect(exp).not.toMatch(/traceable to permission/i);
    const env = readFileSync(".env.example", "utf8");
    expect(env).toMatch(/GRIDFORGE_DATA_ORIGIN/);
    expect(env).toMatch(/can only LOWER the claim/);
    expect(env).toMatch(/non-Vercel host/);
    expect(env).toMatch(/MUST set it/);
  });

  it("is unreachable without the admin cookie", async () => {
    await expect(page()).rejects.toThrow(/NEXT_REDIRECT \/admin\/login/);
    expect(db.calls.filter((c) => /project_evidence/.test(c.url))).toHaveLength(0);
  });
});
