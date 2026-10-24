/**
 * The RFQ loop (lib/project-procurement.ts) against an engine that does not serve /v1/power/deploy/spec or /bids.
 * callEngine reports the engine's own "not found" for a route as {status: 503, routeMissing: true}; every procurement
 * step must pass that on as 503 "not deployed yet, nothing charged" and not fold it into a generic 502 "unavailable".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const engineCalls: string[] = [];
let engineAnswer: "missing" | "down" | "refused" = "missing";

vi.mock("@/lib/power-deploy", async (orig) => {
  const actual = await orig<typeof import("@/lib/power-deploy")>();
  return {
    ...actual,
    latestDeploymentCase: vi.fn(async () => ({
      case_token: "case1",
      revision: 1,
      email: null,
      request: { target_MW: 35 },
      result: { architectures: [{ label: "GRID + GENERATION", rfq_ready: true }] },
    })),
    deploymentCaseRevision: vi.fn(async () => ({ request: { target_MW: 35 } })),
    callEngine: vi.fn(async (path: string) => {
      engineCalls.push(path);
      if (engineAnswer === "missing") {
        return { ok: false, status: 503, routeMissing: true, body: {}, error: `the deployed engine does not serve ${path} yet` };
      }
      if (engineAnswer === "refused") return { ok: false, status: 422, body: {}, error: "bad response schedule" };
      return { ok: false, status: 0, body: {}, error: "engine unreachable" };
    }),
  };
});

vi.mock("@/lib/projects", async (orig) => {
  const actual = await orig<typeof import("@/lib/projects")>();
  const pkg = {
    id: "pkg1",
    package_token: "pkgtok",
    project_id: "proj1",
    case_token: "case1",
    case_revision: 1,
    architecture: "GRID + GENERATION",
    selected_supplier: null,
  };
  return {
    ...actual,
    creds: () => ({ url: "https://stub", headers: {} }),
    linksFor: vi.fn(async () => ({ ok: true, links: [{ project_id: "proj1" }] })),
    rest: vi.fn(async (_m: string, p: string) => {
      if (p.startsWith("procurement_packages")) return { ok: true, status: 200, data: [pkg] };
      if (p.startsWith("procurement_responses")) return { ok: true, status: 200, data: [{ id: "r1", supplier: "Acme", response: { supplier: "Acme" } }] };
      return { ok: true, status: 200, data: [] };
    }),
    rpc: vi.fn(async () => ({ ok: false, status: 500 })),
  };
});

const project = { id: "proj1", project_name: "North Campus" } as any;

beforeEach(() => {
  engineCalls.length = 0;
  engineAnswer = "missing";
});

describe("project procurement with a route missing from the deployed engine", () => {
  it("RFQ package: 503 'not deployed', not 502", async () => {
    const { generateRfqPackage } = await import("@/lib/project-procurement");
    const { ROUTE_NOT_DEPLOYED_MESSAGE } = await import("@/lib/power-deploy");
    const out = await generateRfqPackage(project, { case_token: "case1", architecture: "GRID + GENERATION" });
    expect(engineCalls).toEqual(["/v1/power/deploy/spec"]);
    expect(out).toEqual({ ok: false, status: 503, error: ROUTE_NOT_DEPLOYED_MESSAGE });
    expect(ROUTE_NOT_DEPLOYED_MESSAGE).toMatch(/not deployed yet/);
    expect(ROUTE_NOT_DEPLOYED_MESSAGE).toMatch(/charged/);
  });

  it("supplier response: 503 'not deployed' and nothing is saved", async () => {
    const { submitSupplierResponse } = await import("@/lib/project-procurement");
    const { ROUTE_NOT_DEPLOYED_MESSAGE } = await import("@/lib/power-deploy");
    const out = await submitSupplierResponse(project, "pkgtok", { supplier: "Globex" });
    expect(engineCalls).toEqual(["/v1/power/deploy/bids"]);
    expect(out).toEqual({ ok: false, status: 503, error: ROUTE_NOT_DEPLOYED_MESSAGE });
    const { rpc } = await import("@/lib/projects");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("comparison: 503 'not deployed' and nothing is saved", async () => {
    const { runPackageComparison } = await import("@/lib/project-procurement");
    const { ROUTE_NOT_DEPLOYED_MESSAGE } = await import("@/lib/power-deploy");
    const out = await runPackageComparison(project, "pkgtok");
    expect(engineCalls).toEqual(["/v1/power/deploy/bids"]);
    expect(out).toEqual({ ok: false, status: 503, error: ROUTE_NOT_DEPLOYED_MESSAGE });
  });

  it("other engine failures keep their own statuses (a refusal is 422, an outage is 502)", async () => {
    const { submitSupplierResponse, runPackageComparison } = await import("@/lib/project-procurement");
    engineAnswer = "refused";
    expect(await submitSupplierResponse(project, "pkgtok", { supplier: "Globex" })).toMatchObject({ ok: false, status: 422 });
    engineAnswer = "down";
    expect(await submitSupplierResponse(project, "pkgtok", { supplier: "Globex" })).toMatchObject({ ok: false, status: 502 });
    expect(await runPackageComparison(project, "pkgtok")).toMatchObject({ ok: false, status: 502 });
  });
});
