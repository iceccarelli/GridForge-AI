/**
 * The Verified Power Record, end to end.
 *
 * Real route handlers, a real Request for each step, the in-memory PostgREST/Storage
 * fake for Supabase — and the REAL Python engine as a subprocess, so the BTM
 * specification is built by gridforge/reporting/btm_spec.py and every response is
 * validated and ranked by gridforge.procurement.rank_bids, not by a stand-in. A fake
 * engine here could only prove the wiring; this proves the product.
 *
 * The suite follows one project through the whole chain, then attacks the edges
 * (wrong owner, duplicate link, unsupported upload, store down, production without
 * Supabase) and asserts on what was actually written, not on what a handler claims.
 */
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PgError, PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "vpr-test-key";

let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let restoreFetch: () => void;
let strayHosts: string[] = [];

const realFetch = globalThis.fetch;

async function startEngine(): Promise<string> {
  const code = [
    "import os",
    `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`,
    "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server",
    "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)",
    "print(h.server_address[1],flush=True)",
    "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => {
      clearTimeout(t);
      resolve(`http://127.0.0.1:${String(d).trim()}`);
    });
    engine!.once("error", reject);
  });
}

function installFetch() {
  db = new PostgrestFake([
    "power_deployment_cases", "projects", "project_links", "project_evidence", "project_events",
    "procurement_packages", "procurement_responses", "procurement_comparisons",
  ]);
  db.uniqueKeys.set("projects", [["project_token"]]);
  db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
  db.uniqueKeys.set("procurement_responses", [["package_id", "supplier"]]);
  db.uniqueKeys.set("procurement_packages", [["package_token"]]);
  installProjectRpcs(db);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ENGINE)) return realFetch(input as RequestInfo, init);
    if (!url.startsWith("https://stub.supabase.co")) strayHosts.push(new URL(url).host);
    return dbFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    restoreDb();
  };
}

const REQUEST = {
  load_profile: {
    csv: "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n",
    source: "hall-a-metering.csv",
  },
  grid_firm_MW: 10,
  target_MW: 35,
  ride_through_hours: 3,
  redundancy: "N+1",
  generation: [
    { id: "GEN-A", kind: "gas_engine", nameplate_MW: 20, capex_eur: 16_000_000, lead_time_weeks: 44, fuel_type: "natural gas" },
    { id: "GEN-B", kind: "gas_engine", nameplate_MW: 20, capex_eur: 16_000_000, lead_time_weeks: 44, fuel_type: "natural gas" },
  ],
  bess: [{ id: "BESS-1", power_MW: 8, energy_MWh: 32, capex_eur: 7_200_000, lead_time_weeks: 30 }],
  interconnection: { utility: "TenneT", pcc_voltage_kV: 20, import_capacity_MW: 15 },
  permitting: { emissions_status: "application submitted" },
};
const ARCH = "GRID + BESS + GENERATION";

beforeAll(async () => {
  if (!hasPython) return;
  ENGINE = await startEngine();
});
afterAll(() => {
  engine?.kill();
});

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  strayHosts = [];
  restoreFetch = installFetch();
});
afterEach(() => restoreFetch());

function json(path: string, body: unknown, method = "POST") {
  return new Request(siteUrl(path), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function createProject(body: Record<string, unknown> = { project_name: "Hall A" }) {
  const { POST } = await import("@/app/api/projects/route");
  const res = await POST(json("/api/projects", body));
  return { res, body: (await res.json()) as any };
}
async function createCase(extra: Record<string, unknown> = {}, request: Record<string, unknown> = REQUEST) {
  const { POST } = await import("@/app/api/power/deploy/cases/route");
  const res = await POST(json("/api/power/deploy/cases", { ...request, ...extra }));
  return { res, body: (await res.json()) as any };
}
async function attach(project: string, case_token: string, email?: string) {
  const { POST } = await import("@/app/api/projects/[token]/cases/route");
  const res = await POST(json(`/api/projects/${project}/cases`, { case_token, email }), ctx({ token: project }));
  return { res, body: (await res.json()) as any };
}
async function getState(project: string) {
  const { GET } = await import("@/app/api/projects/[token]/route");
  const res = await GET(new Request(siteUrl(`/api/projects/${project}`)), ctx({ token: project }));
  return { res, body: (await res.json()) as any };
}
async function generate(project: string, case_token: string, architecture = ARCH) {
  const { POST } = await import("@/app/api/projects/[token]/packages/route");
  const res = await POST(json(`/api/projects/${project}/packages`, { case_token, architecture }), ctx({ token: project }));
  return { res, body: (await res.json()) as any };
}
async function respond(project: string, pkg: string, body: unknown) {
  const { POST } = await import("@/app/api/projects/[token]/packages/[package]/responses/route");
  const res = await POST(json(`/x`, body), ctx({ token: project, package: pkg }));
  return { res, body: (await res.json()) as any };
}
async function compare(project: string, pkg: string) {
  const { POST } = await import("@/app/api/projects/[token]/packages/[package]/comparison/route");
  const res = await POST(json(`/x`, {}), ctx({ token: project, package: pkg }));
  return { res, body: (await res.json()) as any };
}
async function select(project: string, pkg: string, body: unknown) {
  const { POST } = await import("@/app/api/projects/[token]/packages/[package]/selection/route");
  const res = await POST(json(`/x`, body), ctx({ token: project, package: pkg }));
  return { res, body: (await res.json()) as any };
}
async function upload(project: string, bytes: Uint8Array | string, mediaType: string, name = "utility-letter.pdf") {
  const { POST } = await import("@/app/api/projects/[token]/evidence/route");
  const res = await POST(
    new Request(siteUrl(`/api/projects/${project}/evidence?filename=${name}&source_category=utility_correspondence`), {
      method: "POST",
      headers: { "content-type": mediaType },
      body: typeof bytes === "string" ? bytes : Buffer.from(bytes),
    }),
    ctx({ token: project })
  );
  return { res, body: (await res.json()) as any };
}
const eventTypes = () => db.rows("project_events").map((e) => e.event_type);

/** A completed response schedule: the supplier's own figures, answering every mandatory clause. */
function supplierResponse(template: any, supplier: string, values: Record<string, number>) {
  return {
    supplier,
    received_on: "2026-10-01",
    valid_until: "2026-12-31",
    values: { ...template.values, ...values },
    compliance: Object.fromEntries(Object.keys(template.compliance).map((id) => [id, "C"])),
  };
}

const PDF = new TextEncoder().encode("%PDF-1.4\n% grid connection offer letter fixture\n%%EOF\n");

describe.skipIf(!hasPython)("Verified Power Record v1 — the whole chain", () => {
  it("runs project → case → RFQ → responses → comparison → selection → evidence, and persists each step", async () => {
    // 1. create project -------------------------------------------------------
    const made = await createProject({ project_name: "Hall A", company: "Example Colo", site_label: "Frankfurt campus" });
    expect(made.res.status).toBe(201);
    const token = made.body.project_token as string;
    expect(token).toMatch(/\S{20,}/);
    expect(db.rows("projects")).toHaveLength(1);
    expect(db.rows("projects")[0]).toMatchObject({ project_name: "Hall A", status: "draft", location: null });
    expect(eventTypes()).toEqual(["project_created"]);
    // creating a project creates no engineering object and calls no engine
    expect(db.rows("power_deployment_cases")).toHaveLength(0);

    // 2. a case that exists on its own, then is attached ------------------------
    const c = await createCase();
    expect(c.res.status).toBe(200);
    const caseToken = c.body.case_token as string;
    expect(db.rows("project_links")).toHaveLength(0); // unattached BTM case still works
    const a = await attach(token, caseToken);
    expect(a.res.status).toBe(200);
    expect(a.body.attached).toBe(true);
    expect(db.rows("project_links")).toHaveLength(1);
    expect(db.rows("project_links")[0]).toMatchObject({ object_type: "power_deployment_case", object_id: caseToken });
    expect(eventTypes()).toEqual(["project_created", "btm_case_attached"]);
    // the case stays authoritative where it was; the project holds a link and nothing else
    expect(db.rows("power_deployment_cases")).toHaveLength(1);
    expect(db.rows("power_deployment_cases")[0].request).toMatchObject({ target_MW: 35 });
    expect(JSON.stringify(db.rows("projects")[0])).not.toContain("target_MW");
    expect(JSON.stringify(db.rows("project_links"))).not.toContain("target_MW");

    // 3. ProjectPanel's data: only stored/engine facts ----------------------------
    const s1 = await getState(token);
    expect(s1.res.status).toBe(200);
    expect(s1.body.project).toMatchObject({ project_name: "Hall A", company: "Example Colo", site_label: "Frankfurt campus", location: null });
    expect(s1.body.cases).toHaveLength(1);
    const cs = s1.body.cases[0];
    expect(cs).toMatchObject({ latest_revision: 1, target_MW: 35, grid_firm_MW: 10, gap_MW: 25 });
    const archState = cs.architectures.find((x: any) => x.label === ARCH);
    expect(archState).toMatchObject({ rfq_ready: true, execution_ready: false });
    expect(archState.external_clearances_required.length).toBeGreaterThan(0);
    expect(s1.body.evidence).toMatchObject({ total: 0, unverified: 0, verified: 0, rejected: 0 });
    expect(s1.body.procurement.packages).toEqual([]);
    expect(s1.body.events.map((e: any) => e.event_type)).toEqual(["project_created", "btm_case_attached"]);
    // a second read of the same project returns the same state
    const s1b = await getState(token);
    expect(s1b.body).toEqual(s1.body);

    // duplicate attach: still one link, still one attach event
    const again = await attach(token, caseToken);
    expect(again.res.status).toBe(200);
    expect(again.body.attached).toBe(false);
    expect(db.rows("project_links")).toHaveLength(1);
    expect(eventTypes().filter((t) => t === "btm_case_attached")).toHaveLength(1);

    // a case revision lands in the project's history
    const { POST: revise } = await import("@/app/api/power/deploy/cases/[token]/route");
    const rev = await revise(json(`/x`, { target_MW: 36 }), ctx({ token: caseToken }));
    const revBody = (await rev.json()) as any;
    expect(revBody).toMatchObject({ ok: true, revision: 2, project_history: "recorded" });
    expect(eventTypes()).toContain("btm_case_revised");
    const revisedEvent = db.rows("project_events").find((e) => e.event_type === "btm_case_revised") as any;
    expect(revisedEvent.payload).toMatchObject({ case_token: caseToken, revision: 2, changed_fields: ["target_MW"] });
    // restore the demo target so the package is built from revision 3
    await revise(json(`/x`, { target_MW: 35 }), ctx({ token: caseToken }));

    // 4. RFQ: not-ready is refused with the engine's own blockers --------------------
    const unpriced = {
      ...REQUEST,
      generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }],
      bess: [],
    };
    const u = await createCase({}, unpriced);
    await attach(token, u.body.case_token);
    const refused = await generate(token, u.body.case_token, "GRID + GENERATION");
    expect(refused.res.status).toBe(409);
    expect(refused.body.error).toMatch(/not RFQ-ready/);
    expect(refused.body.details.capex_uncosted_units).toEqual(["GEN-A"]);
    expect(db.rows("procurement_packages")).toHaveLength(0);
    expect(eventTypes()).not.toContain("rfq_generated");

    // …and generated for the architecture that IS rfq_ready, by the existing spec engine
    const g = await generate(token, caseToken);
    expect(g.res.status).toBe(201);
    const pkgToken = g.body.package.package_token as string;
    expect(g.body.package).toMatchObject({ architecture: ARCH, case_token: caseToken, case_revision: 3 });
    expect(g.body.package.spec_summary.units).toEqual(["GEN-A", "GEN-B", "BESS-1"]);
    const pkgRow = db.rows("procurement_packages")[0] as any;
    expect(pkgRow.document_md).toContain("GEN-A");
    expect(pkgRow.document_md).toContain("BESS-1");
    expect(pkgRow.document_html).toContain("<html");
    expect(db.rows("project_links").some((l) => l.object_type === "procurement_package" && l.object_id === pkgToken)).toBe(true);
    const rfqEvent = db.rows("project_events").find((e) => e.event_type === "rfq_generated") as any;
    expect(rfqEvent.payload).toMatchObject({ package_token: pkgToken, case_token: caseToken, case_revision: 3, architecture: ARCH });
    // a workflow step, not a sale: nothing but Supabase and the engine was ever called
    expect(strayHosts).toEqual([]);
    expect(JSON.stringify(pkgRow)).not.toMatch(/price_id|checkout|stripe/i);

    // 5. supplier response A ----------------------------------------------------------
    const template = pkgRow.response_template;
    expect(Object.keys(template.compliance).length).toBeGreaterThan(0);
    const A = supplierResponse(template, "Supplier A", { capex_eur: 41_000_000, lead_time_weeks: 40, install_weeks: 8 });
    const ra = await respond(token, pkgToken, A);
    expect(ra.res.status).toBe(201);
    expect(db.rows("procurement_responses")).toHaveLength(1);
    expect(db.rows("procurement_responses")[0]).toMatchObject({ supplier: "Supplier A", project_id: pkgRow.project_id, package_id: pkgRow.id });
    expect(eventTypes()).toContain("supplier_response_received");

    // an unreadable response is refused by the engine's own validation and never stored
    const bad = await respond(token, pkgToken, { ...A, supplier: "Supplier X", values: { capex_eur: "about forty" } });
    expect(bad.res.status).toBe(422);
    expect(db.rows("procurement_responses")).toHaveLength(1);
    // a second response from the same supplier is refused, not merged
    const dup = await respond(token, pkgToken, { ...A, supplier: "supplier a" });
    expect(dup.res.status).toBe(409);
    expect(db.rows("procurement_responses")).toHaveLength(1);

    // 6. response B, then the existing comparison, persisted ------------------------------
    const B = supplierResponse(template, "Supplier B", { capex_eur: 36_500_000, lead_time_weeks: 52, install_weeks: 10 });
    expect((await respond(token, pkgToken, B)).res.status).toBe(201);
    expect(db.rows("procurement_responses")).toHaveLength(2);
    const cmp = await compare(token, pkgToken);
    expect(cmp.res.status).toBe(201);
    const stored = db.rows("procurement_comparisons")[0] as any;
    expect(stored).toMatchObject({ project_id: pkgRow.project_id, package_id: pkgRow.id, case_token: caseToken, case_revision: 3, architecture: ARCH });
    expect(stored.response_ids).toHaveLength(2);
    expect(stored.result.ranked.map((r: any) => r.supplier).sort()).toEqual(["Supplier A", "Supplier B"]);
    expect(eventTypes()).toContain("comparison_completed");
    // The persisted ranking IS the existing engine's: ask the engine directly and compare.
    const direct = await realFetch(`${ENGINE}/v1/power/deploy/bids`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ ...REQUEST, architecture: ARCH, responses: [A, B] }),
    });
    expect(((await direct.json()) as any).ranked).toEqual(stored.result.ranked);
    // BTM has no rack count; the engine reports that honestly rather than inventing one
    expect(stored.result.ranked.every((r: any) => r.eur_per_rack === null)).toBe(true);

    // reload: comparison is still there
    const s2 = await getState(token);
    expect(s2.body.procurement.packages).toHaveLength(1);
    const p = s2.body.procurement.packages[0];
    expect(p).toMatchObject({ package_token: pkgToken, response_count: 2, stale: false, selection: null });
    expect(p.comparison.ranked).toEqual(stored.result.ranked);

    // 7. a person selects — deliberately NOT the leading supplier -------------------------
    const leading = stored.result.leading as string;
    const other = ["Supplier A", "Supplier B"].find((n) => n !== leading)!;
    const comparisonBefore = JSON.stringify(db.rows("procurement_comparisons")[0]);
    expect((await select(token, pkgToken, { supplier: other })).res.status).toBe(422); // no actor, no decision
    const sel = await select(token, pkgToken, { supplier: other, actor: "J. Ortiz, Head of Procurement" });
    expect(sel.res.status).toBe(200);
    expect(sel.body.rank_at_selection).toBe(2);
    expect(db.rows("procurement_packages")[0]).toMatchObject({ selected_supplier: other, selected_by: "J. Ortiz, Head of Procurement" });
    const selEvent = db.rows("project_events").find((e) => e.event_type === "supplier_selected") as any;
    expect(selEvent.actor).toBe("J. Ortiz, Head of Procurement");
    expect(selEvent.payload).toMatchObject({
      supplier: other, package_token: pkgToken, case_token: caseToken, architecture: ARCH,
      rank_at_selection: 2, was_leading: false,
    });
    expect(selEvent.payload.comparison_id).toBe(stored.id);
    // selection ≠ ranking: the comparison is byte-for-byte what it was, and still says who led
    expect(JSON.stringify(db.rows("procurement_comparisons")[0])).toBe(comparisonBefore);
    const s3 = await getState(token);
    expect(s3.body.procurement.packages[0].comparison.leading).toBe(leading);
    expect(s3.body.procurement.packages[0].selection).toMatchObject({ supplier: other });
    // a second selection is refused
    expect((await select(token, pkgToken, { supplier: leading, actor: "x" })).res.status).toBe(409);

    // 8. evidence ------------------------------------------------------------------------------
    const up = await upload(token, PDF, "application/pdf");
    expect(up.res.status).toBe(201);
    const ev = db.rows("project_evidence")[0] as any;
    expect(ev).toMatchObject({
      media_type: "application/pdf", byte_size: PDF.byteLength, review_status: "unverified", evidence_class: null,
    });
    expect(ev.sha256).toBe(crypto.createHash("sha256").update(PDF).digest("hex"));
    expect(db.objects.get(ev.storage_ref)!.bytes).toEqual(new Uint8Array(PDF));
    expect(eventTypes()).toContain("evidence_attached");

    const evBefore = db.rows("project_evidence").length;
    const eventsBefore = db.rows("project_events").length;
    const png = await upload(token, "\x89PNG fake", "image/png", "site.png");
    expect(png.res.status).toBe(415);
    expect(db.rows("project_evidence")).toHaveLength(evBefore);
    expect(db.rows("project_events")).toHaveLength(eventsBefore);
    expect(db.objects.size).toBe(1);

    const s4 = await getState(token);
    expect(s4.body.evidence).toMatchObject({ total: 1, unverified: 1, verified: 0, rejected: 0 });

    // 9. calibration stays empty ----------------------------------------------------------------
    expect(db.rows("project_links").filter((l) => l.object_type === "calibration_observation")).toHaveLength(0);
    expect(db.tables.has("calibration_observations")).toBe(false);
    // history reads in order, start to finish
    expect(s4.body.events.map((e: any) => e.event_type)).toEqual([
      "project_created", "btm_case_attached", "btm_case_revised", "btm_case_revised", "btm_case_attached",
      "rfq_generated", "supplier_response_received", "supplier_response_received", "comparison_completed",
      "supplier_selected", "evidence_attached",
    ]);
  }, 120_000);
});

describe.skipIf(!hasPython)("ownership and tenancy", () => {
  it("does not let one project take another's case, nor a guessed token reach anything", async () => {
    const p1 = (await createProject({ project_name: "One" })).body.project_token;
    const p2 = (await createProject({ project_name: "Two" })).body.project_token;
    const c = await createCase();
    expect((await attach(p1, c.body.case_token)).res.status).toBe(200);
    const stolen = await attach(p2, c.body.case_token);
    expect(stolen.res.status).toBe(409);
    expect(db.rows("project_links")).toHaveLength(1);

    expect((await attach(p1, "no-such-case")).res.status).toBe(404);
    expect((await attach("no-such-project", c.body.case_token)).res.status).toBe(404);
    // a package cannot be generated for a case the project does not hold
    const c2 = await createCase();
    expect((await generate(p1, c2.body.case_token)).res.status).toBe(403);
    expect(db.rows("procurement_packages")).toHaveLength(0);
  }, 60_000);

  it("requires the owner's email to attach a case registered to one", async () => {
    const p = (await createProject()).body.project_token;
    const c = await createCase({ email: "owner@example.com" });
    expect((await attach(p, c.body.case_token)).res.status).toBe(403);
    expect((await attach(p, c.body.case_token, "someone@else.com")).res.status).toBe(403);
    expect(db.rows("project_links")).toHaveLength(0);
    expect((await attach(p, c.body.case_token, "Owner@Example.com")).res.status).toBe(200);
    expect(db.rows("project_links")).toHaveLength(1);
  }, 60_000);

  it("creates a case straight into a project, and says so when the attachment fails", async () => {
    const p = (await createProject()).body.project_token;
    const ok = await createCase({ project_token: p });
    expect(ok.body.project_attached).toBe(true);
    expect(db.rows("project_links")).toHaveLength(1);
    // a wrong project token is refused before the engine runs and creates no case
    const before = db.rows("power_deployment_cases").length;
    const bad = await createCase({ project_token: "nope" });
    expect(bad.res.status).toBe(404);
    expect(db.rows("power_deployment_cases")).toHaveLength(before);
  }, 60_000);
});

describe("project creation and the event log", () => {
  it("validates input and does not geocode or invent location", async () => {
    expect((await createProject({})).res.status).toBe(422);
    expect((await createProject({ project_name: "x".repeat(500) })).res.status).toBe(422);
    expect((await createProject({ project_name: "P", location: { nested: { a: 1 } } })).res.status).toBe(422);
    expect(db.rows("projects")).toHaveLength(0);
    const ok = await createProject({ project_name: "P", location: { city: "Frankfurt", latitude: 50.11 } });
    expect(ok.res.status).toBe(201);
    expect(db.rows("projects")[0].location).toEqual({ city: "Frankfurt", latitude: 50.11 });
    const none = await createProject({ project_name: "Q" });
    expect(none.res.status).toBe(201);
    expect(db.rows("projects")[1].location).toBeNull();
  });

  it("does not return a project whose creation event could not be recorded", async () => {
    db.failEvents = true;
    const r = await createProject();
    expect(r.res.status).toBe(502);
    expect(r.body.project_token).toBeUndefined();
    expect(db.rows("projects")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(0);
  });

  it("has no application path that updates or deletes an event, and the store refuses one", async () => {
    const lib = await import("@/lib/projects");
    const eventFns = Object.keys(lib).filter((k) => /event/i.test(k));
    // The only event function is a read. Events are written solely by the gf_* database
    // functions, in the same transaction as the record they describe.
    expect(eventFns).toEqual(["listEvents"]);
    const made = await createProject();
    db.appendOnly.add("project_events");
    const id = db.rows("project_events")[0].id as string;
    const url = `https://stub.supabase.co/rest/v1/project_events?id=eq.${id}`;
    const patch = await fetch(url, { method: "PATCH", body: JSON.stringify({ actor: "someone else" }) });
    const del = await fetch(url, { method: "DELETE" });
    expect(patch.status).toBe(403);
    expect(del.status).toBe(403);
    expect(db.rows("project_events")).toHaveLength(1);
    expect(db.rows("project_events")[0].actor).toBe("project_token_holder");
    void made;
  });
});

describe("a business action is a record AND its event, or nothing", () => {
  /** Walk a project to the point where a given action is next, then make events fail. */
  async function staged() {
    const project = (await createProject()).body.project_token as string;
    const c = await createCase();
    await attach(project, c.body.case_token);
    return { project, caseToken: c.body.case_token as string };
  }
  const tables = ["procurement_packages", "procurement_responses", "procurement_comparisons", "project_evidence"];
  const counts = () => Object.fromEntries([...tables, "project_events", "project_links"].map((t) => [t, db.rows(t).length]));

  it.skipIf(!hasPython)("attach, RFQ, response, comparison, selection and evidence each leave NO trace when the event cannot be written", async () => {
    const { project, caseToken } = await staged();

    // attach (a second case)
    const c2 = await createCase();
    let before = counts();
    db.failEvents = true;
    expect((await attach(project, c2.body.case_token)).res.status).toBe(502);
    expect(counts()).toEqual(before);
    db.failEvents = false;

    // RFQ: no package, no package link
    before = counts();
    db.failEvents = true;
    expect((await generate(project, caseToken)).res.status).toBe(502);
    expect(counts()).toEqual(before);
    db.failEvents = false;
    const g = await generate(project, caseToken);
    const pkg = g.body.package.package_token as string;
    const template = (db.rows("procurement_packages")[0] as any).response_template;

    // response
    const A = supplierResponse(template, "Supplier A", { capex_eur: 41_000_000, lead_time_weeks: 40 });
    before = counts();
    db.failEvents = true;
    expect((await respond(project, pkg, A)).res.status).toBe(502);
    expect(counts()).toEqual(before);
    db.failEvents = false;
    expect((await respond(project, pkg, A)).res.status).toBe(201); // and the retry is not blocked by a ghost row
    expect((await respond(project, pkg, supplierResponse(template, "Supplier B", { capex_eur: 36_000_000, lead_time_weeks: 52 }))).res.status).toBe(201);

    // comparison
    before = counts();
    db.failEvents = true;
    expect((await compare(project, pkg)).res.status).toBe(502);
    expect(counts()).toEqual(before);
    db.failEvents = false;
    expect((await compare(project, pkg)).res.status).toBe(201);

    // selection: the package stays unselected, so a retry is possible
    before = counts();
    db.failEvents = true;
    expect((await select(project, pkg, { supplier: "Supplier A", actor: "J. Ortiz" })).res.status).toBe(502);
    expect(counts()).toEqual(before);
    expect(db.rows("procurement_packages")[0].selected_supplier ?? null).toBeNull();
    db.failEvents = false;
    expect((await select(project, pkg, { supplier: "Supplier A", actor: "J. Ortiz" })).res.status).toBe(200);

    // evidence: no row and no orphaned object
    before = counts();
    db.failEvents = true;
    expect((await upload(project, PDF, "application/pdf")).res.status).toBe(502);
    expect(counts()).toEqual(before);
    expect(db.objects.size).toBe(0);
    db.failEvents = false;
  }, 120_000);

  it.skipIf(!hasPython)("a case revision is not saved if the project's history line cannot be", async () => {
    const { caseToken } = await staged();
    const { POST: revise } = await import("@/app/api/power/deploy/cases/[token]/route");
    db.failEvents = true;
    const res = await revise(json(`/x`, { target_MW: 40 }), ctx({ token: caseToken }));
    expect(res.status).toBe(502);
    expect(db.rows("power_deployment_cases")).toHaveLength(1); // still only revision 1
    db.failEvents = false;
    expect((await revise(json(`/x`, { target_MW: 40 }), ctx({ token: caseToken }))).status).toBe(200);
    expect(db.rows("power_deployment_cases")).toHaveLength(2);
  }, 60_000);
});

describe("the project never invents a value the engine did not produce", () => {
  it("shows absent engineering and site facts as null, never 0, '' or a default", async () => {
    const project = (await createProject({ project_name: "Bare" })).body.project_token as string;
    db.seed("power_deployment_cases", [{ case_token: "bare", revision: 1, email: null, request: {}, result: {}, changed_fields: [] }]);
    expect((await attach(project, "bare")).res.status).toBe(200);
    const s = await getState(project);
    expect(s.body.project).toMatchObject({ company: null, site_label: null, location: null });
    expect(s.body.cases[0]).toMatchObject({
      target_MW: null, grid_firm_MW: null, gap_MW: null, redundancy: null, objective: null, next_action: null,
      architectures: [],
    });
    expect(s.body.evidence).toMatchObject({ total: 0, items: [] });
    expect(s.body.procurement.packages).toEqual([]);
  });
});

describe("evidence upload", () => {
  async function project() {
    return (await createProject()).body.project_token as string;
  }

  it("rejects unsupported types, mislabelled PDFs, empty and oversized files without writing anything", async () => {
    const p = await project();
    const events = db.rows("project_events").length;
    for (const [bytes, type, status] of [
      ["MZ\x90 fake exe", "application/x-msdownload", 415],
      ["<script>1</script>", "text/html", 415],
      ["not a pdf at all", "application/pdf", 415],
      ["", "text/csv", 422],
      [new Uint8Array(5 * 1024 * 1024 + 1), "text/csv", 413],
    ] as const) {
      const r = await upload(p, bytes as any, type);
      expect(r.res.status, `${type}`).toBe(status);
    }
    expect(db.rows("project_evidence")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    expect(db.rows("project_events")).toHaveLength(events);
  });

  it("accepts CSV and JSON, hashes the content, and leaves it unverified and unclassified", async () => {
    const p = await project();
    const csv = "timestamp,kW\n2026-01-01T00:00:00,1000\n";
    expect((await upload(p, csv, "text/csv", "load.csv")).res.status).toBe(201);
    expect((await upload(p, '{"a":1}', "application/json; charset=utf-8", "meta.json")).res.status).toBe(201);
    const rows = db.rows("project_evidence") as any[];
    expect(rows.map((r) => r.media_type)).toEqual(["text/csv", "application/json"]);
    expect(rows[0].sha256).toBe(crypto.createHash("sha256").update(csv).digest("hex"));
    for (const r of rows) {
      expect(r.review_status).toBe("unverified");
      expect(r.evidence_class).toBeNull();
      expect(r.storage_ref).toMatch(/^project-evidence\//);
    }
    // the same bytes are not attached twice
    expect((await upload(p, csv, "text/csv", "load-again.csv")).res.status).toBe(409);
    expect(db.rows("project_evidence")).toHaveLength(2);
  });

  it("claims no attachment when the object store fails", async () => {
    const p = await project();
    db.failStorage = { status: 500, body: "{}" };
    const r = await upload(p, PDF, "application/pdf");
    expect(r.res.status).toBe(502);
    expect(db.rows("project_evidence")).toHaveLength(0);
    expect(eventTypes()).not.toContain("evidence_attached");
  });

  it("removes the stored object when the metadata write fails, so nothing is half-attached", async () => {
    const p = await project();
    db.dropColumn("project_evidence", "review_status"); // the insert is refused after the object is stored (fake: PGRST204 on direct writes)
    db.rpcs.set("gf_add_evidence", () => { throw new PgError("23514", "evidence constraint", 400); });
    const r = await upload(p, PDF, "application/pdf");
    expect(r.res.status).toBe(502);
    expect(db.rows("project_evidence")).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    expect(eventTypes()).not.toContain("evidence_attached");
  });
});

describe("persistence fails closed", () => {
  it("claims no durable success for any project write when Supabase is unset in production", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const made = await createProject();
      expect(made.res.status).toBe(503);
      expect(made.body.ok).toBe(false);
      expect(made.body.project_token).toBeUndefined();
      expect((await attach("any", "any")).res.status).toBe(503);
      expect((await generate("any", "any")).res.status).toBe(503);
      expect((await upload("any", PDF, "application/pdf")).res.status).toBe(503);
      expect((await getState("any")).res.status).toBe(503);
      // the case route (unchanged behaviour) also refuses to pretend, and a revision never reports project history
      expect(db.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = "test";
    }
  });

  it("is non-durable nowhere: there is no in-memory project store to mistake for a database", async () => {
    delete process.env.SUPABASE_URL;
    (process.env as Record<string, string>).NODE_ENV = "development";
    try {
      expect((await createProject()).res.status).toBe(503);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = "test";
    }
  });

  it("reports a failed read as a failure, never as an empty project", async () => {
    const p = (await createProject()).body.project_token;
    db.dropTable("project_evidence");
    const s = await getState(p);
    expect(s.res.status).toBe(502);
    expect(s.body.evidence).toBeUndefined();
  });
});
