/**
 * API plans are sold only against a positive proof that the key we will mint is one the engine accepts and that
 * cancellation can end it. Run against the REAL Python engine (signed-key verifier, operator tier), because
 * "the variable is non-empty" proves neither: the engine verifies with its own copy of the secret.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const SECRET = "s".repeat(40);
const ADMIN = "a".repeat(40);
const procs: ChildProcess[] = [];
const created: Record<string, unknown>[] = [];

vi.mock("stripe", () => ({
  default: class {
    coupons = { create: async () => ({ id: "c" }) };
    checkout = { sessions: { create: async (p: Record<string, unknown>) => { created.push(p); return { url: "https://checkout.stripe.test/s" }; } } };
  },
}));

async function startEngine(env: Record<string, string>): Promise<string> {
  const code = [
    "import os", ...Object.entries(env).map(([k, v]) => `os.environ['${k}']='${v}'`),
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  const p = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  procs.push(p);
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    p.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
afterAll(() => procs.forEach((p) => p.kill()));

const base = { GRIDFORGE_RATE_LIMIT: "0", GRIDFORGE_API_KEYS: "static-operator-key" };
const revokedFile = `${process.env.TMPDIR ?? "/tmp"}/gf-ready-${process.pid}/revoked.json`;

beforeEach(async () => {
  created.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_ready";
  process.env.GRIDFORGE_KEY_SECRET = SECRET;
  process.env.GRIDFORGE_ADMIN_KEY = ADMIN;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { resetApiReadinessCache } = await import("@/lib/api-readiness");
  resetApiReadinessCache();
});
afterEach(() => vi.restoreAllMocks());

const category = async () => (await (await import("@/lib/api-readiness")).apiSalesReadiness()).category;
const checkout = async (product: string) =>
  (await import("@/app/api/checkout/route")).POST(new Request(siteUrl("/api/checkout"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product, email: "dev@example.test" }) }));

describe.runIf(hasPython)("API sales readiness, against the real engine", () => {
  it("is ready only when the engine verifies OUR signed key, knows our admin key, and can persist a revocation", async () => {
    process.env.GRIDFORGE_API_URL = await startEngine({ ...base, GRIDFORGE_KEY_SECRET: SECRET, GRIDFORGE_ADMIN_KEY: ADMIN, GRIDFORGE_REVOKED_FILE: revokedFile });
    expect(await category()).toBe("ready");
    expect((await checkout("api_triage")).status).toBe(200);
    expect(created).toHaveLength(1);
  });

  it("detects a DIFFERENT non-empty signing secret on the engine and sells nothing", async () => {
    process.env.GRIDFORGE_API_URL = await startEngine({ ...base, GRIDFORGE_KEY_SECRET: "x".repeat(40), GRIDFORGE_ADMIN_KEY: ADMIN, GRIDFORGE_REVOKED_FILE: revokedFile });
    expect(await category()).toBe("signing_mismatch");
    const res = await checkout("api_scale");
    expect(res.status).toBe(503);
    expect(created).toHaveLength(0);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(SECRET);
    expect(body).toMatch(/No payment was taken/);
  });

  it("refuses when revocation cannot work: wrong admin key, no admin key, or nowhere to persist", async () => {
    process.env.GRIDFORGE_API_URL = await startEngine({ ...base, GRIDFORGE_KEY_SECRET: SECRET, GRIDFORGE_ADMIN_KEY: "z".repeat(40), GRIDFORGE_REVOKED_FILE: revokedFile });
    expect(await category()).toBe("revocation_mismatch");

    const { resetApiReadinessCache } = await import("@/lib/api-readiness");
    resetApiReadinessCache();
    delete process.env.GRIDFORGE_ADMIN_KEY;
    expect(await category()).toBe("revocation_unconfigured");

    resetApiReadinessCache();
    process.env.GRIDFORGE_ADMIN_KEY = ADMIN;
    process.env.GRIDFORGE_API_URL = await startEngine({ ...base, GRIDFORGE_KEY_SECRET: SECRET, GRIDFORGE_ADMIN_KEY: ADMIN });   // no GRIDFORGE_REVOKED_FILE
    expect(await category()).toBe("revocation_not_persistable");
    expect((await checkout("api_platform")).status).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("the probe is free: it creates no usage, and the engine's own meter is untouched", async () => {
    const url = await startEngine({ ...base, GRIDFORGE_KEY_SECRET: SECRET, GRIDFORGE_ADMIN_KEY: ADMIN, GRIDFORGE_REVOKED_FILE: revokedFile });
    process.env.GRIDFORGE_API_URL = url;
    await category();
    const { issueKey } = await import("@/lib/api-access");
    const usage = await (await fetch(`${url}/v1/usage`, { headers: { "X-API-Key": issueKey({ account: "ttp-readiness-probe", quota: 1, scope: "trial", days: 1 }).token } })).json();
    expect(usage.units).toBe(0);
  });
});

describe("fail closed without needing an engine", () => {
  it("an unset signing secret, an unset engine URL, or an unreachable engine each refuse an API plan before Stripe", async () => {
    const { resetApiReadinessCache } = await import("@/lib/api-readiness");
    delete process.env.GRIDFORGE_KEY_SECRET;
    process.env.GRIDFORGE_API_URL = "http://127.0.0.1:1";
    expect(await category()).toBe("signing_unconfigured");
    resetApiReadinessCache();
    process.env.GRIDFORGE_KEY_SECRET = SECRET;
    expect(await category()).toBe("engine_unreachable");
    resetApiReadinessCache();
    delete process.env.GRIDFORGE_API_URL;
    expect(await category()).toBe("engine_unconfigured");
    expect((await checkout("api_triage")).status).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("never gates a document product on API readiness", async () => {
    delete process.env.GRIDFORGE_KEY_SECRET;
    delete process.env.GRIDFORGE_API_URL;
    expect((await checkout("density_screen")).status).toBe(200);
    expect(created).toHaveLength(1);
  });
});
