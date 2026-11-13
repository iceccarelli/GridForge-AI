/**
 * What a customer is told when migration 0056's publication gates refuse an observation (SQLSTATE GF015, GF016, GF017; GF018 is the release registry's).
 *
 * The database is faked at the PostgREST boundary the way tests/site/project-observations.test.ts does it, and made to refuse as the real function does:
 * with a SQLSTATE of its own and a message full of SQL text. What is asserted is what leaves the route: a short, true sentence that names what is
 * missing and who can supply it, with none of that SQL text, no code and nothing from the request; that nothing was stored; and that the cause is in
 * the server log, scrubbed. The real database raising those codes is tests/test_calibration_publication_gates.py; the codes' meanings are the
 * migration header's, which the first block reads rather than copies.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_POLICY, logPublicationRefusal, publicationRefusal, type PublicationGateCode } from "@/lib/calibration-gate-errors";
import { siteUrl } from "@/lib/site";
import { PgError, PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const ROOT = process.cwd();
const migration = readFileSync(path.join(ROOT, "supabase", "migrations", "0056_calibration_publication_gates.sql"), "utf8");
const CODES: PublicationGateCode[] = ["GF015", "GF016", "GF017", "GF018"];

/** What the database's own message looks like: SQL text, table and function names. It must never reach a person. */
const SQL_TEXT = [
  "the organisation has no standing calibration consent (none was recorded, or it was withdrawn)",
  "CONTEXT:  PL/pgSQL function gf_observation_publication_gates() line 19 at RAISE",
  'SQL statement "insert into public.project_observations (project_id, prediction_ref) values (...)"',
  "calibration_consents calibration_tombstones project_completion_milestones gf_calibration_observation_hash",
].join(" | ");
const LEAKS = /select |insert |trigger|plpgsql|pl\/pgsql|public\.|gf_[a-z_]+|calibration_(consents|tombstones|permissions)|project_completion_milestones|sqlstate|errcode|GF0\d\d|CONTEXT|RAISE/i;

describe("the codes and the policy are the migration's", () => {
  it("lists exactly the four codes the migration raises for the publication gates", () => {
    const raised = new Set([...migration.matchAll(/errcode = '(GF\d{3})'/g)].map((m) => m[1]));
    for (const code of CODES) expect(raised.has(code), code).toBe(true);
    // a code the migration raises that this module does not map is a gap that must be decided, not left to fall through to a generic error
    expect([...raised].filter((c) => !(CODES as string[]).includes(c))).toEqual([]);
  });

  it("states the release policy's numbers as the database function and the engine hold them", () => {
    const fn = migration.slice(migration.indexOf("gf_calibration_release_policy() returns jsonb"), migration.indexOf("$$;", migration.indexOf("gf_calibration_release_policy() returns jsonb")));
    const sql = Object.fromEntries([...fn.matchAll(/'([a-z_]+)', (\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(sql).toEqual({
      min_cell_observations: RELEASE_POLICY.minCellObservations,
      min_cell_organisations: RELEASE_POLICY.minCellOrganisations,
      max_organisation_share_permille: RELEASE_POLICY.maxOrganisationSharePermille,
      release_step_observations: RELEASE_POLICY.releaseStepObservations,
      release_step_organisations: RELEASE_POLICY.releaseStepOrganisations,
      min_release_interval_days: RELEASE_POLICY.minReleaseIntervalDays,
    });
    const py = readFileSync(path.join(ROOT, "gridforge", "calibration", "release.py"), "utf8");
    expect(py).toMatch(new RegExp(`^MIN_CELL_OBSERVATIONS = ${RELEASE_POLICY.minCellObservations}$`, "m"));
    expect(py).toMatch(new RegExp(`^MIN_CELL_ORGANISATIONS = ${RELEASE_POLICY.minCellOrganisations}$`, "m"));
    expect(py).toMatch(new RegExp(`^RELEASE_STEP_OBSERVATIONS = ${RELEASE_POLICY.releaseStepObservations}$`, "m"));
    expect(py).toMatch(new RegExp(`^RELEASE_STEP_ORGANISATIONS = ${RELEASE_POLICY.releaseStepOrganisations}$`, "m"));
    expect(py).toMatch(new RegExp(`^MIN_RELEASE_INTERVAL = timedelta\\(days=${RELEASE_POLICY.minReleaseIntervalDays}\\)$`, "m"));
    const publication = readFileSync(path.join(ROOT, "gridforge", "calibration", "publication.py"), "utf8");
    expect(publication).toMatch(new RegExp(`^MAX_SINGLE_SITE_SHARE = ${RELEASE_POLICY.maxOrganisationSharePermille / 1000}$`, "m"));
  });
});

describe("the mapping", () => {
  it.each(CODES)("%s has a status, a gate and a short sentence with no SQL text, no code and no table name", (code) => {
    const r = publicationRefusal(code)!;
    expect(r.code).toBe(code);
    expect(r.status).toBe(409);
    expect(r.error.length).toBeGreaterThan(60);
    expect(r.error.length).toBeLessThan(600);
    expect(r.error).not.toMatch(LEAKS);
  });

  it("names what is missing and who can supply it", () => {
    expect(publicationRefusal("GF015")!.error).toMatch(/attached to a hall of an organisation/);
    expect(publicationRefusal("GF015")!.error).toMatch(/organisation's owner has to record its consent/);
    expect(publicationRefusal("GF016")!.error).toMatch(/attested that it reached completion/);
    expect(publicationRefusal("GF016")!.error).toMatch(/editor or an owner of the project's organisation attests/);
    expect(publicationRefusal("GF017")!.error).toMatch(/withdrawn together with its organisation's consent/);
    expect(publicationRefusal("GF018")!.error).toMatch(/at least 10 observations from at least 3 organisations, none supplying more than 40%/);
    expect(publicationRefusal("GF018")!.error).toMatch(/at least 30 days after the previous release/);
  });

  it("says plainly that there is no page for consent or for the milestone yet, and does not point at one", () => {
    for (const code of ["GF015", "GF016"] as const) {
      const e = publicationRefusal(code)!.error;
      expect(e).toMatch(/There is no page for this yet: write to us from \/contact\./);
      expect(e).not.toMatch(/account page|\/account|settings|dashboard/i);
    }
  });

  it("does not map anything else, including names that exist on every object", () => {
    for (const code of ["23505", "23514", "GF004", "GF010", "GF014", "GF019", "gf015", "GF015 ", "", "constructor", "__proto__", "toString", undefined, null, 15, {}]) {
      expect(publicationRefusal(code), String(code)).toBeNull();
    }
  });

  it("logs which gate refused and for which record, scrubbed, and nothing else", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logPublicationRefusal(publicationRefusal("GF016")!, "observation", "00000000-0000-4000-8000-000000000001 owner@example.test /project/abcdefghijklmnop");
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toContain("completion_milestone");
      expect(line).toContain("GF016");
      expect(line).toContain("00000000-0000-4000-8000-000000000001");
      expect(line).not.toContain("owner@example.test");
      expect(line).not.toContain("abcdefghijklmnop");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------- through the route

const ARCH = "GRID + BESS + GENERATION";
const CASE = "case-tok-1";
let db: PostgrestFake;
let restore: () => void;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake([
    "projects", "project_links", "project_events", "project_evidence", "project_observations", "project_observation_reviews", "supplier_actuals",
    "supplier_actual_reviews", "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "procurement_packages", "procurement_responses",
    "procurement_comparisons", "power_deployment_cases", "calibration_permissions",
  ]);
  db.uniqueKeys.set("project_links", [["project_id", "object_type", "object_id"]]);
  installProjectRpcs(db);
  db.seed("power_deployment_cases", [{
    case_token: CASE, revision: 1, email: null, request: {}, changed_fields: [], created_at: "2026-03-02T09:00:00Z", case_digest: "b".repeat(64),
    engine_provenance: { digest: "c".repeat(64), report_date: "2026-03-01", engine_version: "test" },
    result: { architectures: [{ label: ARCH, status: "pass", available_MW: 36.4, margin_MW: 1.4, rfq_ready: true, readiness_gates: [] }] },
  }]);
  restore = db.install();
  process.env.VERCEL_ENV = "production";
  process.env.GRIDFORGE_SITE_REF_SECRET = "test-site-ref-secret-0123456789-not-real";
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  errors.mockRestore();
  delete process.env.VERCEL_ENV;
  delete process.env.GRIDFORGE_SITE_REF_SECRET;
});

const json = (p: string, body: unknown) => new Request(siteUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function project() {
  const { POST } = await import("@/app/api/projects/route");
  const made: any = await (await POST(json("/api/projects", { project_name: "Hall A", site_label: "Dublin DC1" }))).json();
  const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
  await attach(json("/x", { case_token: CASE }), ctx({ token: made.project_token }));
  const id = db.rows("projects").find((p) => p.project_token === made.project_token)!.id as string;
  const evidence = db.insertRow("project_evidence", {
    project_id: id, filename: "meter.csv", media_type: "text/csv", sha256: "a".repeat(64), byte_size: 10, storage_ref: "b/x", source_category: "load_data",
    evidence_class: null, review_status: "verified",
  }).id as string;
  return { token: made.project_token as string, id, evidence };
}
const body = (evidence: string) => ({
  calibration_key: "btm.firm_MW", case_token: CASE, architecture: ARCH, observed_value: 33.0, observed_on: "2026-09-30", method: "revenue meter, 30-day export trend",
  submitted_by: "A. Rivera, site engineer", measurement_kind: "metered", evidence_id: evidence, attests_installed_architecture: true,
  installed_basis: "commissioning certificate CC-114, signed 2026-09-12",
});
async function submit(token: string, b: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[token]/observations/route");
  const res = await POST(json("/x", b), ctx({ token }));
  return { res, body: (await res.json()) as any };
}
const logged = () => errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

describe("through the observation route", () => {
  it.each(["GF015", "GF016", "GF017"] as const)("%s: a true sentence, no SQL text, nothing stored, the cause logged", async (code) => {
    const p = await project();
    const events = db.rows("project_events").length;
    db.rpcs.set("gf_submit_observation", () => { throw new PgError(code, SQL_TEXT, 400); });
    const r = await submit(p.token, body(p.evidence));
    const expected = publicationRefusal(code)!;
    expect(r.res.status).toBe(expected.status);
    expect(r.body.error).toBe(expected.error);
    // nothing of the database's own words, no code, no token reaches the caller
    expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    expect(JSON.stringify(r.body)).not.toContain(p.token);
    expect(db.rows("project_observations")).toHaveLength(0);
    expect(db.rows("project_events")).toHaveLength(events);
    // the operator can see which gate refused, for which project (its id, not its link token) - and still not the database's own text
    const log = logged();
    expect(log).toContain(code);
    expect(log).toContain(p.id);
    expect(log).not.toContain(p.token);
    expect(log).not.toMatch(/PL\/pgSQL|insert into public|CONTEXT:/);
  });

  it("an unknown database code is still a generic 502 that says nothing was recorded, and a neighbouring code (GF019) is not taken for a gate", async () => {
    const p = await project();
    for (const code of ["GF019", "GF012", "XX000"]) {
      db.rpcs.set("gf_submit_observation", () => { throw new PgError(code, SQL_TEXT, 400); });
      const r = await submit(p.token, body(p.evidence));
      expect(r.res.status, code).toBe(502);
      expect(r.body.error).toBe("The observation could not be saved. Nothing was recorded.");
    }
  });

  it("the earlier refusals keep their own words: the late forecast (GF004) and the duplicate (23505) are not swallowed by the new mapping", async () => {
    const p = await project();
    db.rpcs.set("gf_submit_observation", () => { throw new PgError("GF004", "the forecast must predate the outcome", 400); });
    expect((await submit(p.token, body(p.evidence))).res.status).toBe(422);
    db.rpcs.set("gf_submit_observation", () => { throw new PgError("23505", "duplicate key value violates unique constraint", 409); });
    const dup = await submit(p.token, body(p.evidence));
    expect(dup.res.status).toBe(409);
    expect(dup.body.error).toBe("An observation of this prediction for that date is already recorded.");
  });

  it("a submission the database accepts is untouched by any of this", async () => {
    const p = await project();
    const r = await submit(p.token, body(p.evidence));
    expect(r.res.status).toBe(201);
    expect(db.rows("project_observations")).toHaveLength(1);
    expect(logged()).not.toMatch(/gate \(GF0/);
  });
});

describe("the history's event types", () => {
  it("lib/projects.ts names every event type that migration 0056 adds to the history's check, so the type system knows what the database may hold", () => {
    const added = [...(migration.match(/want text\[\] := array\[([^\]]*)\]/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(added).toContain("completion_milestone_attested");
    const projects = readFileSync(path.join(ROOT, "lib", "projects.ts"), "utf8");
    const union = projects.slice(projects.indexOf("export type ProjectEventType"), projects.indexOf("export interface ProjectRow"));
    for (const type of added) expect(union, type).toContain(`"${type}"`);
  });
});

describe("the copy that states what 0056 and the site do", () => {
  it("the migration header does not say the library maps none of the codes, and the library does map the three the insert gate raises", () => {
    expect(migration.slice(0, 9000)).not.toMatch(/maps none of the[\s-]+codes/);
    const lib = readFileSync(path.join(ROOT, "lib", "project-observations.ts"), "utf8");
    expect(lib).toContain("publicationRefusal(added.code)");
    for (const code of ["GF015", "GF016", "GF017"]) expect(publicationRefusal(code)?.code).toBe(code);
  });

  it("the capability registry's calibration entry names every table 0056 adds and says it is written, not applied", () => {
    const registry = readFileSync(path.join(ROOT, "lib", "capability-registry.ts"), "utf8");
    const entry = registry.slice(registry.indexOf('capability_id: "calibration_capture"'), registry.indexOf('capability_id: "site_hall_registry"'));
    for (const table of ["calibration_consents", "project_completion_milestones", "calibration_tombstones", "calibration_release_snapshots", "calibration_snapshot_supersessions"]) {
      expect(entry, table).toContain(table);
    }
    expect(entry).toMatch(/0056[^"]*(written, not applied|WRITTEN, NOT APPLIED)/i);
  });
});
