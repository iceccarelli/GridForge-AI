/**
 * The administrator's export checklist: every gate the final calibration view enforces, read per observation, as met / not met / cannot be
 * read. The pure function (ledgerGateChecklist) is tested gate by gate; the reader (exportChecklists) against an in-memory PostgREST that
 * can be told a table does not exist; the screen against the rendered page. A mutation check proves the gate-by-gate test fails if a gate
 * is dropped from the function or can no longer fail. Fixtures are SYNTHETIC.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { LEDGER_GATES, blockingGates, type GateResult } from "@/lib/calibration-gates";
import { exportChecklists } from "@/lib/calibration-gate-inputs";
import { exportBlockers, ledgerBlockers, ledgerGateChecklist, type GateInputs } from "@/lib/project-observations";
import { VERIFIED_SCAN as COMPONENT_SCAN, VERIFIED_SHOWN, GateChecklist, headline } from "@/components/ProjectEvidenceReview";
import { VERIFIED_SCAN, VERIFIED_SHOW_MAX } from "@/lib/project-review-queue";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const o = { measurement_kind: "metered" as const, site_ref: "site_abc", engine_provenance_digest: "d".repeat(64), submitted_by: "A. Rivera", data_origin: "production" as const, observed_on: "2026-09-30" };
const r = { decision: "verified" as const, evidence_class: "E5", reviewer: "J. Ortiz", evidence_sha256: SHA };
const ev = { review_status: "verified", sha256: SHA };
const good: GateInputs = {
  standing: "granted",
  fileDecision: { decision: "verified", sha256_confirmed: SHA },
  siteOrigin: { attachments: 1, nonProduction: 0 },
  forecast: { created_at: "2026-09-01T00:00:00Z", case_digest: "c".repeat(64) },
};
type Fn = typeof ledgerGateChecklist;
const byId = (g: GateResult[]) => Object.fromEntries(g.map((x) => [x.id, x]));
const ALL_IDS = [...LEDGER_GATES.map((g) => g.id), "record_shape"];

/** One scenario per gate in which ONLY that gate fails, and the status it must show. */
const FAILING: { gate: string; label: string; status: "not_met" | "unreadable"; run: (fn: Fn) => GateResult[] }[] = [
  { gate: "independent_review", label: "reviewer is the submitter", status: "not_met", run: (fn) => fn(o, { ...r, reviewer: " a. rivera " }, ev, good) },
  { gate: "independent_review", label: "class below E5", status: "not_met", run: (fn) => fn(o, { ...r, evidence_class: "E4" }, ev, good) },
  { gate: "frozen_forecast", label: "forecast created after the declared date", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, forecast: { created_at: "2026-09-30T00:00:00Z", case_digest: "c".repeat(64) } }) },
  { gate: "frozen_forecast", label: "forecast has no digest", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, forecast: { created_at: "2026-09-01T00:00:00Z", case_digest: null } }) },
  { gate: "frozen_forecast", label: "case revision not found", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, forecast: "missing" }) },
  { gate: "frozen_forecast", label: "case table unreadable", status: "unreadable", run: (fn) => fn(o, r, ev, { ...good, forecast: "unreadable" }) },
  { gate: "production_origin", label: "origin test", status: "not_met", run: (fn) => fn({ ...o, data_origin: "test" }, r, ev, good) },
  { gate: "production_origin", label: "origin unclassified", status: "not_met", run: (fn) => fn({ ...o, data_origin: "unclassified" }, r, ev, good) },
  { gate: "production_origin", label: "origin not recorded", status: "not_met", run: (fn) => fn({ ...o, data_origin: undefined }, r, ev, good) },
  { gate: "owner_permission", label: "no permission on record", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, standing: "none" }) },
  { gate: "owner_permission", label: "permission revoked", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, standing: "revoked" }) },
  { gate: "owner_permission", label: "permission unreadable", status: "unreadable", run: (fn) => fn(o, r, ev, { ...good, standing: "unknown" }) },
  { gate: "file_decision", label: "no file decision", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, fileDecision: "none" }) },
  { gate: "file_decision", label: "file rejected", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, fileDecision: { decision: "rejected", sha256_confirmed: null } }) },
  { gate: "file_decision", label: "confirmed hash differs", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, fileDecision: { decision: "verified", sha256_confirmed: OTHER_SHA } }) },
  { gate: "file_decision", label: "file changed after review", status: "not_met", run: (fn) => fn(o, r, { ...ev, sha256: OTHER_SHA }, { ...good, fileDecision: { decision: "verified", sha256_confirmed: OTHER_SHA } }) },
  { gate: "file_decision", label: "file status unverified", status: "not_met", run: (fn) => fn(o, r, { ...ev, review_status: "unverified" }, good) },
  { gate: "file_decision", label: "file decision unreadable", status: "unreadable", run: (fn) => fn(o, r, ev, { ...good, fileDecision: "unreadable" }) },
  { gate: "never_test_site", label: "filed under a test site", status: "not_met", run: (fn) => fn(o, r, ev, { ...good, siteOrigin: { attachments: 2, nonProduction: 1 } }) },
  { gate: "never_test_site", label: "site history unreadable", status: "unreadable", run: (fn) => fn(o, r, ev, { ...good, siteOrigin: "unreadable" }) },
  { gate: "record_shape", label: "no measurement kind", status: "not_met", run: (fn) => fn({ ...o, measurement_kind: null }, r, ev, good) },
  { gate: "record_shape", label: "no site reference", status: "not_met", run: (fn) => fn({ ...o, site_ref: null }, r, ev, good) },
  { gate: "record_shape", label: "no engine digest", status: "not_met", run: (fn) => fn({ ...o, engine_provenance_digest: null }, r, ev, good) },
];

/** Which gates a checklist implementation fails to show failing (empty for a correct one). The mutation check feeds it broken copies. */
function gatesThatDoNotBite(fn: Fn): string[] {
  const missed = new Set<string>();
  for (const s of FAILING) {
    const g = byId(s.run(fn))[s.gate];
    if (!g || g.status !== s.status) missed.add(s.gate);
  }
  return [...missed];
}

describe("every gate, individually", () => {
  it("with everything in order every gate is met, the forecast marked as checked in part, and nothing blocks", () => {
    const g = ledgerGateChecklist(o, r, ev, good);
    expect(g.map((x) => x.id)).toEqual(ALL_IDS);
    expect(g.every((x) => x.status === "met")).toBe(true);
    expect(byId(g).frozen_forecast.partial).toBe(true);
    expect(byId(g).frozen_forecast.reason).toMatch(/Not checked here: that the digest still matches/);
    expect(blockingGates(g)).toEqual([]);
    expect(exportBlockers(g)).toEqual([]);
  });

  it.each(FAILING.map((s) => [s.gate, s.label, s] as const))("%s: %s fails only that gate, with a reason", (gate, _label, s) => {
    const g = s.run(ledgerGateChecklist);
    const failing = g.filter((x) => x.status !== "met");
    expect(failing.map((x) => x.id)).toEqual([gate]);
    expect(failing[0].status).toBe(s.status);
    expect(failing[0].reason.length).toBeGreaterThan(10);
    // a gate that could not be read blocks like one that is not met
    expect(exportBlockers(g)).toHaveLength(1);
  });

  it("an unreviewed observation: the review gate and the file gate (which needs the reviewer's recorded digest) are not met; the rest are still read", () => {
    const g = byId(ledgerGateChecklist(o, null, ev, good));
    expect(g.independent_review).toMatchObject({ status: "not_met", reason: "not reviewed yet" });
    expect(g.file_decision.status).toBe("not_met");
    expect(g.file_decision.reason).toMatch(/has not been reviewed/);
    for (const id of ["frozen_forecast", "production_origin", "owner_permission", "never_test_site", "record_shape"]) expect(g[id].status, id).toBe("met");
    const rejected = byId(ledgerGateChecklist(o, { ...r, decision: "rejected" }, ev, good));
    expect(rejected.independent_review.reason).toBe("rejected by the reviewer");
  });

  it("is built on the blockers the project panel shows: where the panel names a blocker, the checklist names the same words", () => {
    const cases: [Parameters<Fn>[0], Parameters<Fn>[1], Parameters<Fn>[2], GateInputs["standing"]][] = [
      [{ ...o, data_origin: "test" }, r, ev, "granted"],
      [o, { ...r, reviewer: "a. rivera" }, ev, "none"],
      [{ ...o, site_ref: null }, { ...r, evidence_class: "E4" }, { ...ev, sha256: OTHER_SHA }, "revoked"],
    ];
    for (const [oo, rr, ee, standing] of cases) {
      const panel = ledgerBlockers(oo, rr, ee, standing);
      const sheet = ledgerGateChecklist(oo, rr, ee, { ...good, standing }).map((g) => g.reason).join(" | ");
      for (const b of panel) expect(sheet, b).toContain(b);
    }
  });
});

describe("the mutation check: dropping a gate, or making one unable to fail, is caught", () => {
  it("the real function bites on every gate", () => {
    expect(gatesThatDoNotBite(ledgerGateChecklist)).toEqual([]);
    expect(new Set(FAILING.map((s) => s.gate))).toEqual(new Set(ALL_IDS));
  });

  it.each(ALL_IDS)("a copy of the function without the %s gate is reported", (gate) => {
    const mutant: Fn = (...a) => ledgerGateChecklist(...a).filter((g) => g.id !== gate);
    expect(gatesThatDoNotBite(mutant)).toEqual([gate]);
  });

  it.each(ALL_IDS)("a copy in which the %s gate is always met is reported", (gate) => {
    const mutant: Fn = (...a) => ledgerGateChecklist(...a).map((g) => (g.id === gate ? { ...g, status: "met" as const, reason: "ok" } : g));
    expect(gatesThatDoNotBite(mutant)).toEqual([gate]);
  });

  it("a copy that reports an unreadable record as met is reported", () => {
    const mutant: Fn = (...a) => ledgerGateChecklist(...a).map((g) => (g.status === "unreadable" ? { ...g, status: "met" as const } : g));
    expect(gatesThatDoNotBite(mutant).sort()).toEqual(["file_decision", "frozen_forecast", "never_test_site", "owner_permission"]);
  });
});

// --- the reader, against an in-memory PostgREST ---------------------------------------------------------------------------------

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = U(1), EVID = U(2), OBS = U(3), SITE = U(4), HALL = U(5);
const CASE_TOKEN = "SECRET-CASE-TOKEN";
let db: PostgrestFake;
let restore: () => void;

function seedAllMet() {
  db.seed("projects", [{ id: PROJECT, project_token: "SECRET-PROJECT-TOKEN", project_name: "Hall A (synthetic)", site_label: "Dublin 1", company: "Acme" }]);
  db.seed("project_evidence", [{ id: EVID, project_id: PROJECT, filename: "meter.csv", media_type: "text/csv", sha256: SHA, byte_size: 2048, storage_ref: "project-evidence/SECRET-STORAGE", source_category: "load_data", review_status: "verified", uploaded_at: "2026-09-02T00:00:00Z" }]);
  db.seed("project_observations", [{
    id: OBS, project_id: PROJECT, prediction_ref: `power_deployment_case:${CASE_TOKEN}:r1:bess`, case_token: CASE_TOKEN, case_revision: 1, architecture: "BESS bridge",
    calibration_key: "btm.firm_MW", unit: "MW", predicted_value: 20, observed_value: 18, observed_on: "2026-09-30", method: "revenue meter", evidence_id: EVID,
    installed_basis: "commissioning record", note: null, submitted_by: "A. Rivera", submitted_at: "2026-10-02T10:00:00Z", delta_value: -2, delta_pct: -10,
    measurement_kind: "metered", site_ref: "site_abc", engine_provenance_digest: "d".repeat(64), data_origin: "production",
  }]);
  db.seed("project_observation_reviews", [{ id: U(10), observation_id: OBS, project_id: PROJECT, decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", reason: "ok", reviewed_at: "2026-10-03T00:00:00Z", evidence_sha256: SHA }]);
  db.seed("power_deployment_cases", [{ case_token: CASE_TOKEN, revision: 1, created_at: "2026-09-01T00:00:00Z", case_digest: "c".repeat(64), request: { secret: "SECRET-REQUEST" }, result: { secret: "SECRET-RESULT" } }]);
  db.seed("calibration_permissions", [
    { scope_type: "project", scope_id: PROJECT, kind: "granted", seq: 1, granted_by_email: "owner@example.test" },
  ]);
  db.seed("project_evidence_reviews", [{ evidence_id: EVID, project_id: PROJECT, decision: "verified", sha256_confirmed: SHA, reviewer: "K", reason: "r" }]);
  db.seed("sites", [{ id: SITE, name: "Real site", data_origin: "production" }]);
  db.seed("hall_project_attachments", [{ project_id: PROJECT, site_id: SITE, hall_id: HALL }]);
}

const subject = () => {
  const observation = db.rows("project_observations")[0] as never;
  const review = db.rows("project_observation_reviews")[0] as never;
  const evidence = db.rows("project_evidence")[0] as never;
  return { observation, review, evidence: { review_status: (evidence as { review_status: string }).review_status, sha256: (evidence as { sha256: string }).sha256 } };
};
const read = async () => (await exportChecklists([subject()])).get(OBS)!;

beforeEach(() => {
  jar.length = 0;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["projects", "project_links", "project_evidence", "project_events", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews"]);
  installProjectRpcs(db);
  restore = db.install();
  seedAllMet();
});
afterEach(() => {
  restore();
  delete process.env.ADMIN_PASSWORD;
});

describe("the reader (service-role queries) feeds the same function", () => {
  it("all met when every record says so; reads only the columns it needs, never a request or result", async () => {
    const g = await read();
    expect(g.map((x) => x.id)).toEqual(ALL_IDS);
    expect(blockingGates(g)).toEqual([]);
    for (const c of db.calls) {
      const u = decodeURIComponent(c.url);
      if (u.includes("power_deployment_cases")) expect(u).toContain("select=case_token,revision,created_at,case_digest");
      expect(u, u).not.toMatch(/select=\*/);
    }
  });

  it("the newest permission row decides: a later revocation blocks, an older one does not", async () => {
    db.rows("calibration_permissions").push({ scope_type: "project", scope_id: PROJECT, kind: "revoked", seq: 2 });
    expect(byId(await read()).owner_permission.status).toBe("not_met");
    db.rows("calibration_permissions").push({ scope_type: "project", scope_id: PROJECT, kind: "granted", seq: 3 });
    expect(byId(await read()).owner_permission.status).toBe("met");
  });

  it("no permission row on record is not met, not unreadable", async () => {
    db.tables.set("calibration_permissions", []);
    expect(byId(await read()).owner_permission).toMatchObject({ status: "not_met" });
  });

  it("a file decision that is absent, rejected or for another digest blocks", async () => {
    db.tables.set("project_evidence_reviews", []);
    expect(byId(await read()).file_decision.status).toBe("not_met");
    db.tables.set("project_evidence_reviews", [{ evidence_id: EVID, decision: "rejected", sha256_confirmed: null }]);
    expect(byId(await read()).file_decision.status).toBe("not_met");
    db.tables.set("project_evidence_reviews", [{ evidence_id: EVID, decision: "verified", sha256_confirmed: OTHER_SHA }]);
    expect(byId(await read()).file_decision.status).toBe("not_met");
  });

  it("a project ever attached to a test or synthetic site blocks, even if it also sits in a production one", async () => {
    const other = U(40);
    db.seed("sites", [{ id: other, name: "Rehearsal", data_origin: "synthetic" }]);
    db.rows("hall_project_attachments").push({ project_id: PROJECT, site_id: other, hall_id: U(41) });
    const g = byId(await read());
    expect(g.never_test_site.status).toBe("not_met");
    expect(g.never_test_site.reason).toMatch(/1 attachment/);
  });

  it("a project never attached to any hall passes that gate", async () => {
    db.tables.set("hall_project_attachments", []);
    expect(byId(await read()).never_test_site).toMatchObject({ status: "met", reason: "The project has never been filed under any site." });
  });

  it.each([
    ["calibration_permissions", "owner_permission"],
    ["project_evidence_reviews", "file_decision"],
    ["hall_project_attachments", "never_test_site"],
    ["power_deployment_cases", "frozen_forecast"],
  ])("when %s does not exist (HTTP 404) the %s gate says it cannot be read, never met", async (table, gate) => {
    db.dropTable(table);
    const g = byId(await read());
    expect(g[gate].status).toBe("unreadable");
    expect(g[gate].reason).toMatch(/could not be read/);
    for (const other of ALL_IDS.filter((id) => id !== gate)) expect(g[other].status, other).toBe("met");
  });

  it("when the sites table is missing, a project with attachments cannot be called clean; one with none can", async () => {
    db.dropTable("sites");
    expect(byId(await read()).never_test_site.status).toBe("unreadable");
    db.tables.set("hall_project_attachments", []);
    expect(byId(await read()).never_test_site.status).toBe("met");
  });

  it("a failed read of every table never produces a met gate for what it decides", async () => {
    for (const t of ["calibration_permissions", "project_evidence_reviews", "hall_project_attachments", "power_deployment_cases", "sites"]) db.dropTable(t);
    const g = byId(await read());
    for (const id of ["owner_permission", "file_decision", "never_test_site", "frozen_forecast"]) expect(g[id].status, id).toBe("unreadable");
    expect(exportBlockers(Object.values(g)).length).toBe(4);
  });
});

describe("the admin screen", () => {
  const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
  const text = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("shows each pending observation's gates and the verified ones' gates, with statuses as words", async () => {
    // one pending (no review) and the verified one from the seed
    db.rows("project_observations").push({ ...db.rows("project_observations")[0], id: U(20), architecture: "Pending arch", submitted_at: "2026-10-04T00:00:00Z", observed_on: "2026-09-29" });
    signIn();
    const { default: Page } = await import("@/app/admin/reviews/page");
    const html = renderToStaticMarkup(await Page());
    const t = text(html);
    expect(t).toContain("Verified observations: what still blocks the export (1)");
    // the verified one: the forecast gate is checked in part, so the headline must not claim every gate was met
    expect(t).toContain("No gate blocks here; the forecast digest and predicted value are checked only by the export view.");
    expect(t).not.toMatch(/every gate read and met/i);
    expect(t).toMatch(/Export gates: \d of 7 blocking the export/); // the pending one: not reviewed, file gate waits for the review
    for (const g of LEDGER_GATES) expect(t).toContain(g.title);
    expect(t).toContain("Met");
    expect(t).toContain("Not met");
    expect(t).toContain("Verified as E5 by J. Ortiz (a typed name)");
    // reviewer identity copy is preserved
    expect(t).toContain("one shared password");
  });

  it("leaks no token, storage path, request, result or e-mail address", async () => {
    signIn();
    const { default: Page } = await import("@/app/admin/reviews/page");
    const html = renderToStaticMarkup(await Page());
    for (const secret of ["SECRET-CASE-TOKEN", "SECRET-PROJECT-TOKEN", "SECRET-STORAGE", "SECRET-REQUEST", "SECRET-RESULT", "owner@example.test", CASE_TOKEN]) expect(html, secret).not.toContain(secret);
  });

  it("says the verified list could not be read rather than showing none, and a missing table never shows a met gate", async () => {
    db.failNext = null;
    for (const t of ["calibration_permissions", "project_evidence_reviews", "hall_project_attachments", "power_deployment_cases"]) db.dropTable(t);
    signIn();
    const { default: Page } = await import("@/app/admin/reviews/page");
    const t = text(renderToStaticMarkup(await Page()));
    expect(t).toContain("Cannot be read");
    expect(t).toMatch(/Export gates: 4 of 7 blocking the export/);
  });

  it("is still behind the admin cookie", async () => {
    const { default: Page } = await import("@/app/admin/reviews/page");
    await expect(Page()).rejects.toThrow(/NEXT_REDIRECT \/admin\/login/);
  });

  it("the component's counts mirror the queue's", () => {
    expect(VERIFIED_SHOWN).toBe(VERIFIED_SHOW_MAX);
    expect(COMPONENT_SCAN).toBe(VERIFIED_SCAN);
  });

  it("GateChecklist writes the status as a word and marks a partial check", () => {
    const html = renderToStaticMarkup(React.createElement(GateChecklist, { gates: ledgerGateChecklist(o, r, ev, { ...good, standing: "unknown" }), label: "Export gates" }));
    const t = text(html);
    expect(t).toContain("Cannot be read");
    expect(t).toContain("checked in part");
    expect(t).toContain("1 of 7 blocking the export");
  });
});

describe("the headline never overstates what was checked", () => {
  it("with the forecast gate checked in part it never says every gate, whatever else is true", () => {
    const allMet = ledgerGateChecklist(o, r, ev, good);
    expect(allMet.some((g) => g.partial)).toBe(true);
    const h = headline(allMet, blockingGates(allMet));
    expect(h).toBe("No gate blocks here; the forecast digest and predicted value are checked only by the export view.");
    expect(h).not.toMatch(/every gate/i);
    const html = text0(renderToStaticMarkup(React.createElement(GateChecklist, { gates: allMet, label: "Export gates" })));
    expect(html).toContain(h);
    expect(html).not.toMatch(/every gate/i);
  });
  it("blocking gates are counted first; only a checklist with nothing partial and nothing blocking may say every gate", () => {
    const blocked = ledgerGateChecklist(o, r, ev, { ...good, standing: "none" });
    expect(headline(blocked, blockingGates(blocked))).toBe("Export gates: 1 of 7 blocking the export");
    const full = ledgerGateChecklist(o, r, ev, good).map((g) => ({ ...g, partial: undefined }));
    expect(headline(full, [])).toMatch(/every gate read and met here/);
  });
});

describe("reads that may have been cut short, and column lists", () => {
  it("a batch that comes back full (Supabase's max-rows) is unreadable, not complete", async () => {
    db.tables.set("calibration_permissions", Array.from({ length: 1000 }, (_, i) => ({ scope_type: "project", scope_id: PROJECT, kind: "granted", seq: i + 1 })));
    const g = byId(await read());
    expect(g.owner_permission.status).toBe("unreadable");
    db.tables.set("calibration_permissions", Array.from({ length: 999 }, (_, i) => ({ scope_type: "project", scope_id: PROJECT, kind: "granted", seq: i + 1 })));
    expect(byId(await read()).owner_permission.status).toBe("met");
  });

  it("the verified-list reads name their columns: no select=*, and no prediction_ref (it embeds the case token)", async () => {
    const { reviewQueue } = await import("@/lib/project-review-queue");
    db.calls.length = 0;
    const q = await reviewQueue();
    expect(q.ok).toBe(true);
    const reads = db.calls.map((c) => decodeURIComponent(c.url));
    const recent = reads.filter((u) => u.includes("project_observations?select=id,project_id,case_token") && u.includes("limit=100"));
    expect(recent).toHaveLength(1);
    expect(recent[0]).not.toContain("select=*");
    expect(recent[0]).not.toContain("prediction_ref");
    const revs = reads.filter((u) => u.includes("project_observation_reviews?observation_id=in.("));
    expect(revs.length).toBeGreaterThan(0);
    for (const u of revs.filter((x) => x.includes("evidence_sha256"))) expect(u).not.toContain("select=*");
  });

  it("an empty verified list says what was searched, not that nothing was ever verified", async () => {
    db.tables.set("project_observation_reviews", []);
    signIn0();
    const { default: Page } = await import("@/app/admin/reviews/page");
    const t = text0(renderToStaticMarkup(await Page()));
    expect(t).toContain("None among the 100 most recently submitted observations.");
    expect(t).not.toContain("No observation has been verified");
  });
});

const text0 = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const signIn0 = () => jar.push({ name: "gf_admin", value: adminToken()! });
