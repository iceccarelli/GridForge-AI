/**
 * Prediction -> observation -> human review.
 *
 * The properties that matter, each asserted on what was actually stored:
 *   - the predicted value is READ from the engine's stored result; a caller cannot supply it
 *   - a submission has no evidence class; only a separate, immutable, human review assigns one
 *   - verifying needs an attached artifact; a class is never inferred or defaulted
 *   - nothing here can reach the calibration ledger — it is a file this code never opens
 */
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
    "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality", "procurement_packages", "procurement_responses",
    "procurement_comparisons", "power_deployment_cases",
  ]);
  db.uniqueKeys.set("project_observation_reviews", [["observation_id"]]);
  db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
  installProjectRpcs(db);
  db.seed("power_deployment_cases", [{
    case_token: CASE, revision: 1, email: null, request: {}, changed_fields: [],
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
const signIn = () => jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });

async function project(attachCase = true) {
  const { POST } = await import("@/app/api/projects/route");
  const made: any = await (await POST(json("/api/projects", { project_name: "Hall A" }))).json();
  if (attachCase) {
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    await attach(json("/x", { case_token: CASE }), ctx({ token: made.project_token }));
  }
  return { token: made.project_token as string, id: db.rows("projects").find((p) => p.project_token === made.project_token)!.id as string };
}
const evidence = (projectId: string): string => db.insertRow("project_evidence", {
  project_id: projectId, filename: "meter.csv", media_type: "text/csv", sha256: "a".repeat(64), byte_size: 10,
  storage_ref: "b/x", source_category: "load_data", evidence_class: null, review_status: "unverified",
}).id as string;
/** A complete, valid submission: its source artifact is attached to THIS project and the installed
 * architecture is attested. Evidence is created per project, so a helper rather than a constant. */
const good = (projectId: string, over: Record<string, unknown> = {}) => ({
  calibration_key: "btm.firm_MW", case_token: CASE, architecture: ARCH, observed_value: 33.0,
  observed_on: "2026-09-30", method: "revenue meter, 30-day export trend", submitted_by: "A. Rivera, site engineer",
  evidence_id: evidence(projectId), attests_installed_architecture: true,
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
      [{ observed_value: "33" }, 422],
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

  it("verified below E5 is recorded honestly but is not ledger-eligible; a rejection carries no class", async () => {
    signIn();
    const p = await project();
    const a = (await submit(p.token, good(p.id))).body.observation.id;
    const b = (await submit(p.token, good(p.id, { observed_on: "2026-10-01" }))).body.observation.id;
    await review(a, { decision: "verified", evidence_class: "E3", reviewer: "J. Ortiz" });
    await review(b, { decision: "rejected", reviewer: "J. Ortiz", reason: "export covers a different meter" });
    const s = (await state(p.token)).observations;
    expect(s.find((o: any) => o.id === a)).toMatchObject({ state: "verified", evidence_class: "E3", ledger_eligible: false });
    expect(s.find((o: any) => o.id === b)).toMatchObject({ state: "rejected", evidence_class: null, ledger_eligible: false });
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
