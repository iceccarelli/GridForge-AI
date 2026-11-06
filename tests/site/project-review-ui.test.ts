/**
 * The administrator's evidence-review screen: it sends the exact body the existing routes expect, the routes still refuse the
 * unauthenticated and the cross-site, the page needs the admin cookie, and nothing private reaches the markup.
 * Fixtures are SYNTHETIC.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import {
  SELF_REVIEW_MESSAGE,
  actualReviewBody,
  isSelfReview,
  observationReviewBody,
  reviewProblems,
  reviewUrl,
} from "@/lib/project-review-ui";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
const redirected: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirected.push(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

let db: PostgrestFake;
let restore: () => void;

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = U(1), EVID_UNVER = U(2), EVID_OK = U(3), OBS = U(4), ACT = U(5), OBS_DONE = U(6), PKG = U(7), RESP = U(8);
const SECRETS = { projectToken: "SECRET-PROJECT-TOKEN", caseToken: "SECRET-CASE-TOKEN", storage: "project-evidence/SECRET-STORAGE-PATH" };

beforeEach(() => {
  jar.length = 0;
  redirected.length = 0;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake([
    "projects", "project_links", "project_evidence", "project_events", "project_observations", "project_observation_reviews",
    "supplier_actuals", "supplier_actual_reviews", "supplier_reality", "procurement_packages", "procurement_responses",
  ]);
  installProjectRpcs(db);
  db.uniqueKeys.set("project_observation_reviews", [["observation_id"]]); // the real table: one decision per observation (0017)
  restore = db.install();
  db.seed("projects", [{ id: PROJECT, project_token: SECRETS.projectToken, project_name: "Hall A (synthetic)", site_label: "Dublin 1", company: "Acme" }]);
  const ev = (id: string, status: string, name: string) => ({
    id, project_id: PROJECT, filename: name, media_type: "text/csv", sha256: id.replace(/-/g, "").padEnd(64, "a").slice(0, 64), byte_size: 2048,
    storage_ref: SECRETS.storage, source_category: "load_data", review_status: status, evidence_class: null, uploaded_at: "2026-10-01T00:00:00Z",
  });
  db.seed("project_evidence", [ev(EVID_UNVER, "unverified", "meter-export.csv"), ev(EVID_OK, "verified", "commissioning.csv")]);
  db.seed("project_observations", [
    {
      id: OBS, project_id: PROJECT, prediction_ref: `power_deployment_case:${SECRETS.caseToken}:r1:bess`, case_token: SECRETS.caseToken, case_revision: 1,
      architecture: "BESS bridge", calibration_key: "btm.firm_MW", unit: "MW", predicted_value: 20, predicted_source: "engine", observed_value: 18,
      observed_on: "2026-09-30", method: "revenue meter", evidence_id: EVID_UNVER, installed_attested: true, installed_basis: "commissioning record",
      note: null, submitted_by: "A. Rivera", submitted_at: "2026-10-02T10:00:00Z", delta_value: -2, delta_pct: -10, measurement_kind: "metered",
    },
    { id: OBS_DONE, project_id: PROJECT, prediction_ref: "x", case_token: SECRETS.caseToken, architecture: "Already decided", calibration_key: "btm.firm_MW", unit: "MW",
      predicted_value: 1, observed_value: 1, observed_on: "2026-01-01", method: "m", evidence_id: EVID_OK, installed_basis: "b", submitted_by: "Q", submitted_at: "2026-01-02T00:00:00Z", delta_pct: 0 },
  ]);
  db.seed("project_observation_reviews", [{ id: U(90), observation_id: OBS_DONE, project_id: PROJECT, decision: "rejected", reviewer: "Z", reason: "r", reviewed_at: "2026-01-03T00:00:00Z" }]);
  db.seed("supplier_actuals", [
    {
      id: ACT, project_id: PROJECT, package_id: PKG, selected_response_id: RESP, supplier: "Volt Ltd (synthetic)", case_token: SECRETS.caseToken, case_revision: 1,
      architecture: "BESS bridge", quoted_capex_eur: 1000000, po_date: "2026-03-01", dispatch_date: null, on_site_date: "2026-06-01", install_complete_date: null,
      energised_date: null, actual_cost: 1100000, actual_cost_currency: "EUR", cost_scope: "same_as_quote", cost_scope_note: null, evidence_id: EVID_OK,
      method: "PO and delivery note", submitted_by: "B. Chen", submitted_at: "2026-10-03T10:00:00Z", supersedes_id: null, note: null,
    },
  ]);
});
afterEach(() => {
  restore();
  delete process.env.ADMIN_PASSWORD;
});

const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const obsRoute = () => import("@/app/api/admin/observations/[id]/review/route");
const actRoute = () => import("@/app/api/admin/supplier-actuals/[id]/review/route");

describe("the bodies the screen sends", () => {
  const who = { reviewer: "  J. Ortiz ", reason: " meter export matches " };
  it("observation: verify carries decision, the class, reviewer and reason; reject carries no class", () => {
    expect(observationReviewBody({ decision: "verified", ...who }, "E5")).toEqual({ decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", reason: "meter export matches" });
    expect(observationReviewBody({ decision: "rejected", ...who }, "E5")).toEqual({ decision: "rejected", reviewer: "J. Ortiz", reason: "meter export matches" });
  });
  it("supplier record: verify names the facts; reject verifies nothing and sends no fields", () => {
    expect(actualReviewBody({ decision: "verified", ...who }, ["po_date", "actual_cost"])).toEqual({ decision: "verified", verified_fields: ["po_date", "actual_cost"], reviewer: "J. Ortiz", reason: "meter export matches" });
    expect(actualReviewBody({ decision: "rejected", ...who }, ["po_date"])).toEqual({ decision: "rejected", reviewer: "J. Ortiz", reason: "meter export matches" });
  });
  it("urls address the existing routes by encoded id", () => {
    expect(reviewUrl("observation", "a/b")).toBe("/api/admin/observations/a%2Fb/review");
    expect(reviewUrl("actual", "x")).toBe("/api/admin/supplier-actuals/x/review");
  });
  it("name and reason are mandatory, and the submitter cannot be the reviewer (the route's message, verbatim)", () => {
    expect(reviewProblems({ decision: "rejected", reviewer: "", reason: "r" }, "A")).toHaveLength(1);
    expect(reviewProblems({ decision: "rejected", reviewer: "x", reason: "  " }, "A")).toHaveLength(1);
    expect(reviewProblems({ decision: "rejected", reviewer: " a. rivera", reason: "r" }, "A. Rivera")).toEqual([SELF_REVIEW_MESSAGE]);
    expect(isSelfReview("A. RIVERA ", " a. rivera")).toBe(true);
    expect(isSelfReview("", "")).toBe(false);
    expect(reviewProblems({ decision: "verified", reviewer: "x", reason: "r" }, "A", { factsChosen: 0 })).toEqual(["Choose the facts you vouch for."]);
    expect(SELF_REVIEW_MESSAGE).toBe("A submission cannot be reviewed by the person who submitted it.");
  });
  it("the screen's message is the route's", async () => {
    signIn();
    db.tables.get("project_evidence")!.find((e) => e.id === EVID_UNVER)!.review_status = "verified";
    const res = (await obsRoute()).POST(post("/x", observationReviewBody({ decision: "verified", reviewer: "a. rivera", reason: "r" }, "E5")), ctx(OBS));
    const r = await res;
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe(SELF_REVIEW_MESSAGE);
  });
});

describe("the routes behind it still guard themselves", () => {
  it("unauthenticated => 401 and nothing is written", async () => {
    const o = await (await obsRoute()).POST(post("/x", observationReviewBody({ decision: "rejected", reviewer: "J", reason: "r" }, "E5")), ctx(OBS));
    const a = await (await actRoute()).POST(post("/x", actualReviewBody({ decision: "rejected", reviewer: "J", reason: "r" }, [])), ctx(ACT));
    expect([o.status, a.status]).toEqual([401, 401]);
    expect(db.rows("project_observation_reviews")).toHaveLength(1); // only the seeded one
    expect(db.rows("supplier_actual_reviews")).toHaveLength(0);
  });
  it("a cross-site write is refused even with the cookie", async () => {
    signIn();
    const r = await (await obsRoute()).POST(post("/x", { decision: "rejected", reviewer: "J", reason: "r" }, { "sec-fetch-site": "cross-site" }), ctx(OBS));
    expect(r.status).toBe(403);
    expect(db.rows("project_observation_reviews")).toHaveLength(1);
  });
  it("the screen's rejection is accepted verbatim; a second decision on the same record is refused", async () => {
    signIn();
    const body = observationReviewBody({ decision: "rejected", reviewer: "J. Ortiz", reason: "export does not match the meter" }, "E5");
    expect((await (await obsRoute()).POST(post("/x", body), ctx(OBS))).status).toBe(201);
    expect(db.rows("project_observation_reviews").find((r) => r.observation_id === OBS)).toMatchObject({ decision: "rejected", reviewer: "J. Ortiz", evidence_class: null });
    expect((await (await obsRoute()).POST(post("/x", body), ctx(OBS))).status).toBe(409);
  });
  it("verifying while the evidence file is unverified is refused by the server (409), exactly as the screen warns", async () => {
    signIn();
    const r = await (await obsRoute()).POST(post("/x", observationReviewBody({ decision: "verified", reviewer: "J. Ortiz", reason: "ok" }, "E5")), ctx(OBS));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/not verified/);
  });
  it("a verified decision is accepted once the file is verified, with class E5 and the named facts", async () => {
    signIn();
    db.tables.get("project_evidence")!.find((e) => e.id === EVID_UNVER)!.review_status = "verified";
    expect((await (await obsRoute()).POST(post("/x", observationReviewBody({ decision: "verified", reviewer: "J. Ortiz", reason: "ok" }, "E5")), ctx(OBS))).status).toBe(201);
    expect(db.rows("project_observation_reviews").find((r) => r.observation_id === OBS)).toMatchObject({ decision: "verified", evidence_class: "E5" });
    const a = await (await actRoute()).POST(post("/x", actualReviewBody({ decision: "verified", reviewer: "J. Ortiz", reason: "PO seen" }, ["po_date", "actual_cost"])), ctx(ACT));
    expect(a.status).toBe(201);
    expect(db.rows("supplier_actual_reviews")[0]).toMatchObject({ decision: "verified", verified_fields: ["po_date", "actual_cost"] });
  });
  it("a fact the record does not supply cannot be vouched for", async () => {
    signIn();
    const a = await (await actRoute()).POST(post("/x", actualReviewBody({ decision: "verified", reviewer: "J. Ortiz", reason: "r" }, ["energised_date"])), ctx(ACT));
    expect(a.status).toBe(422);
  });
});

describe("the page", () => {
  async function page() {
    const { default: Page } = await import("@/app/admin/reviews/page");
    return renderToStaticMarkup(await Page());
  }
  it("without the admin cookie it redirects to the login and reads nothing", async () => {
    await expect(page()).rejects.toThrow(/NEXT_REDIRECT \/admin\/login/);
    expect(redirected).toEqual(["/admin/login"]);
    expect(db.calls.filter((c) => c.method === "GET" && /project_observations|supplier_actuals/.test(c.url))).toHaveLength(0);
  });
  it("with an invalid cookie it also redirects", async () => {
    jar.push({ name: "gf_admin", value: "1.bogus.bogus" });
    await expect(page()).rejects.toThrow(/NEXT_REDIRECT/);
  });
  it("lists only undecided items with their evidence reference, and leaks no token, case reference or storage path", async () => {
    signIn();
    const html = await page();
    expect(html).toContain("meter-export.csv");
    expect(html).toContain("commissioning.csv");
    expect(html).toContain("A. Rivera");
    expect(html).toContain("Volt Ltd (synthetic)");
    expect(html).not.toContain("Already decided");
    for (const secret of Object.values(SECRETS)) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/power_deployment_case:|case_token|project_token|storage_ref/);
    // the unverified file is called out
    expect(html).toContain("still unverified");
  });
  it("a queue that cannot be read says so and does not read as an empty queue", async () => {
    signIn();
    db.failNext = { status: 500, body: "boom" };
    const html = await page();
    expect(html).toMatch(/could not be read/);
    expect(html).not.toContain("Nothing is awaiting a decision");
  });
  it("makes no claim the code cannot back: no 'Verified Power Record', no bulk or automatic approval", async () => {
    signIn();
    const src = [readFileSync("components/ProjectEvidenceReview.tsx", "utf8"), readFileSync("app/admin/reviews/page.tsx", "utf8")].join("\n");
    const html = await page();
    for (const text of [src, html]) {
      expect(text).not.toMatch(/Verified Power Record/i);
      expect(text).not.toMatch(/approve all|verify all|bulk approve|auto-?verif/i);
    }
  });
  it("the component has no default decision and sends one request per record", () => {
    const src = readFileSync("components/ProjectEvidenceReview.tsx", "utf8");
    expect(src).toContain('useState<Decision | "">("")');
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    void React;
  });
});
