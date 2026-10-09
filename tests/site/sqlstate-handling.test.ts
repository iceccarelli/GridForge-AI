/**
 * PostgREST answers HTTP 409 for BOTH a unique violation (23505) and a foreign-key violation (23503).
 * Branching on the status alone reports a foreign-key failure as "already recorded". Every refusal
 * must branch on the SQLSTATE: a duplicate is a 409, anything else the store refuses is not.
 *
 * FAKE-BACKED: the in-memory PostgREST with an injected function failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PgError, PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

let db: PostgrestFake;
let restore: () => void;
const CASE = "case-sqlstate";

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["projects", "project_links", "project_events", "power_deployment_cases", "project_evidence"]);
  installProjectRpcs(db);
  db.seed("power_deployment_cases", [{ case_token: CASE, revision: 1, email: null, request: {}, changed_fields: [], result: { architectures: [] } }]);
  restore = db.install();
});
afterEach(() => restore());

const json = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function attach(code: string) {
  const { POST: mk } = await import("@/app/api/projects/route");
  const made: any = await (await mk(json("/api/projects", { project_name: "Hall" }))).json();
  db.rpcs.set("gf_attach_case", () => { throw new PgError(code, `injected ${code}`, 409); });
  const { POST } = await import("@/app/api/projects/[token]/cases/route");
  return POST(json("/x", { case_token: CASE }), { params: Promise.resolve({ token: made.project_token }) });
}

describe("a store refusal is described by its SQLSTATE, not by HTTP 409", () => {
  it("a unique violation is a duplicate (409)", async () => {
    expect((await attach("23505")).status).toBe(409);
  });
  it("a foreign-key violation is NOT reported as 'already attached to a different project'", async () => {
    const res = await attach("23503");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/different project/);
  });
});
