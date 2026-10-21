/**
 * /api/metered-status and the forms that read it. MOCKS: the engine and PostgREST are test doubles (see metered-readiness.test.ts).
 * A form says "not open yet" only when the server says so explicitly; a missing or broken answer never blocks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { resetApiReadinessCache } from "@/lib/api-readiness";
import { getMeteredStatus } from "@/lib/payg-client";
import { mockEngine, newPaygDb, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let engine: MockEngine;
let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  Object.assign(process.env, { GRIDFORGE_KEY_SECRET: "test-signing-secret", SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetApiReadinessCache();
  db = newPaygDb();
  restore = db.install();
  engine = mockEngine();
});
afterEach(() => { engine.restore(); restore(); resetApiReadinessCache(); vi.restoreAllMocks(); });

describe("GET /api/metered-status", () => {
  it("open: true against an engine that records and caps, with no reason given", async () => {
    const { GET } = await import("@/app/api/metered-status/route");
    const body = await (await GET()).json();
    expect(body).toEqual({ ok: true, open: true });
  });

  it("open: false against an engine from before the ledger, and still no reason", async () => {
    engine.metered = false;
    const { GET } = await import("@/app/api/metered-status/route");
    const res = await GET();
    expect(await res.json()).toEqual({ ok: true, open: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("getMeteredStatus (the form side)", () => {
  const answer = (init: { status?: number; body?: unknown } | "throw") => async () => {
    if (init === "throw") throw new Error("offline");
    return new Response(JSON.stringify(init.body ?? {}), { status: init.status ?? 200 });
  };
  it("closed only on an explicit open:false", async () => {
    expect(await getMeteredStatus(answer({ body: { ok: true, open: false } }))).toBe("closed");
    expect(await getMeteredStatus(answer({ body: { ok: true, open: true } }))).toBe("open");
  });
  it("a missing route, a failure, garbage or no network is unknown, never closed", async () => {
    expect(await getMeteredStatus(answer({ status: 404 }))).toBe("unknown");
    expect(await getMeteredStatus(answer({ status: 500, body: { open: false } }))).toBe("unknown");
    expect(await getMeteredStatus(answer({ body: { open: "no" } }))).toBe("unknown");
    expect(await getMeteredStatus(answer("throw"))).toBe("unknown");
  });
});

describe("the forms use it", () => {
  it("the free-allowance form disables its button and says why when the server says closed", () => {
    const src = fs.readFileSync("components/FreeAllowanceForm.tsx", "utf8");
    expect(src).toMatch(/useMeteredStatus\(\)/);
    expect(src).toMatch(/disabled=\{sending \|\| closed\}/);
    expect(src).toMatch(/Free developer keys are not open on this deployment yet/);
  });
  it("the portal shows no card form for pay-as-you-go while it is closed", () => {
    const src = fs.readFileSync("components/PaygPortal.tsx", "utf8");
    expect(src).toMatch(/metered === "closed"/);
    expect(src).toMatch(/Pay as you go is not open on this deployment yet/);
  });
});
