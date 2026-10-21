/**
 * Every public or low-trust path that can spend a shared provider credential, driven through its REAL route handler.
 *
 * Both providers are stand-ins that COUNT what they were really asked to do (the capacity engine and Anthropic), the store is
 * the in-memory PostgREST that includes migration 0024's counter, and every test asserts the same three things in order:
 *   1. a request that is invalid, oversized or unauthorised is refused WITHOUT touching a provider and WITHOUT using anyone's allowance;
 *   2. a request over its limit, or whose provider budget is spent, answers 429 with Retry-After and the provider is never called;
 *   3. an allowed request keeps its existing response contract.
 * Atomicity and concurrency of the counter against PostgreSQL itself are proven in provider-spend.realdb.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import {
  PROVIDER_BUDGETS,
  RATE_POLICIES,
  callerIdentity,
  subjectOf,
  type RatePolicyName,
} from "@/lib/rate-limit";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_CHARS } from "@/lib/ai/context";
import { MAX_TOOL_CALLS_PER_TURN } from "@/lib/ai/policy";
import { ENGINE_BODY_MAX_BYTES } from "@/lib/http-body";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import { bearerFor, installWithAuth } from "./auth-fake";

const ENGINE = "http://engine.test";
const IP = "203.0.113.10";

let db: PostgrestFake;
let restore: () => void;
let engine: { path: string; body: any }[];
let anthropic: number;
let engineAnswer: (path: string, body: any) => { status: number; body: unknown };
let anthropicScript: ((n: number) => unknown)[];
let logs: string[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installProviders(base: () => typeof fetch) {
  const inner = base();
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith(ENGINE)) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      engine.push({ path: new URL(url).pathname, body });
      const out = engineAnswer(new URL(url).pathname, body);
      return json(out.status, out.body);
    }
    if (url.includes("api.anthropic.com/v1/messages")) {
      const n = anthropic++;
      const script = anthropicScript[Math.min(n, anthropicScript.length - 1)];
      return json(200, script(n));
    }
    return inner(i, init);
  }) as typeof fetch;
}

const message = (content: unknown[]) => ({
  id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
  stop_reason: content.some((c: any) => c.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const text = (t: string) => message([{ type: "text", text: t }]);
const wantsQualify = (n: number) =>
  message([{ type: "tool_use", id: `tu_${n}`, name: "gridforge_qualify", input: { contracted_MW: 12, current_site_peak_MW: 7.4, current_it_load_MW: 4.9, busway_ampacity_A: 400, tapoff_max_A: 63, plant_supply_C: 6, positions_available: 180 } }]);

beforeEach(() => {
  resetMemoryLimiter();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  process.env.ANTHROPIC_API_KEY = "sk-ant-never-called";
  delete process.env.RESEND_API_KEY;
  delete process.env.VERCEL;
  delete process.env.GRIDFORGE_TRUSTED_IP_HEADER;
  engine = [];
  anthropic = 0;
  engineAnswer = () => ({
    status: 200,
    body: {
      platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72" },
      as_found: { racks: 28, binding_constraint: "Rack feed / tap-off rating" },
      after_relief: { racks: 60 },
      intake: { completeness: 0.7 },
    },
  });
  anthropicScript = [() => text("ok")];
  db = new PostgrestFake([
    "qualifications", "power_deployment_cases", "projects", "project_links", "project_events", "leads", "deliverables",
    "watches", "watch_notes", "subscriptions", "procurement_packages", "procurement_responses", "procurement_comparisons",
    "project_evidence", "cost_evidence_state", "cost_evidence_runs",
  ]);
  installProjectRpcs(db);
  restore = db.install();
  installProviders(() => globalThis.fetch);
  logs = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------------------------------------------
const ctx = <T extends Record<string, string>>(token: string, extra?: T) => ({ params: Promise.resolve({ token, ...(extra as T) }) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": IP, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const windowStart = (seconds: number) => Math.floor(Date.now() / 1000 / seconds) * seconds;
const rl = () => db.rows("rate_limit_windows");
const hitsOf = (bucket: string) => rl().filter((r) => r.bucket === bucket).reduce((n, r) => n + (r.hits as number), 0);

/** Put a counter at its limit for the caller `headers` identifies, as if it had already been spent. */
function exhaustRoute(name: RatePolicyName, headers: Record<string, string> = { "x-forwarded-for": IP }) {
  const who = callerIdentity(new Request("http://x", { headers }));
  const p = RATE_POLICIES[name];
  db.insertRow("rate_limit_windows", { bucket: p.bucket, subject: who.ok ? who.subject : "", window_start: windowStart(p.windowSeconds), hits: p.limit });
}
function exhaustProvider(key: keyof typeof PROVIDER_BUDGETS, which: "caller" | "aggregate", headers: Record<string, string> = { "x-forwarded-for": IP }, leave = 0) {
  const who = callerIdentity(new Request("http://x", { headers }));
  const b = PROVIDER_BUDGETS[key][which];
  db.insertRow("rate_limit_windows", {
    bucket: b.bucket, subject: which === "caller" ? (who.ok ? who.subject : "") : subjectOf("aggregate"),
    window_start: windowStart(b.windowSeconds), hits: b.limit - leave,
  });
}

function expect429(res: Response) {
  expect(res.status).toBe(429);
  const retry = Number(res.headers.get("retry-after"));
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(3600);
}

const HALL = { contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180 };
const DEPLOY = { load_profile: { flat_kW: 30000 }, grid_firm_MW: 10, target_MW: 35, redundancy: "N+1", generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }], bess: [] };

// ----------------------------------------------------------------------------------------------------------------
describe("POST /api/qualify (the free front door, still the company's engine)", () => {
  const route = () => import("@/app/api/qualify/route");

  it("allowed: the existing contract, one free-tier engine call, counted at both levels", async () => {
    const res = await (await route()).POST(post("/api/qualify", HALL));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, result: expect.any(Object), headline: expect.any(String) });
    expect(engine.map((e) => e.path)).toEqual(["/v1/qualify"]);
    expect([hitsOf("qualify"), hitsOf("engine_public_free_caller"), hitsOf("engine_public_free")]).toEqual([1, 1, 1]);
    expect(hitsOf("engine_public")).toBe(0); // the free tier is not metered units
  });

  it("over its limit: 429 + Retry-After, the engine is never called, nothing is stored", async () => {
    exhaustRoute("qualify");
    const res = await (await route()).POST(post("/api/qualify", HALL));
    expect429(res);
    expect(engine).toHaveLength(0);
    expect(db.rows("qualifications")).toHaveLength(0);
  });

  it("a spent provider budget refuses it even though the route allowance is fresh, and records no 'engine unavailable' lead", async () => {
    exhaustProvider("engine:public:free", "caller");
    const res = await (await route()).POST(post("/api/qualify", HALL));
    expect429(res);
    expect(engine).toHaveLength(0);
    expect(db.rows("qualifications")).toHaveLength(0);
  });

  it("an oversized body is refused before it is parsed, and costs no allowance", async () => {
    const res = await (await route()).POST(post("/api/qualify", { ...HALL, name: "x".repeat(40 * 1024) }));
    expect(res.status).toBe(413);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("invalid input is refused without using anyone's allowance", async () => {
    const r = await (await route()).POST(post("/api/qualify", { ...HALL, contractedMW: -1 }));
    expect(r.status).toBe(422);
    const r2 = await (await route()).POST(post("/api/qualify", "{not json"));
    expect(r2.status).toBe(400);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("fails closed with a non-sensitive 503 when the counter is not there, and the engine is not called", async () => {
    db.rpcs.delete("gf_rate_limit_hit");
    const res = await (await route()).POST(post("/api/qualify", HALL));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/0024|supabase|rpc|rate_limit/i);
    expect(engine).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("POST /api/power/deploy/cases and /cases/[token]", () => {
  const create = () => import("@/app/api/power/deploy/cases/route");
  const revise = () => import("@/app/api/power/deploy/cases/[token]/route");
  beforeEach(() => {
    engineAnswer = () => ({ status: 200, body: { capacity: { target_MW: 35, grid_firm_MW: 10, gap_MW: 25 }, architectures: [], next_action: { action: "x" } } });
  });

  it("create, allowed: the existing contract", async () => {
    const res = await (await create()).POST(post("/api/power/deploy/cases", DEPLOY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, case_token: expect.any(String), revision: 1 });
    // the metered assessment, then the unmetered read of the engine's own build identity that the case revision records
    expect(engine.map((e) => e.path)).toEqual(["/v1/power/deploy/assess", "/v1/version"]);
    expect([hitsOf("deploy_case"), hitsOf("engine_public_caller"), hitsOf("engine_public")]).toEqual([1, 1, 1]);
  });

  it("create, over its limit: 429, engine not called, no case written", async () => {
    exhaustRoute("deploy_case");
    expect429(await (await create()).POST(post("/api/power/deploy/cases", DEPLOY)));
    expect(engine).toHaveLength(0);
    expect(db.rows("power_deployment_cases")).toHaveLength(0);
  });

  it("create, a body larger than the engine itself accepts: 413 before anything", async () => {
    const res = await (await create()).POST(post("/api/power/deploy/cases", { ...DEPLOY, load_profile: { csv: "x".repeat(ENGINE_BODY_MAX_BYTES + 10) } }));
    expect(res.status).toBe(413);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("create into a project whose token is wrong: 404 before the limit and before the engine", async () => {
    const res = await (await create()).POST(post("/api/power/deploy/cases", { ...DEPLOY, project_token: "no-such-project" }));
    expect(res.status).toBe(404);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  describe("revision", () => {
    async function mkCase(email?: string) {
      const res = await (await create()).POST(post("/api/power/deploy/cases", { ...DEPLOY, ...(email ? { email } : {}) }));
      const token = (await res.json()).case_token as string;
      engine.length = 0;
      rl().length = 0;
      return token;
    }

    it("an unknown case is 404, an email-registered case with the wrong email is 403 — both BEFORE any limit or engine call", async () => {
      expect((await (await revise()).POST(post("/x", { target_MW: 40 }), ctx("nope"))).status).toBe(404);
      const token = await mkCase("owner@hall.example");
      const wrong = await (await revise()).POST(post("/x", { target_MW: 40, email: "intruder@evil.example" }), ctx(token));
      expect(wrong.status).toBe(403);
      const none = await (await revise()).POST(post("/x", { target_MW: 40 }), ctx(token));
      expect(none.status).toBe(403);
      expect(engine).toHaveLength(0);
      expect(rl()).toHaveLength(0);
    });

    it("an authorised revision over its limit: 429, engine not called, no revision written", async () => {
      const token = await mkCase("owner@hall.example");
      exhaustRoute("deploy_case");
      expect429(await (await revise()).POST(post("/x", { target_MW: 40, email: "owner@hall.example" }), ctx(token)));
      expect(engine).toHaveLength(0);
      expect(db.rows("power_deployment_cases")).toHaveLength(1);
    });

    it("an authorised revision keeps its contract and shares the create route's allowance (one policy, not two)", async () => {
      const token = await mkCase("owner@hall.example");
      const res = await (await revise()).POST(post("/x", { target_MW: 40, email: "OWNER@hall.example" }), ctx(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, revision: 2, changed_fields: expect.any(Array) });
      expect(hitsOf("deploy_case")).toBe(1);
    });

    it("an oversized revision is 413 before the engine", async () => {
      const token = await mkCase();
      const res = await (await revise()).POST(post("/x", { load_profile: { csv: "y".repeat(ENGINE_BODY_MAX_BYTES + 10) } }), ctx(token));
      expect(res.status).toBe(413);
      expect(engine).toHaveLength(0);
    });
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("one budget across every route: switching route does not buy a second allowance", () => {
  it("a caller whose metered-engine budget is spent is refused by EVERY route that would spend it, with fresh route allowances", async () => {
    exhaustProvider("engine:public:metered", "caller");
    const compare = (await import("@/app/api/power/compare/route")).POST;
    const deploy = (await import("@/app/api/power/deploy/cases/route")).POST;
    const hall = { siteName: "H", hallId: "H1", contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, positionsAvailable: 180, plantSupplyC: 6 };
    expect429(await compare(post("/api/power/compare", { hall })));
    expect429(await deploy(post("/api/power/deploy/cases", DEPLOY)));
    expect(engine).toHaveLength(0);
    // The free tier is a different resource and is unaffected.
    expect((await (await import("@/app/api/qualify/route")).POST(post("/api/qualify", HALL))).status).toBe(200);
  });

  it("a different caller is unaffected (the budget is per caller)", async () => {
    exhaustProvider("engine:public:metered", "caller");
    const deploy = (await import("@/app/api/power/deploy/cases/route")).POST;
    engineAnswer = () => ({ status: 200, body: { capacity: {}, architectures: [] } });
    expect((await deploy(post("/api/power/deploy/cases", DEPLOY, { "x-forwarded-for": "198.51.100.42" }))).status).toBe(200);
  });

  it("the shared aggregate refuses every caller once it is spent", async () => {
    exhaustProvider("engine:public:metered", "aggregate");
    const deploy = (await import("@/app/api/power/deploy/cases/route")).POST;
    expect429(await deploy(post("/api/power/deploy/cases", DEPLOY, { "x-forwarded-for": "198.51.100.43" })));
    expect(engine).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("POST /api/chat: one request, several provider calls", () => {
  const route = () => import("@/app/api/chat/route");
  const chat = (messages: unknown, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post("/api/chat", { messages, ...extra }, headers);
  const convo = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` }));

  it("allowed: the existing contract { ok, reply, lead } and one model call", async () => {
    const res = await (await route()).POST(chat([{ role: "user", content: "Can my hall take GB300?" }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reply: "ok", lead: null });
    expect(anthropic).toBe(1);
    expect([hitsOf("chat"), hitsOf("anthropic_public_caller"), hitsOf("anthropic_public")]).toEqual([1, 1, 1]);
  });

  it("an oversized body, message or transcript is 413 BEFORE the model is called, and costs no allowance", async () => {
    const r = await route();
    const huge = await r.POST(chat([{ role: "user", content: "x".repeat(200 * 1024) }]));
    expect(huge.status).toBe(413);
    const longMsg = await r.POST(chat([{ role: "user", content: "x".repeat(MAX_MESSAGE_CHARS + 1) }]));
    expect(longMsg.status).toBe(413);
    const many = await r.POST(chat(Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "y".repeat(Math.ceil(MAX_TRANSCRIPT_CHARS / 19)) }))));
    expect(many.status).toBe(413);
    expect(anthropic).toBe(0);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("a message at exactly the ceiling is accepted (the cap is not stricter than documented)", async () => {
    const res = await (await route()).POST(chat([{ role: "user", content: "z".repeat(MAX_MESSAGE_CHARS) }]));
    expect(res.status).toBe(200);
  });

  it("no messages / invalid JSON are refused without cost", async () => {
    const r = await route();
    expect((await r.POST(chat([]))).status).toBe(400);
    expect((await r.POST(post("/api/chat", "{nope"))).status).toBe(400);
    expect(anthropic).toBe(0);
    expect(rl()).toHaveLength(0);
  });

  it("over its request limit: 429 + Retry-After, no model call, no tool call", async () => {
    exhaustRoute("chat");
    expect429(await (await route()).POST(chat([{ role: "user", content: "hello" }])));
    expect(anthropic).toBe(0);
    expect(engine).toHaveLength(0);
  });

  it("fan-out is bounded by the code that fans out: a model that asks for a tool every round gets MAX_TOOL_CALLS_PER_TURN engine calls, MAX+1 rounds, and the extraction call — no more", async () => {
    anthropicScript = [(n) => wantsQualify(n)];
    // Messages >= 3 triggers lead extraction, an additional Anthropic call (it answers `wantsQualify`, which parses to nothing).
    const res = await (await route()).POST(chat(convo(3)));
    expect(res.status).toBe(200);
    expect(engine.map((e) => e.path)).toEqual(Array(MAX_TOOL_CALLS_PER_TURN).fill("/v1/qualify"));
    expect(anthropic).toBe(MAX_TOOL_CALLS_PER_TURN + 1 + 1);
    // And every one of those calls was counted, individually, against the caller and the shared budgets.
    expect(hitsOf("anthropic_public_caller")).toBe(MAX_TOOL_CALLS_PER_TURN + 2);
    expect(hitsOf("anthropic_public")).toBe(MAX_TOOL_CALLS_PER_TURN + 2);
    expect(hitsOf("engine_public_free_caller")).toBe(MAX_TOOL_CALLS_PER_TURN);
    expect(hitsOf("chat")).toBe(1);
  });

  it("exhausting the Anthropic budget in the middle of a turn stops provider work at that call: 429, nothing further is called or stored", async () => {
    anthropicScript = [(n) => wantsQualify(n)];
    exhaustProvider("anthropic:public", "caller", { "x-forwarded-for": IP }, 2); // two calls left
    const res = await (await route()).POST(chat(convo(3)));
    expect429(res);
    expect(anthropic).toBe(2);                        // exactly the two that were allowed
    expect(engine.length).toBeLessThanOrEqual(2);     // tool calls only follow allowed model rounds
    expect(db.rows("leads")).toHaveLength(0);          // the half-finished turn captured no lead
  });

  it("a tool call cannot go around the shared engine budget: a spent free-tier aggregate refuses the whole request", async () => {
    anthropicScript = [(n) => wantsQualify(n)];
    exhaustProvider("engine:public:free", "aggregate");
    const res = await (await route()).POST(chat([{ role: "user", content: "run it" }]));
    expect429(res);
    expect(engine).toHaveLength(0);
    expect(anthropic).toBeLessThanOrEqual(2);         // the model call that asked for the tool, then nothing more once refused
  });

  it("a refused model call is not retried by the SDK and not re-counted: the refusal says do not retry", async () => {
    anthropicScript = [(n) => wantsQualify(n)];
    exhaustProvider("anthropic:public", "caller", { "x-forwarded-for": IP }, 1); // exactly one call left
    const res = await (await route()).POST(chat([{ role: "user", content: "run it" }]));
    expect429(res);
    expect(anthropic).toBe(1);   // the allowed call reached the provider; the refused one never did, and was not retried
    expect(engine).toHaveLength(1);
    // Pre-seeded to (limit - 1): +1 for the allowed call, +1 for the refused one. SDK retries (maxRetries 2) would have made this +3.
    expect(hitsOf("anthropic_public_caller")).toBe(PROVIDER_BUDGETS["anthropic:public"].caller.limit + 1);
  });

  it("logs and error bodies carry no prompt, no address and no key", async () => {
    anthropicScript = [() => { throw new Error("provider exploded with sk-ant-never-called and the prompt SECRET-PROMPT"); }];
    const res = await (await route()).POST(chat([{ role: "user", content: "SECRET-PROMPT please" }]));
    const out = JSON.stringify(await res.json());
    expect(out).not.toMatch(/SECRET-PROMPT|sk-ant|203\.0\.113/);
    expect(logs.join("\n")).not.toContain(IP);
    expect(logs.join("\n")).not.toMatch(/SECRET-PROMPT please/);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("POST /api/siting-analysis (verified subscriber, paid model)", () => {
  const SUB = "ops@northhall.example";
  const route = () => import("@/app/api/siting-analysis/route");
  const ask = (body: unknown, email: string | null = SUB, headers: Record<string, string> = {}) =>
    new Request(siteUrl("/api/siting-analysis"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": IP, ...(email ? bearerFor(email) : {}), ...headers },
      body: JSON.stringify(body),
    });
  beforeEach(() => {
    restore();
    restore = installWithAuth(db).restore;
    installProviders(() => globalThis.fetch);
    db.seed("subscriptions", [{ email: SUB, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" }]);
    anthropicScript = [() => text("Germany first.")];
  });

  it("no verified identity: 401 with no counter used and no model call", async () => {
    const res = await (await route()).POST(ask({ brief: "40 MW" }, null));
    expect(res.status).toBe(401);
    expect(anthropic).toBe(0);
    expect(rl()).toHaveLength(0);
  });

  it("a forged bearer token: refused; a caller-supplied email in the body is never the credential", async () => {
    const forged = new Request(siteUrl("/api/siting-analysis"), {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ email: SUB, brief: "40 MW" }),
    });
    expect((await (await route()).POST(forged)).status).toBe(401);
    expect(anthropic).toBe(0);
  });

  it("no active subscription (none, or cancelled): 402 before the limit and before the model", async () => {
    const r = await route();
    expect((await r.POST(ask({ brief: "40 MW" }, "stranger@example.com"))).status).toBe(402);
    db.rows("subscriptions")[0].status = "cancelled";
    expect((await r.POST(ask({ brief: "40 MW" }))).status).toBe(402);
    expect(anthropic).toBe(0);
    expect(rl()).toHaveLength(0);
  });

  it("an over-long brief or body is refused before the model", async () => {
    const r = await route();
    expect((await r.POST(ask({ brief: "x".repeat(4001) }))).status).toBe(413);
    expect((await r.POST(ask({ brief: "x".repeat(20 * 1024) }))).status).toBe(413);
    expect(anthropic).toBe(0);
  });

  it("allowed: the existing contract, counted against the CUSTOMER Anthropic budget", async () => {
    const res = await (await route()).POST(ask({ brief: "40 MW, Nordics" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, analysis: "Germany first." });
    expect(anthropic).toBe(1);
    expect([hitsOf("siting"), hitsOf("siting_account"), hitsOf("anthropic_customer_caller"), hitsOf("anthropic_customer")]).toEqual([1, 1, 1, 1]);
    expect(hitsOf("anthropic_public")).toBe(0);
  });

  it("one subscriber cannot multiply the analyst budget across addresses: the verified account is limited too", async () => {
    const r = await route();
    for (let i = 0; i < RATE_POLICIES.siting_account.limit; i++) {
      expect((await r.POST(ask({ brief: "40 MW" }, SUB, { "x-forwarded-for": `198.51.100.${i + 1}` }))).status).toBe(200);
    }
    const res = await r.POST(ask({ brief: "40 MW" }, SUB, { "x-forwarded-for": "198.51.100.250" }));
    expect429(res);
    expect(anthropic).toBe(RATE_POLICIES.siting_account.limit);
    expect(JSON.stringify(rl())).not.toContain(SUB); // the account is stored only as a keyed pseudonym
  });

  it("a spent per-address limit refuses even a valid subscriber, before the model", async () => {
    exhaustRoute("siting");
    expect429(await (await route()).POST(ask({ brief: "40 MW" })));
    expect(anthropic).toBe(0);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("project procurement routes (a project is free to create, so its token is not a reason to skip the limit)", () => {
  async function project() {
    const { POST } = await import("@/app/api/projects/route");
    return (await (await POST(post("/api/projects", { project_name: "Hall A" }))).json()).project_token as string;
  }

  it("an unknown project token is 404 with no limit used and no engine call", async () => {
    const { POST } = await import("@/app/api/projects/[token]/packages/route");
    const res = await POST(post("/x", { case_token: "c", architecture: "A" }), ctx("no-such-project"));
    expect(res.status).toBe(404);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("each engine-reaching route is refused over its limit before the engine", async () => {
    const token = await project();
    exhaustRoute("project_rfq");
    const pk = await import("@/app/api/projects/[token]/packages/route");
    const rs = await import("@/app/api/projects/[token]/packages/[package]/responses/route");
    const cmp = await import("@/app/api/projects/[token]/packages/[package]/comparison/route");
    expect429(await pk.POST(post("/x", { case_token: "c", architecture: "A" }), ctx(token)));
    expect429(await rs.POST(post("/x", { supplier: "S", values: {} }), ctx(token, { package: "p" })));
    expect429(await cmp.POST(post("/x", {}), ctx(token, { package: "p" })));
    expect(engine).toHaveLength(0);
  });

  it("an oversized supplier response is refused before the engine", async () => {
    const token = await project();
    const rs = await import("@/app/api/projects/[token]/packages/[package]/responses/route");
    const res = await rs.POST(post("/x", { supplier: "S", note: "n".repeat(ENGINE_BODY_MAX_BYTES + 5) }), ctx(token, { package: "p" }));
    expect(res.status).toBe(400);
    expect(engine).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("token-addressed customer work (a purchase issued the token): its own budget, checked after the token", () => {
  const INTAKE = { siteName: "North Hall", hallId: "H1", ...HALL, floorLoadingKPa: 12, plantCapacityKW: 6000, firmCapacityMVA: 15, platform: "gb300_nvl72" };
  beforeEach(() => {
    engineAnswer = (path, body) =>
      body?.format === "html" || body?.format === "md"
        ? { status: 200, body: { format: body.format, title: "Density Screen", document: "<p>x</p>" } }
        : { status: 200, body: { scenarios: [{ id: "retained_air", as_found: { racks: 0, binding_name: "Rack feed / tap-off rating" } }] } };
  });

  it("intake: an unknown token is 404 and an over-limit caller is 429 BEFORE the engagement is claimed (its state is untouched)", async () => {
    db.seed("deliverables", [{ token: "t1", kind: "density_screen", status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1" }]);
    const { POST } = await import("@/app/api/intake/[token]/route");
    expect((await POST(post("/x", INTAKE), ctx("nope"))).status).toBe(404);
    exhaustRoute("customer_generate");
    expect429(await POST(post("/x", INTAKE), ctx("t1")));
    expect(engine).toHaveLength(0);
    expect((db.rows("deliverables")[0] as any).status).toBe("awaiting_intake");
  });

  it("intake: an invalid or oversized submission costs no allowance and reaches no engine", async () => {
    db.seed("deliverables", [{ token: "t1", kind: "density_screen", status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1" }]);
    const { POST } = await import("@/app/api/intake/[token]/route");
    expect((await POST(post("/x", { siteName: "x" }), ctx("t1"))).status).toBe(422);
    expect((await POST(post("/x", { ...INTAKE, queueNote: "q".repeat(200 * 1024) }), ctx("t1"))).status).toBe(413);
    expect(engine).toHaveLength(0);
    expect(rl()).toHaveLength(0);
  });

  it("intake: allowed, it keeps its contract and spends the CUSTOMER engine budget", async () => {
    db.seed("deliverables", [{ token: "t1", kind: "density_screen", status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1" }]);
    const { POST } = await import("@/app/api/intake/[token]/route");
    const res = await POST(post("/x", INTAKE), ctx("t1"));
    expect(res.status).toBe(200);
    expect(hitsOf("customer_generate")).toBe(1);
    expect(hitsOf("engine_customer_caller")).toBeGreaterThanOrEqual(1);
    expect(hitsOf("engine_public")).toBe(0);
  });

  it("customer and public budgets are separate: an exhausted PUBLIC aggregate does not stop a paying customer's fulfilment", async () => {
    exhaustProvider("engine:public:metered", "aggregate");
    exhaustProvider("engine:public:free", "aggregate");
    db.seed("deliverables", [{ token: "t1", kind: "density_screen", status: "awaiting_intake", company: "North Hall", stripe_session_id: "cs_1" }]);
    const { POST } = await import("@/app/api/intake/[token]/route");
    expect((await POST(post("/x", INTAKE), ctx("t1"))).status).toBe(200);
  });

  it("bid comparison: a wrong token is 404, an over-limit caller is 429; the engine is not called either way", async () => {
    db.seed("deliverables", [{ token: "doc", intake_token: "i", kind: "procurement_spec", status: "released",
      intake: { grid: { contracted_MW: 12 }, _gridforge: { spec: { constraint_id: "rack_feed_tapoff" } } }, working_files: {} }]);
    const { POST } = await import("@/app/api/deliverable/[token]/bids/route");
    const body = { responses: [{ supplier: "A", values: {} }] };
    expect((await POST(post("/x", body), ctx("nope"))).status).toBe(404);
    exhaustRoute("customer_generate");
    expect429(await POST(post("/x", body), ctx("doc")));
    expect(engine).toHaveLength(0);
  });

  it("quotation run: over limit is 429 with no engine call", async () => {
    db.seed("deliverables", [{ id: "d1", token: "doc", intake_token: "i", kind: "envelope_study_deposit", status: "released", intake: { grid: {} } }]);
    exhaustRoute("customer_generate");
    const { POST } = await import("@/app/api/deliverable/[token]/evidence-run/route");
    expect429(await POST(post("/x", {}), ctx("doc")));
    expect(engine).toHaveLength(0);
  });

  it("watch re-solve: over limit is 429 and the stored intake is unchanged", async () => {
    db.seed("watches", [{ id: "w1", token: "wt", status: "active", cadence: "quarterly", email: "a@b.example", intake: { siteName: "H" }, last_state: { racks: 1 } }]);
    exhaustRoute("customer_generate");
    const { POST } = await import("@/app/api/watch/[token]/route");
    expect429(await POST(post("/x", { ...INTAKE, transformers: [], ups: [], buswayRuns: 6, voltageV: 400 }), ctx("wt")));
    expect(engine).toHaveLength(0);
    expect((db.rows("watches")[0] as any).intake).toEqual({ siteName: "H" });
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe("production topology and trusted work", () => {
  it("in production on Vercel, an address a client prepends or another header it sets does not buy a fresh allowance", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    const { POST } = await import("@/app/api/qualify/route");
    // Vercel writes the real address as the LAST x-forwarded-for entry; everything a client sends is in front of it or in other headers.
    const as = (spoof: string) => post("/api/qualify", HALL, { "x-forwarded-for": `${spoof}, 198.51.100.5`, "x-real-ip": spoof, "x-vercel-forwarded-for": spoof });
    for (let i = 0; i < RATE_POLICIES.qualify.limit; i++) expect((await POST(as(`10.0.0.${i + 1}`))).status).toBe(200);
    expect429(await POST(as("172.16.99.99")));
    expect(engine).toHaveLength(RATE_POLICIES.qualify.limit);
  });

  it("in production with no trusted address source, nothing is served and nothing is spent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { POST } = await import("@/app/api/qualify/route");
    expect((await POST(post("/api/qualify", HALL))).status).toBe(503);
    expect(engine).toHaveLength(0);
  });

  it("in production, an operator-declared header is honoured and the store is the only counter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GRIDFORGE_TRUSTED_IP_HEADER", "fly-client-ip");
    const { POST } = await import("@/app/api/qualify/route");
    expect((await POST(post("/api/qualify", HALL, { "fly-client-ip": "198.51.100.8" }))).status).toBe(200);
    expect(hitsOf("qualify")).toBe(1);
  });

  it("scheduled work authenticated by the cron secret spends with no per-caller budget, even in production, where an unscoped call would be refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CRON_SECRET = "cron-secret-value";
    db.rows("watches"); // table exists (empty): nothing is due
    const { GET } = await import("@/app/api/cron/watches/route");
    const res = await GET(new Request(siteUrl("/api/cron/watches"), { headers: { authorization: "Bearer cron-secret-value" } }));
    expect(res.status).toBe(200);
    expect(rl()).toHaveLength(0);
    const { engineFetch } = await import("@/lib/rate-limit");
    expect((await engineFetch(`${ENGINE}/v1/diff`, { method: "POST" })).status).toBe(503); // outside any scope: refused
    expect(engine).toHaveLength(0);
  });

  it("the operator's regenerate runs trusted: no counter, and it works with the public budgets spent", async () => {
    exhaustProvider("engine:public:metered", "aggregate");
    exhaustProvider("engine:customer:metered", "aggregate");
    const { runTrusted } = await import("@/lib/spend-scope");
    const { engineFetch } = await import("@/lib/rate-limit");
    const r = await runTrusted("admin-session", () => engineFetch(`${ENGINE}/v1/study`, { method: "POST", body: "{}" }));
    expect(r.status).toBe(200);
    expect(engine).toHaveLength(1);
  });
});
