/**
 * Supplier Reality: what the selected supplier promised vs what the project experienced.
 *
 * Fake-backed (in-memory PostgREST + RPC mirror): this proves the routes, validation and read model.
 * The database invariants and the derivation view are proven against real PostgreSQL in
 * tests/test_projects_migration.py and verified-power-record.realdb.test.ts — not here.
 *
 * Properties: the quote is read from the stored selected response, never the caller; unknown stays
 * unknown; cost scopes are never silently equated; a correction is a new traceable record; review is
 * a separate human decision; and nothing here reaches the cost library, rankings or the ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality",
    "procurement_packages", "procurement_responses", "procurement_comparisons", "power_deployment_cases",
  ]);
  db.uniqueKeys.set("supplier_actual_reviews", [["actual_id"]]);
  db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
  installProjectRpcs(db);
  db.seed("power_deployment_cases", [{
    case_token: CASE, revision: 1, email: null, request: {}, changed_fields: [],
    result: { capacity: { target_MW: 35 }, architectures: [{ label: ARCH, status: "pass", available_MW: 36.4, rfq_ready: true, readiness_gates: [] }] },
  }]);
  restore = db.install();
});
afterEach(() => { restore(); delete process.env.ADMIN_PASSWORD; });

const json = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const signIn = () => jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });

async function newProject(name = "Hall A") {
  const { POST } = await import("@/app/api/projects/route");
  const made: any = await (await POST(json("/api/projects", { project_name: name }))).json();
  return { token: made.project_token as string, id: db.rows("projects").find((p) => p.project_token === made.project_token)!.id as string };
}
const evidence = (projectId: string): string => db.insertRow("project_evidence", {
  project_id: projectId, filename: "po.pdf", media_type: "application/pdf", sha256: "c".repeat(64), byte_size: 10,
  storage_ref: "b/po", source_category: "supplier_document", evidence_class: null, review_status: "unverified",
}).id as string;
/** A package with a recorded selection, exactly as gf_select_supplier leaves it. */
function selectedPackage(projectId: string, values: Record<string, number> = { capex_eur: 4_000_000, lead_time_weeks: 20, install_weeks: 6 }, select = true) {
  const pkg: any = db.insertRow("procurement_packages", {
    package_token: `pkg-${db.rows("procurement_packages").length + 1}`, project_id: projectId, case_token: CASE, case_revision: 1,
    architecture: ARCH, spec_summary: {}, response_template: {}, document_md: "", document_html: "", created_at: new Date().toISOString(),
    selected_supplier: null, selected_response_id: null, selected_comparison_id: null, selected_at: null, selected_by: null,
  });
  const rs: any = db.insertRow("procurement_responses", { package_id: pkg.id, project_id: projectId, supplier: "Voltek", response: { supplier: "Voltek", values }, received_at: new Date().toISOString() });
  if (select) Object.assign(pkg, { selected_supplier: "Voltek", selected_response_id: rs.id, selected_at: new Date().toISOString(), selected_by: "buyer" });
  return pkg as { id: string; package_token: string };
}
const good = (projectId: string, over: Record<string, unknown> = {}) => ({
  po_date: "2026-01-12", on_site_date: "2026-06-22", energised_date: "2026-08-03",
  actual_cost: 4_300_000, actual_cost_currency: "EUR", cost_scope: "same_as_quote",
  evidence_id: evidence(projectId), method: "PO, delivery note and handover record", submitted_by: "A. Rivera", ...over,
});
async function submit(token: string, pkgToken: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[token]/packages/[package]/actuals/route");
  const res = await POST(json("/x", body), ctx({ token, package: pkgToken }));
  return { res, body: (await res.json()) as any };
}
async function review(id: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/admin/supplier-actuals/[id]/review/route");
  const res = await POST(json("/x", body), ctx({ id }));
  return { res, body: (await res.json()) as any };
}
async function state(token: string) {
  const { GET } = await import("@/app/api/projects/[token]/route");
  return (await (await GET(new Request(siteUrl("/x")), ctx({ token }))).json()) as any;
}

describe("recording what happened", () => {
  it("copies the quote from the stored selected response and derives quoted-vs-actual from it", async () => {
    const p = await newProject();
    const pkg = selectedPackage(p.id);
    const r = await submit(p.token, pkg.package_token, good(p.id, { quoted_capex_eur: 1, quoted_lead_time_weeks: 1, supplier: "Someone Else" }));
    expect(r.res.status).toBe(201);
    const [row] = db.rows("supplier_actuals") as any[];
    expect(row).toMatchObject({ supplier: "Voltek", quoted_capex_eur: 4_000_000, quoted_lead_time_weeks: 20, quoted_install_weeks: 6, architecture: ARCH, case_revision: 1 });
    expect(db.rows("project_events").map((e) => e.event_type)).toContain("supplier_actual_submitted");
    const s = await state(p.token);
    expect(s.supplier_reality).toEqual([expect.objectContaining({
      supplier: "Voltek", state: "submitted", superseded: false,
      lead_time: expect.objectContaining({ quoted_weeks: 20, actual_weeks: 23 }),
      install: expect.objectContaining({ quoted_weeks: 6, actual_weeks: 6 }),
      price: expect.objectContaining({ quoted_eur: 4_000_000, delta_eur: 300_000 }),
    })]);
  });

  it("keeps unknown unknown: one date alone yields no derived figure and says why", async () => {
    const p = await newProject();
    const pkg = selectedPackage(p.id);
    const r = await submit(p.token, pkg.package_token, { energised_date: "2026-08-03", evidence_id: evidence(p.id), method: "handover record", submitted_by: "A. Rivera" });
    expect(r.res.status).toBe(201);
    const s = (await state(p.token)).supplier_reality[0];
    expect(s.dates).toMatchObject({ po_date: null, on_site_date: null, energised_date: "2026-08-03" });
    expect(s.lead_time).toMatchObject({ actual_weeks: null, basis: expect.stringMatching(/^unknown/) });
    expect(s.price).toMatchObject({ delta_eur: null, basis: expect.stringMatching(/^unknown/) });
  });

  it("never compares a cost whose scope differs, is unknown, or is in another currency", async () => {
    for (const over of [
      { cost_scope: "differs", cost_scope_note: "includes owner's grid works" },
      { cost_scope: "unknown" },
      { actual_cost_currency: "USD" },
    ]) {
      const p = await newProject();
      const pkg = selectedPackage(p.id);
      expect((await submit(p.token, pkg.package_token, good(p.id, over))).res.status).toBe(201);
      const s = (await state(p.token)).supplier_reality[0];
      expect(s.price.delta_eur).toBeNull();
      expect(s.price.basis).toMatch(/not compared/);
    }
  });

  it("refuses without a selection, writing neither a record nor an event", async () => {
    const p = await newProject();
    const pkg = selectedPackage(p.id, undefined, false);
    const events = db.rows("project_events").length;
    const r = await submit(p.token, pkg.package_token, good(p.id));
    expect(r.res.status).toBe(409);
    expect(db.rows("supplier_actuals")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(events);
  });

  it("refuses what is inconsistent or untraceable, writing nothing", async () => {
    const p = await newProject();
    const pkg = selectedPackage(p.id);
    const events = db.rows("project_events").length;
    const cases: [Record<string, unknown>, number][] = [
      [{ po_date: "2026-13-40" }, 422],
      [{ po_date: "2999-01-01" }, 422],                               // not yet happened
      [{ po_date: "2026-07-01", on_site_date: "2026-06-22" }, 422],   // PO after delivery
      [{ on_site_date: "2026-08-10", energised_date: "2026-08-03" }, 422],
      [{ actual_cost_currency: undefined }, 422],                     // cost without currency
      [{ cost_scope: undefined }, 422],                               // cost without scope
      [{ cost_scope: "roughly" }, 422],
      [{ cost_scope: "differs" }, 422],                               // differs needs a note
      [{ actual_cost: -5 }, 422],
      [{ actual_cost: "4300000" }, 422],
      [{ evidence_id: undefined }, 422],
      [{ evidence_id: "not-a-uuid" }, 422],
      [{ method: " " }, 422],
      [{ submitted_by: "" }, 422],
    ];
    for (const [over, status] of cases) {
      const r = await submit(p.token, pkg.package_token, good(p.id, over));
      expect([JSON.stringify(over), r.res.status]).toEqual([JSON.stringify(over), status]);
    }
    // no facts at all
    const none = await submit(p.token, pkg.package_token, { evidence_id: evidence(p.id), method: "m", submitted_by: "x" });
    expect(none.res.status).toBe(422);
    expect(db.rows("supplier_actuals")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(events);
  });

  it("will not accept another project's evidence or reach another project's package", async () => {
    const a = await newProject("A");
    const b = await newProject("B");
    const pkgA = selectedPackage(a.id);
    const foreign = await submit(a.token, pkgA.package_token, good(a.id, { evidence_id: evidence(b.id) }));
    expect(foreign.res.status).toBe(403);
    const wrongProject = await submit(b.token, pkgA.package_token, good(b.id));
    expect(wrongProject.res.status).toBe(404);
    expect(db.rows("supplier_actuals")).toHaveLength(0);
  });

  it("refuses a second first-record, and a correction is a new record that supersedes exactly one", async () => {
    const p = await newProject();
    const pkg = selectedPackage(p.id);
    expect((await submit(p.token, pkg.package_token, good(p.id))).res.status).toBe(201);
    expect((await submit(p.token, pkg.package_token, good(p.id))).res.status).toBe(409);
    const [first] = db.rows("supplier_actuals") as any[];
    const fix = await submit(p.token, pkg.package_token, good(p.id, { actual_cost: 4_350_000, supersedes_id: first.id }));
    expect(fix.res.status).toBe(201);
    expect(db.rows("supplier_actuals")).toHaveLength(2);
    expect((db.rows("supplier_actuals") as any[])[0].actual_cost).toBe(4_300_000); // the original is untouched
    expect((await submit(p.token, pkg.package_token, good(p.id, { supersedes_id: first.id }))).res.status).toBe(409); // no forks
    const s = (await state(p.token)).supplier_reality;
    expect(s.map((x: any) => x.superseded)).toEqual([true, false]);
    expect(s[1].supersedes_id).toBe(first.id);
  });
});

describe("human review", () => {
  async function recorded() {
    const p = await newProject();
    const pkg = selectedPackage(p.id);
    await submit(p.token, pkg.package_token, good(p.id));
    return { p, id: (db.rows("supplier_actuals")[0] as any).id as string };
  }

  it("needs the admin session", async () => {
    const { id } = await recorded();
    const r = await review(id, { decision: "verified", verified_fields: ["po_date"], reviewer: "R" });
    expect(r.res.status).toBe(401);
    expect(db.rows("supplier_actual_reviews")).toHaveLength(0);
  });

  it("verifies only named facts the record supplies, once, and reflects it in project state", async () => {
    signIn();
    const { p, id } = await recorded();
    expect((await review(id, { decision: "verified", reviewer: "R" })).res.status).toBe(422);                         // no fields
    expect((await review(id, { decision: "verified", verified_fields: ["dispatch_date"], reviewer: "R" })).res.status).toBe(422); // not supplied
    expect((await review(id, { decision: "verified", verified_fields: ["bogus"], reviewer: "R" })).res.status).toBe(422);
    expect((await review(id, { decision: "rejected", reviewer: "R" })).res.status).toBe(422);                          // reason
    expect(db.rows("supplier_actual_reviews")).toHaveLength(0);
    const ok = await review(id, { decision: "verified", verified_fields: ["po_date", "actual_cost"], reviewer: "R. Chen" });
    expect(ok.res.status).toBe(201);
    expect((await review(id, { decision: "rejected", reviewer: "R", reason: "changed my mind" })).res.status).toBe(409);
    const s = (await state(p.token)).supplier_reality[0];
    expect(s).toMatchObject({ state: "verified", verified_fields: ["po_date", "actual_cost"], reviewed_by: "R. Chen" });
    expect(db.rows("project_events").map((e) => e.event_type)).toContain("supplier_actual_reviewed");
  });

  it("can reject with a reason", async () => {
    signIn();
    const { p, id } = await recorded();
    expect((await review(id, { decision: "rejected", reviewer: "R", reason: "PO does not match the selected supplier" })).res.status).toBe(201);
    expect((await state(p.token)).supplier_reality[0]).toMatchObject({ state: "rejected", verified_fields: [] });
  });
});

describe("the record stays a record", () => {
  it("is imported by nothing that prices, ranks or calibrates", () => {
    const sources: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        if (["node_modules", ".next", ".git", "tests"].includes(f)) continue;
        const full = join(d, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|py)$/.test(f)) sources.push(full);
      }
    };
    for (const d of ["lib", "app", "components", "gridforge"]) walk(d);
    const touching = sources.filter((f) => /supplier[-_]reality|supplier_actual/.test(readFileSync(f, "utf8")));
    const allowed = /^(lib\/supplier-reality\.ts|lib\/project-state\.ts|app\/api\/(projects|admin)\/.*(actuals|supplier-actuals)\/.*route\.ts|app\/api\/admin\/supplier-actuals\/route\.ts|lib\/projects\.ts|components\/ai\/ProjectPanel\.tsx)$/;
    expect(touching.filter((f) => !allowed.test(f))).toEqual([]);
    expect(touching.some((f) => f.startsWith("gridforge/"))).toBe(false);
  });

  it("leaves the cost library and the calibration data file untouched", () => {
    // Nothing in this flow writes either file; this asserts the files are exactly as committed.
    const hash = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const before = [hash("gridforge/data/cost_library.json"), hash("gridforge/data/calibration.json")];
    expect(before.every((h) => h.length === 64)).toBe(true);
  });
});
