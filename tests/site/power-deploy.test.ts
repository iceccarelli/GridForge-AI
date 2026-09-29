/**
 * lib/power-deploy.ts — the persistence layer under the BTM Power Deployment
 * Case (app/api/power/deploy/cases[/token]).
 *
 * gridforge/reporting/btm_assessment.py composes a real architecture
 * comparison and is already callable over the CLI, REST and MCP, but every
 * call there composes fresh — nothing survives between one request and the
 * next. This is what turns one compute into a case a customer can return to:
 * a row per revision (never a mutable blob, matching HANDOFF.md's rule on
 * fact-in-two-places drift), a token, and a changed_fields note computed by
 * actually diffing this revision's request against the last one's.
 *
 * Tested against the in-memory PostgREST fake (the same one
 * qualify-followup.test.ts and bids.test.ts use) so this exercises the real
 * insert/select shape, not a hand-rolled stand-in for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";
import { changedFields } from "@/lib/power-deploy";

let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["power_deployment_cases"]);
  restore = db.install();
});

afterEach(() => restore());

const REQUEST_V1 = {
  load_profile: { flat_kW: 25000 },
  grid_firm_MW: 10,
  target_MW: 35,
  ride_through_hours: 3,
  redundancy: "N+1",
  generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }],
  bess: [],
};

const RESULT_V1 = {
  capacity: { target_MW: 35, grid_firm_MW: 10, gap_MW: 25 },
  next_action: { action: "Obtain a budgetary or firm quote for: GEN-A" },
};

describe("changedFields", () => {
  it("is empty when there is no previous revision to compare against", () => {
    expect(changedFields(null, REQUEST_V1)).toEqual([]);
  });

  it("names only the fields that actually differ", () => {
    const before = { ...REQUEST_V1 };
    const after = { ...REQUEST_V1, target_MW: 40 };
    expect(changedFields(before, after)).toEqual(["target_MW"]);
  });

  it("detects a change inside a nested array without false-positiving on order-preserving equal arrays", () => {
    const before = { ...REQUEST_V1 };
    const same = { ...REQUEST_V1, generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }] };
    expect(changedFields(before, same)).toEqual([]);
    const changed = { ...REQUEST_V1, generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 25 }] };
    expect(changedFields(before, changed)).toEqual(["generation"]);
  });

  it("reports multiple changed fields, sorted", () => {
    const after = { ...REQUEST_V1, target_MW: 40, grid_firm_MW: 12 };
    expect(changedFields(REQUEST_V1, after)).toEqual(["grid_firm_MW", "target_MW"]);
  });
});

describe("createDeploymentCase", () => {
  it("persists revision 1 with an empty change list", async () => {
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(row).not.toBeNull();
    expect(row!.revision).toBe(1);
    expect(row!.changed_fields).toEqual([]);
    expect(db.rows("power_deployment_cases")).toHaveLength(1);
  });

  it("returns null rather than throwing when the insert fails", async () => {
    db.failMethod = { method: "POST", status: 500, body: "boom" };
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(row).toBeNull();
  });
});

describe("latestDeploymentCase / appendDeploymentRevision", () => {
  it("returns the newest revision, not the first one", async () => {
    const { createDeploymentCase, appendDeploymentRevision, latestDeploymentCase } =
      await import("@/lib/power-deploy");
    const first = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    const updatedRequest = { ...REQUEST_V1, target_MW: 40 };
    const updatedResult = { ...RESULT_V1, capacity: { ...RESULT_V1.capacity, target_MW: 40 } };
    await appendDeploymentRevision(first!.case_token, updatedRequest, updatedResult);

    const latest = await latestDeploymentCase(first!.case_token);
    expect(latest!.revision).toBe(2);
    expect(latest!.changed_fields).toEqual(["target_MW"]);
    expect((latest!.result as typeof updatedResult).capacity.target_MW).toBe(40);
  });

  it("refuses to append a revision to a case that does not exist", async () => {
    const { appendDeploymentRevision } = await import("@/lib/power-deploy");
    const row = await appendDeploymentRevision("no-such-token", REQUEST_V1, RESULT_V1);
    expect(row).toBeNull();
  });

  it("unknown token returns null, not a thrown error", async () => {
    const { latestDeploymentCase } = await import("@/lib/power-deploy");
    await expect(latestDeploymentCase("does-not-exist")).resolves.toBeNull();
  });
});

describe("deploymentCaseHistory", () => {
  it("returns every revision, oldest first", async () => {
    const { createDeploymentCase, appendDeploymentRevision, deploymentCaseHistory } =
      await import("@/lib/power-deploy");
    const first = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    await appendDeploymentRevision(first!.case_token, { ...REQUEST_V1, target_MW: 40 }, RESULT_V1);
    await appendDeploymentRevision(first!.case_token, { ...REQUEST_V1, target_MW: 45 }, RESULT_V1);

    const history = await deploymentCaseHistory(first!.case_token);
    expect(history.map((r) => r.revision)).toEqual([1, 2, 3]);
  });
});

describe("an unreachable store fails closed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("createDeploymentCase falls back to a local (unpersisted) row rather than throwing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(row).not.toBeNull();
    expect(row!.id).toBe("local");
  });

  it("a case created without Supabase can actually be read back and revised — no create-then-404 dead end", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createDeploymentCase, latestDeploymentCase, appendDeploymentRevision, deploymentCaseHistory } =
      await import("@/lib/power-deploy");
    const created = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(created).not.toBeNull();

    const fetched = await latestDeploymentCase(created!.case_token);
    expect(fetched).not.toBeNull();
    expect(fetched!.case_token).toBe(created!.case_token);
    expect(fetched!.revision).toBe(1);

    const revised = await appendDeploymentRevision(
      created!.case_token, { ...REQUEST_V1, target_MW: 40 }, RESULT_V1);
    expect(revised).not.toBeNull();
    expect(revised!.revision).toBe(2);

    const latest = await latestDeploymentCase(created!.case_token);
    expect(latest!.revision).toBe(2);

    const history = await deploymentCaseHistory(created!.case_token);
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
  });

  it("latestDeploymentCase returns null when Supabase is unreachable", async () => {
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    globalThis.fetch = throwing;
    const { latestDeploymentCase } = await import("@/lib/power-deploy");
    await expect(latestDeploymentCase("any-token")).resolves.toBeNull();
  });

  it("refuses to fake a case in a production runtime with Supabase unset — fails closed instead", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    vi.stubEnv("NODE_ENV", "production");
    const { createDeploymentCase } = await import("@/lib/power-deploy");
    const row = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(row).toBeNull();
  });

  it("refuses to append a revision in a production runtime with Supabase unset", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { createDeploymentCase, appendDeploymentRevision } = await import("@/lib/power-deploy");
    const created = await createDeploymentCase({ request: REQUEST_V1, result: RESULT_V1 });
    expect(created).not.toBeNull(); // created while still non-production
    vi.stubEnv("NODE_ENV", "production");
    const revised = await appendDeploymentRevision(created!.case_token, REQUEST_V1, RESULT_V1);
    expect(revised).toBeNull();
  });
});
