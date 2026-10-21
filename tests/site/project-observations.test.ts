/**
 * Prediction -> observation -> human review.
 *
 * The properties that matter, each asserted on what was actually stored:
 *   - the predicted value is READ from the engine's stored result; a caller cannot supply it
 *   - a submission has no evidence class; only a separate, immutable, human review assigns one
 *   - verifying needs an attached artifact; a class is never inferred or defaulted
 *   - nothing here can reach the calibration ledger — it is a file this code never opens
 */
import { adminToken } from "@/lib/admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

let db: PostgrestFake;
let restore: () => void;
const ARCH = "GRID + BESS + GENERATION";
const CASE = "case-tok-1";

beforeEach(() => {
  jar.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  db = new PostgrestFake([
    "projects", "project_links", "project_events", "project_evidence", "project_observations",
    "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "procurement_packages", "procurement_responses",
    "procurement_comparisons", "power_deployment_cases",
  ]);
  db.uniqueKeys.set("project_observation_reviews", [["observation_id"]]);
  db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
  installProjectRpcs(db);
  db.seed("power_deployment_cases", [{
    case_token: CASE, revision: 1, email: null, request: {}, changed_fields: [],
    engine_provenance: { digest: "c".repeat(64), report_date: "2026-03-01", engine_version: "test" },
    result: { capacity: { target_MW: 35, grid_firm_MW: 10, gap_MW: 25 }, architectures: [
      { label: ARCH, status: "pass", available_MW: 36.4, margin_MW: 1.4, rfq_ready: true, readiness_gates: [] },
      { label: "GRID ONLY", status: "fail", available_MW: 0, margin_MW: -25, rfq_ready: false, readiness_gates: [] },
    ] },
  }]);
  restore = db.install();
});
afterEach(() => { restore(); delete process.env.ADMIN_PASSWORD; });

const json = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });

async function project(attachCase = true, site_label: string | null = "Dublin DC1") {
  const { POST } = await import("@/app/api/projects/route");
  const made: any = await (await POST(json("/api/projects", { project_name: "Hall A", ...(site_label ? { site_label } : {}) }))).json();
  if (attachCase) {
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    await attach(json("/x", { case_token: CASE }), ctx({ token: made.project_token }));
  }
  return { token: made.project_token as string, id: db.rows("projects").find((p) => p.project_token === made.project_token)!.id as string };
}
const evidence = (projectId: string, review_status = "unverified"): string => db.insertRow("project_evidence", {
  project_id: projectId, filename: "meter.csv", media_type: "text/csv", sha256: "a".repeat(64), byte_size: 10,
  storage_ref: "b/x", source_category: "load_data", evidence_class: null, review_status,
}).id as string;
/** A complete, valid submission: its source artifact is attached to THIS project and the installed
 * architecture is attested. Evidence is created per project, so a helper rather than a constant. */
const good = (projectId: string, over: Record<string, unknown> = {}) => ({
  calibration_key: "btm.firm_MW", case_token: CASE, architecture: ARCH, observed_value: 33.0,
  observed_on: "2026-09-30", method: "revenue meter, 30-day export trend", submitted_by: "A. Rivera, site engineer",
  measurement_kind: "metered",
  evidence_id: evidence(projectId, "verified"), attests_installed_architecture: true,
  installed_basis: "commissioning certificate CC-114, signed 2026-09-12", ...over,
});
async function submit(token: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[token]/observations/route");
  const res = await POST(json("/x", body), ctx({ token }));
  return { res, body: (await res.json()) as any };
}
async function review(id: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/admin/observations/[id]/review/route");
  const res = await POST(json("/x", body), ctx({ id }));
  return { res, body: (await res.json()) as any };
}
async function state(token: string) {
  const { GET } = await import("@/app/api/projects/[token]/route");
  return (await (await GET(new Request(siteUrl("/x")), ctx({ token }))).json()) as any;
}

describe("submitting an observation", () => {
  it("reads the prediction from the stored engine result and computes the delta from it", async () => {
    const p = await project();
    const r = await submit(p.token, good(p.id, { predicted_value: 999 })); // a caller-supplied prediction is ignored
    expect(r.res.status).toBe(201);
    const [row] = db.rows("project_observations") as any[];
    expect(row).toMatchObject({
      predicted_value: 36.4, observed_value: 33, unit: "MW", case_revision: 1, architecture: ARCH,
      prediction_ref: `power_deployment_case:${CASE}:r1:${ARCH}`,
      predicted_source: `result.architectures["${ARCH}"].available_MW`,
    });
    expect(row.delta_value).toBeCloseTo(-3.4, 6);
    expect(row.delta_pct).toBeCloseTo(-9.3407, 3);
    // the submission claims no class, and a history event records it
    expect("evidence_class" in row).toBe(false);
    expect(db.rows("project_events").map((e) => e.event_type)).toContain("observation_submitted");
  });

  it("shows up in project state as submitted — not verified, not ledger-eligible", async () => {
    const p = await project();
    await submit(p.token, good(p.id));
    const s = await state(p.token);
    expect(s.observations).toEqual([expect.objectContaining({
      state: "submitted", evidence_class: null, reviewed_by: null, ledger_eligible: false,
      installed_basis: "commissioning certificate CC-114, signed 2026-09-12", predicted_value: 36.4, observed_value: 33,
    })]);
  });

  it("refuses what it cannot honestly reconcile, writing neither a record nor an event", async () => {
    const p = await project();
    const events = db.rows("project_events").length;
    const cases: [Record<string, unknown>, number][] = [
      [{ calibration_key: "btm.capex_eur" }, 422],               // an echo of a declared input, not a model output
      [{ observed_value: -1 }, 422],
      [{ observed_value: 0 }, 422],                              // a plant that delivers nothing is not a measurement of one
      [{ observed_value: 10_001 }, 422],                         // beyond any plant: a typo, not a reading
      [{ observed_value: Number.MAX_VALUE }, 422],
      [{ observed_value: "33" }, 422],
      [{ measurement_kind: "quoted" }, 422],                     // a vendor quote is not a measurement
      [{ measurement_kind: "declared" }, 422],                   // neither is an assumed or customer-stated value
      [{ measurement_kind: "simulated" }, 422],
      [{ measurement_kind: undefined }, 422],
      [{ measurement_kind: "" }, 422],
      [{ observed_on: "2999-01-01" }, 422],
      [{ observed_on: "yesterday" }, 422],
      [{ method: "  " }, 422],
      [{ submitted_by: "" }, 422],
      [{ architecture: "Made up" }, 422],
      [{ architecture: "GRID ONLY" }, 422],                      // predicted 0 MW: nothing to reconcile against
      [{ case_revision: 7 }, 404],
      [{ evidence_id: "not-a-uuid" }, 422],
      [{ evidence_id: undefined }, 422],                         // no source artifact: an unrepairable dead end
      [{ evidence_id: null }, 422],
      [{ attests_installed_architecture: undefined }, 422],      // installation is attested, never inferred
      [{ attests_installed_architecture: false }, 422],
      [{ attests_installed_architecture: "yes" }, 422],
      [{ installed_basis: "  " }, 422],
      [{ installed_basis: undefined }, 422],
    ];
    for (const [over, status] of cases) {
      const r = await submit(p.token, good(p.id, over));
      expect(r.res.status, JSON.stringify(over)).toBe(status);
    }
    expect(db.rows("project_observations")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(events);
  });

  it("does not require the equipment to have been procured through Time to Power", async () => {
    const p = await project();                                  // no RFQ package, no selected supplier
    expect(db.rows("procurement_packages")).toHaveLength(0);
    expect((await submit(p.token, good(p.id))).res.status).toBe(201);
  });

  it("refuses a case the project does not hold, and evidence that belongs to another project", async () => {
    const holder = await project();
    const stranger = await project(false);
    expect((await submit(stranger.token, good(stranger.id))).res.status).toBe(403);
    const foreign = evidence(holder.id);
    expect((await submit(stranger.token, good(stranger.id, { evidence_id: foreign }))).res.status).toBe(403);
    const other = await project();                              // holds the case, but not that artifact
    expect((await submit(other.token, good(other.id, { evidence_id: foreign }))).res.status).toBe(403);
    expect(db.rows("project_observations")).toHaveLength(0);
  });

  it("counts a prediction observed on a given date once", async () => {
    const p = await project();
    const ev = evidence(p.id);
    expect((await submit(p.token, good(p.id, { evidence_id: ev }))).res.status).toBe(201);
    expect((await submit(p.token, good(p.id, { evidence_id: ev, observed_value: 34 }))).res.status).toBe(409);
    expect((await submit(p.token, good(p.id, { evidence_id: ev, observed_value: 34, observed_on: "2026-10-01" }))).res.status).toBe(201);
    expect(db.rows("project_observations")).toHaveLength(2);
  });

  it("is saved with its event or not at all", async () => {
    const p = await project();
    const body = good(p.id);
    db.failEvents = true;
    expect((await submit(p.token, body)).res.status).toBe(502);
    expect(db.rows("project_observations")).toHaveLength(0);
    db.failEvents = false;
    expect((await submit(p.token, body)).res.status).toBe(201);
  });
});

describe("the human review", () => {
  it("is admin-only", async () => {
    const p = await project();
    const o = (await submit(p.token, good(p.id))).body.observation.id;
    expect((await review(o, { decision: "rejected", reviewer: "x" })).res.status).toBe(401);
    expect(db.rows("project_observation_reviews")).toHaveLength(0);
    const { GET } = await import("@/app/api/admin/observations/route");
    expect((await GET(new Request(siteUrl("/x")))).status).toBe(401);
  });

  it("never infers or defaults a class, and a rejection carries none", async () => {
    signIn();
    const p = await project();
    const id = (await submit(p.token, good(p.id))).body.observation.id;
    expect((await review(id, { decision: "verified", reviewer: "J. Ortiz" })).res.status).toBe(422);        // no default class
    expect((await review(id, { decision: "verified", evidence_class: "E9", reviewer: "J. Ortiz" })).res.status).toBe(422);
    expect((await review(id, { decision: "verified", evidence_class: "E5", reviewer: "" })).res.status).toBe(422);
    expect((await review(id, { decision: "rejected", evidence_class: "E5", reviewer: "J. Ortiz" })).res.status).toBe(422);
    expect(db.rows("project_observation_reviews")).toHaveLength(0);
  });

  it("records one immutable decision, by a named person, and shows the class the reviewer chose", async () => {
    signIn();
    const p = await project();
    const id = (await submit(p.token, good(p.id))).body.observation.id;
    const ok = await review(id, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", reason: "meter export matches the submitted trend" });
    expect(ok.res.status).toBe(201);
    expect((await review(id, { decision: "rejected", reviewer: "J. Ortiz" })).res.status).toBe(409); // never flipped
    const [obs] = (await state(p.token)).observations;
    expect(obs).toMatchObject({ state: "verified", evidence_class: "E5", reviewed_by: "J. Ortiz", ledger_eligible: true });
    const ev = db.rows("project_events").find((e) => e.event_type === "observation_reviewed") as any;
    expect(ev).toMatchObject({ actor: "J. Ortiz" });
    expect(ev.payload).toMatchObject({ decision: "verified", evidence_class: "E5" });
  });

  it("a reviewer may assign only E5: E6 and E7 are computation outputs and weaker data is a rejection", async () => {
    signIn();
    const p = await project();
    const a = (await submit(p.token, good(p.id))).body.observation.id;
    for (const cls of ["E0", "E3", "E4", "E6", "E7"]) {
      const r = await review(a, { decision: "verified", evidence_class: cls, reviewer: "J. Ortiz" });
      expect(r.res.status, cls).toBe(422);
    }
    expect(db.rows("project_observation_reviews")).toHaveLength(0);
    const b = (await submit(p.token, good(p.id, { observed_on: "2026-10-01" }))).body.observation.id;
    await review(b, { decision: "rejected", reviewer: "J. Ortiz", reason: "export covers a different meter" });
    const s = (await state(p.token)).observations;
    expect(s.find((o: any) => o.id === b)).toMatchObject({ state: "rejected", evidence_class: null, ledger_eligible: false, ledger_blockers: ["rejected by the reviewer"] });
  });

  it("refuses a review by the person who submitted it, however the name is written", async () => {
    signIn();
    const p = await project();
    const id = (await submit(p.token, good(p.id))).body.observation.id;
    for (const who of ["A. Rivera, site engineer", "  a. rivera, SITE engineer "]) {
      const r = await review(id, { decision: "verified", evidence_class: "E5", reviewer: who });
      expect(r.res.status, who).toBe(403);
    }
    // the stored submitter reference is the project token's hash, and the database refuses that as a reviewer name too
    const stored: any = db.rows("project_observations")[0];
    expect(stored.submitted_by_ref).toBe(createHash("sha256").update(p.token).digest("hex"));
    expect((await review(id, { decision: "rejected", reviewer: stored.submitted_by_ref })).res.status).toBe(403);
    expect(db.rows("project_observation_reviews")).toHaveLength(0);
    expect((await review(id, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" })).res.status).toBe(201);
  });

  it("refuses to verify while the supporting evidence artifact is unverified, but always allows a rejection", async () => {
    signIn();
    const p = await project();
    const id = (await submit(p.token, good(p.id, { evidence_id: evidence(p.id, "unverified") }))).body.observation.id;
    const r = await review(id, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" });
    expect(r.res.status).toBe(409);
    expect(r.body.error).toMatch(/evidence artifact is not verified/);
    expect(db.rows("project_observation_reviews")).toHaveLength(0);
    expect((await review(id, { decision: "rejected", reviewer: "J. Ortiz", reason: "no verified source" })).res.status).toBe(201);
  });

  it("is ledger-eligible only when every gate is cleared, and says which one is not", async () => {
    signIn();
    const p = await project();
    const a = (await submit(p.token, good(p.id))).body.observation.id;
    expect((await state(p.token)).observations[0]).toMatchObject({ ledger_eligible: false, ledger_blockers: ["not reviewed yet"] });
    await review(a, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" });
    expect((await state(p.token)).observations[0]).toMatchObject({
      ledger_eligible: true, ledger_blockers: [], measurement_kind: "metered", evidence_class: "E5",
    });
    // the evidence is withdrawn after the review: no longer eligible
    const ev = db.rows("project_evidence")[0] as any;
    ev.review_status = "rejected";
    expect((await state(p.token)).observations[0]).toMatchObject({ ledger_eligible: false, ledger_blockers: ["the evidence artifact is not verified"] });
    ev.review_status = "verified";
    ev.sha256 = "e".repeat(64);
    expect((await state(p.token)).observations[0].ledger_blockers).toEqual(["the evidence artifact changed after review"]);
  });

  it("derives the site reference and the engine digest in the database, never from the caller", async () => {
    const p = await project();
    await submit(p.token, good(p.id, { site_ref: "site_000000000000", engine_provenance_digest: "f".repeat(64) }));
    const row: any = db.rows("project_observations")[0];
    expect(row.site_ref).toBe(`site_${createHash("sha256").update("dublin dc1").digest("hex").slice(0, 12)}`);
    expect(row.engine_provenance_digest).toBe("c".repeat(64));
    expect(row.report_date).toBe("2026-03-01");
  });

  it("is never ledger-eligible without a site reference or a recorded engine build", async () => {
    signIn();
    const noSite = await project(true, null);
    const a = (await submit(noSite.token, good(noSite.id))).body.observation.id;
    await review(a, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" });
    expect((await state(noSite.token)).observations[0].ledger_blockers).toEqual(["the project has no site label, so there is no site reference"]);
  });

  it("is never ledger-eligible when the case revision predates the recorded engine build", async () => {
    signIn();
    (db.rows("power_deployment_cases")[0] as any).engine_provenance = null;
    const legacy = await project();
    const b = (await submit(legacy.token, good(legacy.id))).body.observation.id;
    await review(b, { decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" });
    expect((await state(legacy.token)).observations[0].ledger_blockers).toEqual(["the prediction's engine build was not recorded"]);
  });
});

describe("the calibration export", () => {
  const exportRow = {
    id: "00000000-0000-4000-8000-0000000000aa", key: "btm.firm_MW", observed_value: "33", predicted_value: 36.4, unit: "MW",
    site_ref: "site_0123456789ab", measurement_kind: "metered", evidence_sha256: "a".repeat(64),
    engine_provenance_digest: "c".repeat(64), report_date: "2026-03-01", observed_on: "2026-09-30",
    method: "revenue meter", evidence_class: "E5", reviewed_by: "J. Ortiz", reviewed_at: "2026-10-02T09:00:00Z",
  };
  const get = async () => (await import("@/app/api/admin/calibration-export/route")).GET();

  it("is admin-only", async () => {
    expect((await get()).status).toBe(401);
  });

  it("is empty — and says so — when nothing has cleared every gate", async () => {
    signIn();
    db.createTable("calibration_ledger_rows");
    const p = await project();
    await submit(p.token, good(p.id));                         // submitted, never reviewed
    const res = await get();
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, schema: "gridforge/calibration-export/1", count: 0, rows: [] });
    expect(body.reviewer_identity).toMatch(/self-asserted/);
  });

  it("returns the view's rows with numbers as numbers, and nothing the view did not select", async () => {
    signIn();
    db.seed("calibration_ledger_rows", [exportRow, { ...exportRow, id: "00000000-0000-4000-8000-0000000000ab", observed_value: "not a number" }]);
    const body: any = await (await get()).json();
    expect(body.count).toBe(1);                                // a row that is not finite is dropped, never repaired
    expect(body.rows[0]).toEqual({ ...exportRow, observed_value: 33 });
    expect(Object.keys(body.rows[0]).sort()).toEqual(Object.keys(exportRow).sort());
  });

  it("fails closed when the view cannot be read", async () => {
    signIn();
    const res = await get();                                   // migration 0038 not applied: the view does not exist
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).rows).toBeUndefined();  // never an empty list that reads as "nothing to import"
  });

  it("lists only the unreviewed in the admin queue by default", async () => {
    signIn();
    const p = await project();
    const a = (await submit(p.token, good(p.id))).body.observation.id;
    await submit(p.token, good(p.id, { observed_on: "2026-10-01" }));
    await review(a, { decision: "rejected", reviewer: "J. Ortiz" });
    const { GET } = await import("@/app/api/admin/observations/route");
    const pending: any = await (await GET(new Request(siteUrl("/x")))).json();
    expect(pending.items).toHaveLength(1);
    const all: any = await (await GET(new Request(siteUrl("/x?state=all")))).json();
    expect(all.items).toHaveLength(2);
  });
});
