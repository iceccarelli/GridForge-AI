/**
 * A case revision remembers which engine build produced its answer (migration 0038: power_deployment_cases.engine_provenance).
 *
 * A calibration observation compares the engine's prediction with a site, and a prediction nobody can attribute to a build
 * is not something a ledger row may rest on. The identity is read from the engine's own /v1/version right AFTER a
 * successful assessment (nothing may touch the engine before the metered call, or an over-budget caller would reach it
 * anyway). A recent earlier read of the same process brackets it; if the build changed in between, or the engine will
 * not say what it is, the revision is stored without one. Nothing is invented, and a store that predates the column
 * keeps saving cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "https://engine.test";
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const PROV = (digest: string) => ({ schema: "gridforge/provenance/1", digest, report_date: "2026-03-01", engine_version: "t" });

let db: PostgrestFake;
let restorePg: () => void;
let versionReplies: (() => Response)[];
let assessStatus: number;
let calls: string[];

function install() {
  const pg = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return pg(input as RequestInfo, init);
    calls.push(`${init?.method ?? "GET"} ${url.slice(ENGINE.length)}`);
    if (url.endsWith("/v1/version")) return (versionReplies.shift() ?? (() => new Response("{}", { status: 500 })))();
    return new Response(JSON.stringify({ capacity: { target_MW: 35 }, architectures: [] }), { status: assessStatus });
  }) as typeof fetch;
  return () => { globalThis.fetch = pg; };
}
const version = (digest: string) => () => new Response(JSON.stringify({ version: "t", provenance: PROV(digest) }), { status: 200 });

let restoreEngine: () => void;
beforeEach(async () => {
  vi.resetModules();                                 // the "earlier read" cache is per module instance
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  calls = [];
  versionReplies = [];
  assessStatus = 200;
  db = new PostgrestFake(["power_deployment_cases"]);
  restorePg = db.install();
  restoreEngine = install();
});
afterEach(() => { restoreEngine(); restorePg(); delete process.env.GRIDFORGE_API_URL; delete process.env.GRIDFORGE_API_KEY; });

describe("reading the engine build around an assessment", () => {
  it("reads it once, after the assessment, and says it was not bracketed when nothing earlier exists", async () => {
    versionReplies = [version(D1)];
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    const out = await runDeploymentAssessment({ target_MW: 35 });
    expect(out).toMatchObject({ ok: true, provenance: { digest: D1, report_date: "2026-03-01", read: "after_only" } });
    expect(calls).toEqual(["POST /v1/power/deploy/assess", "GET /v1/version"]);
  });

  it("is bracketed by the previous read when the build has not changed", async () => {
    versionReplies = [version(D1), version(D1)];
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    await runDeploymentAssessment({});
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: { digest: D1, read: "bracketed" } });
  });

  it("drops it when the build changed since the previous read: the answer cannot be attributed to either", async () => {
    versionReplies = [version(D1), version(D2)];
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    await runDeploymentAssessment({});
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: null });
    versionReplies = [version(D2)];
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: { digest: D2, read: "bracketed" } });   // the new build is now the reference
  });

  it("does not touch the engine's version when the assessment itself failed", async () => {
    assessStatus = 503;
    versionReplies = [version(D1)];
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: false });
    expect(calls).toEqual(["POST /v1/power/deploy/assess"]);
  });

  it("drops it when the engine will not say what it is, or answers something that is not a digest", async () => {
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    versionReplies = [() => new Response("nope", { status: 503 })];
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: null });
    versionReplies = [() => new Response(JSON.stringify({ provenance: { digest: "not-hex" } }), { status: 200 })];
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: null });
    versionReplies = [() => new Response(JSON.stringify({}), { status: 200 })];
    expect(await runDeploymentAssessment({})).toMatchObject({ ok: true, provenance: null });
  });

  it("still returns the assessment when the version cannot be read: provenance is evidence about it, not a condition of it", async () => {
    const { runDeploymentAssessment } = await import("@/lib/power-deploy");
    const out = await runDeploymentAssessment({});
    expect(out).toMatchObject({ ok: true, provenance: null });
    expect((out as { result: unknown }).result).toMatchObject({ capacity: { target_MW: 35 } });
  });
});

describe("storing it on the revision", () => {
  it("is written with revision 1 and with every later revision", async () => {
    const { createDeploymentCase, appendDeploymentRevision } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: {}, result: { a: 1 }, engine_provenance: PROV(D1) });
    expect((db.rows("power_deployment_cases")[0] as any).engine_provenance).toMatchObject({ digest: D1 });
    const next = await appendDeploymentRevision(row!.case_token, {}, { a: 2 }, PROV(D2));
    expect(next!.revision).toBe(2);
    expect((db.rows("power_deployment_cases")[1] as any).engine_provenance).toMatchObject({ digest: D2 });
  });

  it("is simply absent when there is none, never an empty or invented object", async () => {
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    await createDeploymentCase({ request: {}, result: {}, engine_provenance: null });
    expect("engine_provenance" in (db.rows("power_deployment_cases")[0] as object)).toBe(false);
  });

  it("keeps saving cases on a store that predates the column", async () => {
    db.dropColumn("power_deployment_cases", "engine_provenance");
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: {}, result: { a: 1 }, engine_provenance: PROV(D1) });
    expect(row).not.toBeNull();
    expect(db.rows("power_deployment_cases")).toHaveLength(1);
    expect("engine_provenance" in (db.rows("power_deployment_cases")[0] as object)).toBe(false);
  });
});
