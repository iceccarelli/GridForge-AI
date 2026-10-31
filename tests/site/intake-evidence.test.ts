/**
 * A buyer attaches their own documents to a purchased engagement and confirms figures from them; those figures reach the engine WITH
 * their provenance. The real route handlers run against the PostgREST fake; the engine and the object store are stubbed.
 *
 * What each test guards is a way the record could lie: a figure used without being confirmed, one confirmed from a file that is not
 * this engagement's, a typed number silently overridden, a withdrawn figure still used, the intake broken where the migration has not
 * been applied, a stranger's token reaching someone else's documents.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { applyConfirmedValues, effectiveConfirmed, provenanceFor, type ConfirmedValue, type IntakeFileRow, type ValueEventRow } from "@/lib/intake-evidence";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://engine.test";
const TOKEN = "engagement-token";
const PDF = (extra = "") => new TextEncoder().encode(`%PDF-1.4\n${extra}\n%%EOF`);

let db: PostgrestFake;
let restorePg: () => void;
let engineBodies: Record<string, any>[] = [];
let stored: string[] = [];
let storeFails = false;
let recordFails = false;
let seq = 0;

const ctx = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const evidenceRoute = () => import("@/app/api/intake/[token]/evidence/route");
const confirmRoute = () => import("@/app/api/intake/[token]/confirm/route");
const intakeRoute = () => import("@/app/api/intake/[token]/route");

function upload(bytes: Uint8Array, name = "dso_agreement.pdf", type = "application/pdf", token = TOKEN) {
  return new Request(siteUrl(`/api/intake/${token}/evidence?filename=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": type }, body: bytes as BodyInit });
}
function confirm(body: unknown, token = TOKEN) {
  return new Request(siteUrl(`/api/intake/${token}/confirm`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function submit(body: Record<string, unknown>, token = TOKEN) {
  return new Request(siteUrl(`/api/intake/${token}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Everything a Density Screen needs EXCEPT the three figures a buyer can evidence. */
const BASE_INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9,
  buswayAmpacityA: 400, tapoffMaxA: 63, positionsAvailable: 180, plantSupplyC: 6, platform: "gb300_nvl72",
};

function installStubs() {
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/storage/v1/object/")) {
      if ((init?.method ?? "GET") === "DELETE") { stored = stored.filter((s) => !url.endsWith(s)); return new Response("{}", { status: 200 }); }
      if (storeFails) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
      stored.push(url.split("/storage/v1/object/")[1]);
      return new Response("{}", { status: 200 });
    }
    if (recordFails && url.includes("/rest/v1/intake_evidence_files") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    }
    if (url.startsWith(ENGINE)) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      engineBodies.push(body);
      if (body.format === "html" || body.format === "md") {
        return new Response(JSON.stringify({ format: body.format, title: "Density Screen — North Hall, hall H1", document: "<p>doc</p>" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ project: {}, recommended: "full_dlc", scenarios: [{ id: "full_dlc", as_found: { racks: 0, binding_name: "Plant" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return pgFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = pgFetch; };
}

let restoreStubs: () => void;

function seedEngagement(over: Record<string, unknown> = {}, token = TOKEN, id = "d-1") {
  db.seed("deliverables", [{ id, token, kind: "density_screen", status: "awaiting_intake", company: "North Hall", email: "buyer@hall.example", stripe_session_id: `cs_${id}`, ...over }]);
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  engineBodies = []; stored = []; storeFails = false; recordFails = false; seq = 0;
  db = new PostgrestFake(["deliverables", "intake_evidence_files", "intake_value_events"]);
  db.rowDefaults.set("intake_value_events", () => ({ seq: ++seq, occurred_at: new Date().toISOString() }));
  db.rowDefaults.set("intake_evidence_files", () => ({ uploaded_at: new Date().toISOString() }));
  restorePg = db.install();
  restoreStubs = installStubs();
});
afterEach(() => { restoreStubs(); restorePg(); });

async function attach(name = "dso_agreement.pdf", extra = name) {
  const { POST } = await evidenceRoute();
  const res = await POST(upload(PDF(extra), name), ctx());
  expect(res.status).toBe(201);
  return (await res.json()).file as { id: string; sha256: string; filename: string };
}
async function confirmFrom(fileId: string, over: Record<string, unknown> = {}) {
  const { POST } = await confirmRoute();
  return POST(confirm({ field: "firmCapacityMVA", value: 31, fileId, locator: "clause 4.2", ...over }), ctx());
}

describe("attaching a document", () => {
  it("stores the bytes under the engagement's own prefix and lists the file without its storage path", async () => {
    seedEngagement();
    const f = await attach();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^project-evidence\/intake\/d-1\/[0-9a-f]{64}-dso_agreement\.pdf$/);
    const { GET } = await evidenceRoute();
    const body = await (await GET(new Request(siteUrl(`/api/intake/${TOKEN}/evidence`)), ctx())).json();
    expect(body.files.map((x: any) => x.id)).toEqual([f.id]);
    expect(JSON.stringify(body)).not.toContain("storage_ref");
    expect(body.confirmed).toEqual([]);
  });

  it("an unknown token is a 404 on every route, whatever else is wrong with the request", async () => {
    const { POST: up, GET } = await evidenceRoute();
    expect((await up(upload(PDF(), "a.pdf", "application/pdf", "nope"), ctx("nope"))).status).toBe(404);
    expect((await GET(new Request(siteUrl("/api/intake/nope/evidence")), ctx("nope"))).status).toBe(404);
    expect((await (await confirmRoute()).POST(confirm({ field: "firmCapacityMVA" }, "nope"), ctx("nope"))).status).toBe(404);
  });

  it("refuses a file that is not what it says, an empty file, a wrong type, a duplicate, and too many", async () => {
    seedEngagement();
    const { POST } = await evidenceRoute();
    expect((await POST(upload(new TextEncoder().encode("not a pdf"), "x.pdf"), ctx())).status).toBe(415);
    expect((await POST(upload(new Uint8Array(0), "x.pdf"), ctx())).status).toBe(422);
    expect((await POST(upload(PDF(), "x.exe", "application/octet-stream"), ctx())).status).toBeGreaterThanOrEqual(400);
    await attach("a.pdf");
    expect((await POST(upload(PDF("a.pdf"), "again.pdf"), ctx())).status).toBe(409);
    for (let i = 1; i < 10; i++) await attach(`f${i}.pdf`, `unique-${i}`);
    expect((await POST(upload(PDF("one-too-many"), "z.pdf"), ctx())).status).toBe(409);
    expect(db.rows("intake_evidence_files")).toHaveLength(10);
  });

  it("a failed object store attaches nothing; a failed record removes the object it just wrote", async () => {
    seedEngagement();
    const { POST } = await evidenceRoute();
    storeFails = true;
    expect((await POST(upload(PDF("a"), "a.pdf"), ctx())).status).toBe(502);
    expect(db.rows("intake_evidence_files")).toHaveLength(0);
    storeFails = false;
    recordFails = true;
    expect((await POST(upload(PDF("b"), "b.pdf"), ctx())).status).toBe(502);
    recordFails = false;
    expect(stored).toEqual([]);                     // the orphaned object was deleted
    expect(db.rows("intake_evidence_files")).toHaveLength(0);
  });

  it("after the intake is submitted the documents can no longer change", async () => {
    seedEngagement({ status: "draft" });
    const { POST } = await evidenceRoute();
    expect((await POST(upload(PDF(), "late.pdf"), ctx())).status).toBe(409);
    expect(stored).toEqual([]);
  });
});

describe("confirming a figure from a document", () => {
  it("records value, the unit fixed by the field, the file, the place in it, and the attester from the engagement", async () => {
    seedEngagement();
    const f = await attach();
    const res = await confirmFrom(f.id, { unit: "MW", confirmed_by: "attacker@evil.example" });   // neither can be set by the request
    expect(res.status).toBe(200);
    const row = db.rows("intake_value_events")[0] as Record<string, any>;
    expect(row).toMatchObject({ deliverable_id: "d-1", action: "confirm", field: "firmCapacityMVA", value: 31, unit: "MVA", file_id: f.id, locator: "clause 4.2", confirmed_by: "buyer@hall.example" });
    expect((await res.json()).confirmed[0]).toMatchObject({ field: "firmCapacityMVA", value: 31, unit: "MVA", locator: "clause 4.2" });
  });

  it.each([
    ["a numeric string", { value: "31" }],
    ["zero", { value: 0 }],
    ["negative", { value: -5 }],
    ["beyond the model's range", { value: 1e9 }],
    ["null", { value: null }],
    ["an unknown field", { field: "contractedMW" }],
    ["no locator", { locator: "" }],
    ["markup in the locator", { locator: "<img src=x onerror=1>" }],
    ["an over-long locator", { locator: "x".repeat(201) }],
    ["a non-string file id", { fileId: 7 }],
  ])("refuses %s", async (_n, over) => {
    seedEngagement();
    const f = await attach();
    const res = await confirmFrom(f.id, { fileId: f.id, ...over });
    expect(res.status).toBe(422);
    expect(db.rows("intake_value_events")).toHaveLength(0);
  });

  it("will not confirm from a file that belongs to another engagement", async () => {
    seedEngagement();
    seedEngagement({}, "other-token", "d-2");
    const theirs = await (async () => { const { POST } = await evidenceRoute(); return (await (await POST(upload(PDF("theirs"), "theirs.pdf", "application/pdf", "other-token"), ctx("other-token"))).json()).file; })();
    const res = await confirmFrom(theirs.id);
    expect(res.status).toBe(404);
    expect(db.rows("intake_value_events")).toHaveLength(0);
  });

  it("a withdrawal stops the figure being used, keeps the confirmation in the history, and needs something to withdraw", async () => {
    seedEngagement();
    const f = await attach();
    const { POST } = await confirmRoute();
    expect((await POST(confirm({ field: "firmCapacityMVA", withdraw: true }), ctx())).status).toBe(404);
    await confirmFrom(f.id);
    const res = await POST(confirm({ field: "firmCapacityMVA", withdraw: true }), ctx());
    expect((await res.json()).confirmed).toEqual([]);
    expect(db.rows("intake_value_events").map((r: any) => r.action)).toEqual(["confirm", "withdraw"]);
  });

  it("a later confirmation replaces the earlier one; the history keeps both", async () => {
    seedEngagement();
    const f = await attach();
    await confirmFrom(f.id, { value: 31 });
    const res = await confirmFrom(f.id, { value: 33, locator: "schedule 2" });
    expect((await res.json()).confirmed).toEqual([expect.objectContaining({ value: 33, locator: "schedule 2" })]);
    expect(db.rows("intake_value_events")).toHaveLength(2);
  });
});

describe("the intake uses the confirmed figures, with their provenance", () => {
  it("sends the engine {value, source, note, evidence: E5} for a confirmed figure, and stops calling it an assumption", async () => {
    seedEngagement();
    const f = await attach();
    await confirmFrom(f.id);
    const { POST } = await intakeRoute();
    const res = await POST(submit(BASE_INTAKE), ctx());
    expect(res.status).toBe(200);
    const sent = engineBodies.find((b) => b.intake)!.intake;
    expect(sent.grid.firm_capacity_MVA).toEqual({
      value: 31,
      source: `dso_agreement.pdf (sha256 ${f.sha256.slice(0, 12)}…), clause 4.2`,
      note: expect.stringContaining("GridForge has not independently verified"),
      evidence: "E5",
    });
    const assumed = (await res.json()).assumed.map((a: any) => a.field);
    expect(assumed).not.toContain("firmCapacityMVA");
    expect(assumed).toEqual(expect.arrayContaining(["floorLoadingKPa", "plantCapacityKW"]));      // the other two were not confirmed
    expect(db.rows("deliverables")[0].status).toBe("draft");
  });

  it("a withdrawn figure is not used: the engine gets none and the intake says it is assumed", async () => {
    seedEngagement();
    const f = await attach();
    await confirmFrom(f.id);
    await (await confirmRoute()).POST(confirm({ field: "firmCapacityMVA", withdraw: true }), ctx());
    const res = await (await intakeRoute()).POST(submit(BASE_INTAKE), ctx());
    expect(engineBodies.find((b) => b.intake)!.intake.grid.firm_capacity_MVA).toBeUndefined();
    expect((await res.json()).assumed.map((a: any) => a.field)).toContain("firmCapacityMVA");
  });

  it("the same number typed in the form is fine and carries the provenance", async () => {
    seedEngagement();
    const f = await attach();
    await confirmFrom(f.id);
    const res = await (await intakeRoute()).POST(submit({ ...BASE_INTAKE, firmCapacityMVA: 31 }), ctx());
    expect(res.status).toBe(200);
    expect(engineBodies.find((b) => b.intake)!.intake.grid.firm_capacity_MVA).toMatchObject({ value: 31, evidence: "E5" });
  });

  it("a DIFFERENT typed number is a contradiction: refused with both figures, nothing submitted, the one submission not consumed", async () => {
    seedEngagement();
    const f = await attach();
    await confirmFrom(f.id);
    const { POST } = await intakeRoute();
    const res = await POST(submit({ ...BASE_INTAKE, firmCapacityMVA: 15 }), ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.conflicts).toEqual([{ field: "firmCapacityMVA", typed: 15, confirmed: 31 }]);
    expect(engineBodies).toHaveLength(0);
    expect(db.rows("deliverables")[0].status).toBe("awaiting_intake");
    expect((await POST(submit(BASE_INTAKE), ctx())).status).toBe(200);                      // fixing it works
  });

  it("an intake with no documents is exactly what it was", async () => {
    seedEngagement();
    const res = await (await intakeRoute()).POST(submit({ ...BASE_INTAKE, firmCapacityMVA: 15, floorLoadingKPa: 12, plantCapacityKW: 6000 }), ctx());
    expect(res.status).toBe(200);
    const sent = engineBodies.find((b) => b.intake)!.intake;
    expect(sent.grid.firm_capacity_MVA).toBe(15);
    expect(sent.hall.floor_loading_kPa).toBe(12);
  });
});

describe("where migration 0044 has not been applied", () => {
  beforeEach(() => { db.dropTable("intake_evidence_files"); db.dropTable("intake_value_events"); });

  it("the evidence routes say it is not available (503), plainly", async () => {
    seedEngagement();
    expect((await (await evidenceRoute()).POST(upload(PDF(), "a.pdf"), ctx())).status).toBe(503);
    expect((await (await evidenceRoute()).GET(new Request(siteUrl(`/api/intake/${TOKEN}/evidence`)), ctx())).status).toBe(503);
    expect((await confirmFrom("00000000-0000-0000-0000-000000000000")).status).toBe(503);
  });

  it("and the intake itself still works, as it did before this feature existed", async () => {
    seedEngagement();
    const res = await (await intakeRoute()).POST(submit({ ...BASE_INTAKE, firmCapacityMVA: 15, floorLoadingKPa: 12, plantCapacityKW: 6000 }), ctx());
    expect(res.status).toBe(200);
    expect(db.rows("deliverables")[0].status).toBe("draft");
  });
});

describe("the pure parts", () => {
  const file = (id: string): IntakeFileRow => ({ id, deliverable_id: "d", filename: `${id}.pdf`, media_type: "application/pdf", sha256: "a".repeat(64), byte_size: 1, storage_ref: "x", uploaded_at: "2026-10-31T00:00:00Z" });
  const ev = (seq: number, action: "confirm" | "withdraw", field: any, value: number | null = 1, file_id: string | null = "f1"): ValueEventRow => ({
    id: String(seq), seq, deliverable_id: "d", action, field, value: action === "confirm" ? value : null, unit: null, file_id: action === "confirm" ? file_id : null, locator: action === "confirm" ? "p1" : null, confirmed_by: null, occurred_at: "2026-10-31T10:00:00Z",
  });

  it("the newest event per field wins, whatever order they arrive in", () => {
    const out = effectiveConfirmed([ev(3, "confirm", "firmCapacityMVA", 33), ev(1, "confirm", "firmCapacityMVA", 31), ev(2, "withdraw", "floorLoadingKPa")], [file("f1")]);
    expect(out.map((c) => [c.field, c.value])).toEqual([["firmCapacityMVA", 33]]);
    expect(effectiveConfirmed([ev(1, "confirm", "firmCapacityMVA", 31), ev(2, "withdraw", "firmCapacityMVA")], [file("f1")])).toEqual([]);
  });

  it("never confirms a value whose file it cannot name", () => {
    expect(effectiveConfirmed([ev(1, "confirm", "firmCapacityMVA", 31, "gone")], [file("f1")])).toEqual([]);
  });

  it("merging does not mutate the document it was given, and creates a missing parent", () => {
    const c: ConfirmedValue[] = [{ field: "plantCapacityKW", value: 4200, unit: "kW", file: { id: "f1", filename: "m.pdf", sha256: "b".repeat(64) }, locator: "sheet 3", confirmedAt: "2026-10-31T10:00:00Z" }];
    const doc = { thermal: { plant: { design_supply_C: 6 } } };
    const r = applyConfirmedValues(doc, {}, c);
    expect(r.ok && (r.doc as any).thermal.plant.chilled_water_capacity_kW).toMatchObject({ value: 4200, evidence: "E5", source: expect.stringContaining("m.pdf") });
    expect(doc).toEqual({ thermal: { plant: { design_supply_C: 6 } } });
    const bare = applyConfirmedValues({}, {}, c);
    expect(bare.ok && (bare.doc as any).thermal.plant.chilled_water_capacity_kW.value).toBe(4200);
  });

  it("a row with no timestamp still gives provenance, without inventing a date", () => {
    const p = provenanceFor({ field: "firmCapacityMVA", value: 1, unit: "MVA", file: { id: "f", filename: "dso.pdf", sha256: "c".repeat(64) }, locator: "p1", confirmedAt: undefined as unknown as string });
    expect(p.note).toBe("Confirmed by the buyer from their own document. GridForge has not independently verified the document or the figure.");
  });

  it("the provenance names the file and where in it, and never an email", () => {
    const p = provenanceFor({ field: "firmCapacityMVA", value: 1, unit: "MVA", file: { id: "f", filename: "dso.pdf", sha256: "c".repeat(64) }, locator: "clause 4.2", confirmedAt: "2026-10-31T10:00:00Z" });
    expect(p.source).toBe("dso.pdf (sha256 cccccccccccc…), clause 4.2");
    expect(p.note).toContain("2026-10-31");
    expect(p.source + p.note).not.toMatch(/@/);
  });
});
