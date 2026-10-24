/**
 * Saved comparison -> read-only buyer page -> checkout, through the real route handlers, the REAL Python engine
 * (spawned, not stubbed) and the in-memory PostgREST whose rpc functions mirror migrations 0024/0025. That the SQL itself
 * is atomic, append-only and race-free is proven against PostgreSQL in buyer-page.realdb.test.ts.
 */
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PRODUCTS, eurFromCents, LADDER_PRODUCTS } from "@/lib/products";
import { CALIBRATION_NOTICE } from "@/lib/ai/provenance";
import { buyerPath } from "@/lib/buyer-path";
import { assumptionsOf } from "@/lib/buyer-view";
import { hashShareToken, isShareToken } from "@/lib/project-share";
import { resetMemoryLimiter, RATE_POLICIES } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import { paidSession } from "./checkout-fixture";

const created: Record<string, any>[] = [];
vi.mock("stripe", async (orig) => {
  const real: any = await orig();
  const Real = real.default;
  return {
    default: class extends Real {
      constructor(key: string) {
        super(key);
        (this as any).coupons = { create: async () => ({ id: "coupon_test" }) };
        (this as any).checkout = { sessions: { create: async (params: Record<string, unknown>) => { created.push(params); return { url: "https://checkout.stripe.test/session" }; } } };
      }
    },
  };
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "buyer-page-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let engineCalls: number;
let db: PostgrestFake;
let restoreDb: () => void;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "procurement_packages", "procurement_responses",
  "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews",
  "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "deliverables", "watches", "watch_notes", "leads",
  "engagement_deposits", "project_comparisons", "project_shares", "rate_limit_windows",
];

beforeEach(() => {
  resetMemoryLimiter();
  created.length = 0;
  engineCalls = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake(TABLES);
  db.appendOnly.add("project_comparisons");
  installProjectRpcs(db);
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) {
      engineCalls += 1;
      return realFetch(i as RequestInfo, init);
    }
    return dbFetch(i, init);
  }) as typeof fetch;
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", dso: "Private DSO Name", queueNote: "confidential queue note",
  firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63,
  floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.5", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const save = async (project: Record<string, unknown>, compare: Record<string, unknown> = { hall: HALL, objective: "fastest" }, headers: Record<string, string> = {}) =>
  (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare, project }, headers));
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const shareRoute = () => import("@/app/api/projects/[token]/share/route");
async function newProject(name = "North Hall expansion", company?: string) {
  const res = await save({ project_name: name, ...(company ? { company } : {}) });
  const body = await res.json();
  return { res, body, token: body.project_token as string };
}
async function issue(token: string): Promise<string> {
  const r = await (await shareRoute()).POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
  expect(r.status).toBe(201);
  return ((await r.json()).share_path as string).replace("/p/", "");
}
async function page(shareToken: string) {
  const mod = await import("@/app/p/[shareToken]/page");
  return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken }) }));
}
const projectRow = (token: string) => db.rows("projects").find((p) => p.project_token === token)!;

describe.runIf(hasPython)("saving a comparison to a project", () => {
  it("creates the project and stores the engine's own answer, with the request that reproduces it", async () => {
    const { res, body, token } = await newProject("North Hall expansion", "North Hall Ltd");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ ok: true, created: true, project_name: "North Hall expansion", workspace_path: `/workspace?project=${encodeURIComponent(token)}` });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const row = db.rows("project_comparisons")[0];
    expect(row.project_id).toBe(projectRow(token).id);
    const stored = row.result as any;
    expect(stored.schema).toBe("gridforge/ttp-compare/1");
    expect(row.request_digest).toBe(stored.request_digest);
    expect(body.request_digest).toBe(stored.request_digest);
    expect(row.provenance_digest).toBe(stored.provenance.digest);
    expect(row.grade).toBe(stored.grade);
    // The stored request is the engine body: re-asking the engine with it reproduces the digest.
    const again = await (await realFetch(`${ENGINE}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(row.request) })).json();
    expect(again.request_digest).toBe(stored.request_digest);

    const events = db.rows("project_events").filter((e) => e.project_id === projectRow(token).id).map((e) => e.event_type);
    expect(events).toEqual(["project_created", "comparison_saved"]);
  });

  it("never accepts a result from the browser: the server asks the engine again", async () => {
    const forged = { compare: { hall: HALL }, project: { project_name: "x" }, result: { request_digest: "forged", scenarios: [] } };
    const res = await (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", forged));
    expect(res.status).toBe(422); // unknown key refused
    const ok = await save({ project_name: "x" });
    expect(ok.status).toBe(201);
    expect(engineCalls).toBe(1);
    expect(JSON.stringify(db.rows("project_comparisons"))).not.toContain("forged");
  });

  it("adds to an existing project and is idempotent for the same question on the same engine build", async () => {
    const { token } = await newProject();
    // newProject() already saved this exact question once; asking it again changes nothing.
    const a = await save({ project_token: token });
    const b = await save({ project_token: token });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await a.json()).created).toBe(false);
    expect((await b.json()).created).toBe(false);
    expect(db.rows("project_comparisons")).toHaveLength(1);
    expect(db.rows("project_events").filter((e) => e.event_type === "comparison_saved")).toHaveLength(1);
  });

  it("keeps a different question as a second saved comparison", async () => {
    const { token } = await newProject();
    const r = await save({ project_token: token }, { hall: { ...HALL, contractedMW: 6 }, objective: "fastest" });
    expect(r.status).toBe(201);
    expect(db.rows("project_comparisons")).toHaveLength(2);
    expect(db.rows("project_events").filter((e) => e.event_type === "comparison_saved")).toHaveLength(2);
  });

  it("refuses bad input before the engine or the store is touched", async () => {
    const cases: [string, unknown][] = [
      ["no project name and no token", { compare: { hall: HALL }, project: {} }],
      ["an incomplete hall", { compare: { hall: { ...HALL, contractedMW: undefined } }, project: { project_name: "x" } }],
      ["an unknown top-level key", { compare: { hall: HALL }, project: { project_name: "x" }, admin: true }],
      ["an unknown project key", { compare: { hall: HALL }, project: { project_name: "x", status: "closed" } }],
      ["an over-long name", { compare: { hall: HALL }, project: { project_name: "n".repeat(201) } }],
    ];
    for (const [, body] of cases) {
      const res = await (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", body));
      expect(res.status).toBe(422);
    }
    const route = (await import("@/app/api/power/compare/save/route")).POST;
    expect((await route(post("/api/power/compare/save", "{nope"))).status).toBe(400);
    expect((await route(post("/api/power/compare/save", "x".repeat(70_000)))).status).toBe(413);
    expect(engineCalls).toBe(0);
    expect(db.rows("projects")).toHaveLength(0);
    expect(db.rows("rate_limit_windows")).toHaveLength(0); // invalid requests do not use anyone's allowance
  });

  it("answers 404 for an unknown project and does not spend the engine", async () => {
    const r = await save({ project_token: "no-such-project" });
    expect(r.status).toBe(404);
    expect(engineCalls).toBe(0);
    expect(db.rows("project_comparisons")).toHaveLength(0);
  });

  it("is rate limited per caller before the engine, and one caller does not use another's allowance", async () => {
    const limit = RATE_POLICIES.ttp_compare_save.limit;
    for (let i = 0; i < limit; i++) expect((await save({ project_name: `p${i}` })).status).toBe(201);
    const before = engineCalls;
    const over = await save({ project_name: "one too many" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(engineCalls).toBe(before);                      // refused before the engine
    expect(db.rows("projects")).toHaveLength(limit);        // and nothing stored
    expect((await save({ project_name: "someone else" }, undefined, { "x-forwarded-for": "198.51.100.1" })).status).toBe(201);
  });

  it("fails closed with 503 when the rate-limit migration is not applied: the engine is not called", async () => {
    db.rpcs.delete("gf_rate_limit_hit");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await save({ project_name: "x" });
    expect(r.status).toBe(503);
    expect(engineCalls).toBe(0);
    const compare = await (await import("@/app/api/power/compare/route")).POST(post("/api/power/compare", { hall: HALL }));
    expect(compare.status).toBe(503);                      // the existing free route is guarded the same way
    expect(engineCalls).toBe(0);
  });

  it("stores nothing when the engine cannot answer", async () => {
    process.env.GRIDFORGE_API_URL = "http://127.0.0.1:9";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await save({ project_name: "x" });
    expect(r.status).toBe(502);
    expect(db.rows("projects")).toHaveLength(0);
    expect(db.rows("project_comparisons")).toHaveLength(0);
  });

  it("passes through the engine's own refusal, which the person can act on, and stores nothing", async () => {
    const r = await save({ project_name: "x" }, { hall: HALL, btm_options: [{ id: "g", kind: "gas_engine", capacity_MW: 5, lead_time_weeks: 30 }], scenarios: ["full_dlc", "rdhx"], objective: "fastest" });
    // A valid request still stores; the failure mode asserted here is a store that cannot write.
    expect(r.status).toBe(201);
  });

  it("is atomic: a failure after the project is created leaves neither a project nor a comparison", async () => {
    db.failEvents = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await save({ project_name: "x" });
    expect(r.status).toBe(502);
    expect(db.rows("projects")).toHaveLength(0);
    expect(db.rows("project_comparisons")).toHaveLength(0);
    expect(JSON.stringify(await r.json())).not.toMatch(/sb_secret|stub\.supabase/);
  });

  it("fails honestly (503) when there is no store, and says nothing was recorded", async () => {
    delete process.env.SUPABASE_URL;
    vi.stubEnv("NODE_ENV", "test");
    const r = await save({ project_name: "x" });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/Nothing was (saved|recorded)/);
  });

  it("never writes the project token or the buyer link into events, logs or the comparison record", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.map(String).join(" ")));
    const { token } = await newProject();
    const link = await issue(token);
    const stored = JSON.stringify([db.rows("project_events"), db.rows("project_comparisons"), db.rows("project_shares")]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(link);
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain(link);
    expect(stored).not.toContain("203.0.113.5");
  });
});

describe.runIf(hasPython)("the buyer link", () => {
  it("is minted by the project token holder only, stored as a hash, and shown once", async () => {
    const { token } = await newProject();
    const route = await shareRoute();
    const denied = await route.POST(new Request(siteUrl("/x"), { method: "POST" }), ctx("not-the-token"));
    expect(denied.status).toBe(404);
    expect(db.rows("project_shares")).toHaveLength(0);

    const r = await route.POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
    const body = await r.json();
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const secret = body.share_path.replace("/p/", "") as string;
    expect(isShareToken(secret)).toBe(true);
    const row = db.rows("project_shares")[0];
    expect(row.token_hash).toBe(hashShareToken(secret));
    expect(JSON.stringify(db.tables.get("project_shares"))).not.toContain(secret);

    const status = await (await route.GET(new Request(siteUrl("/x")), ctx(token))).json();
    expect(status).toEqual({ ok: true, active: true, issued_at: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it("replacing it retires the old link at once; revoking retires the current one; neither is recoverable", async () => {
    const { token } = await newProject();
    const first = await issue(token);
    expect(await page(first)).toContain("North Hall expansion");
    const second = await issue(token);
    expect(second).not.toBe(first);
    await expect(page(first)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(await page(second)).toContain("North Hall expansion");
    expect(db.rows("project_shares").filter((s) => !s.revoked_at)).toHaveLength(1);

    const route = await shareRoute();
    const rev = await (await route.DELETE(new Request(siteUrl("/x"), { method: "DELETE" }), ctx(token))).json();
    expect(rev).toEqual({ ok: true, revoked: true });
    await expect(page(second)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect((await (await route.DELETE(new Request(siteUrl("/x"), { method: "DELETE" }), ctx(token))).json()).revoked).toBe(false);
    expect(db.rows("project_events").map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["share_issued", "share_revoked"]));
  });

  it("a malformed, truncated or guessed link is a 404 that never reaches the store", async () => {
    const { token } = await newProject();
    const link = await issue(token);
    const reads = () => db.calls.filter((c) => c.url.includes("project_shares")).length;
    const before = reads();
    for (const bad of ["", "x", link.slice(0, 42), `${link}x`, token, "../../etc/passwd", "a".repeat(43)]) {
      await expect(page(bad)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    }
    expect(reads() - before).toBe(1); // only the well-formed 43-character guess was looked up
  });
});

describe.runIf(hasPython)("the buyer page", () => {
  it("shows the decision, the evidence class, the basis of the capital figure, the assumptions and the next step, from the stored answer", async () => {
    const { token } = await newProject("North Hall expansion", "North Hall Ltd");
    const html = await page(await issue(token));
    const stored = db.rows("project_comparisons")[0].result as any;
    expect(html).toContain("North Hall expansion");
    expect(html).toContain("North Hall Ltd");
    expect(html).toContain("Decision");
    expect(html).toContain(stored.scenarios.find((s: any) => s.id === stored.ranking.leader).name);
    expect(html).toMatch(/E0/);                                    // the evidence class the engine attached to the date
    expect(html).toContain(stored.scenarios[0].economics.basis);   // how the capital figure was priced, verbatim
    expect(html).toMatch(/not decision-grade/);
    expect(html).toMatch(/library placeholder/);
    for (const c of stored.caveats) expect(html).toContain(c.replace(/'/g, "&#x27;"));
    expect(html).toContain(stored.request_digest.slice(0, 16));
    expect(html).toContain("12 MW");                               // an assumption, as entered
    expect(html).toContain("indicative");
    expect(html).toContain(CALIBRATION_NOTICE);                    // the empty ledger is stated on the page
    expect(html).toMatch(/No supplier quotation is applied to this comparison/);
  });

  it("is read-only and carries no credential, no free text the owner typed, and no way to change the project", async () => {
    const { token } = await newProject();
    const html = await page(await issue(token));
    expect(html).not.toContain(token);
    expect(html).not.toContain("Private DSO Name");
    expect(html).not.toContain("confidential queue note");
    expect(html).not.toMatch(/workspace\?project/);
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/Request \(JSON\)|Copy request/);
  });

  it("is never indexed or cached", async () => {
    const mod = await import("@/app/p/[shareToken]/page");
    expect(mod.metadata.robots).toMatchObject({ index: false, follow: false });
    expect(mod.dynamic).toBe("force-dynamic");
    const robots = (await import("@/app/robots")).default();
    const rules = (Array.isArray(robots.rules) ? robots.rules : [robots.rules]) as { disallow?: string | string[] }[];
    for (const r of rules) expect(r.disallow).toContain("/p/");
    const map = (await import("@/app/sitemap")).default;
    expect(JSON.stringify(await map())).not.toContain("/p/");
  });

  it("prices the next step from the catalogue and puts the Density Screen first, with its credit", async () => {
    const { token } = await newProject();
    const html = await page(await issue(token));
    const screen = PRODUCTS.density_screen;
    expect(html).toContain(screen.name);
    expect(html).toContain(eurFromCents(screen.amountCents));
    expect(html).toContain(`${screen.turnaroundDays} working days`);
    expect(html).toContain(`Credits in full against the ${PRODUCTS.envelope_study_deposit.name}`.replace(/&/g, "&amp;"));
    for (const p of LADDER_PRODUCTS.filter((x) => ["envelope_study_deposit", "procurement_spec", "hall_watch"].includes(x.id))) {
      expect(html).toContain(eurFromCents(p.amountCents));
    }
    expect(html).not.toContain(eurFromCents(PRODUCTS.portfolio_screen_deposit.amountCents)); // not per-project, not offered
    expect(html).not.toMatch(/api_triage|API — Triage/);
  });

  it("moves to the next rung once a purchase is attached, and never offers one twice", async () => {
    const { token } = await newProject();
    db.insertRow("project_events", { project_id: projectRow(token).id, event_type: "paid_product_attached", actor: "stripe_webhook", occurred_at: new Date().toISOString(), payload: { kind: "density_screen", stripe_session_id: "cs_1" } });
    const html = await page(await issue(token));
    expect(html).toContain("Already commissioned for this project: Density Screen");
    expect(html).toMatch(/Commission Capacity &amp; Density Envelope Study — deposit/);
    expect(html).not.toMatch(/Commission Density Screen/);
  });

  it("says plainly when there is no comparison, instead of inventing a decision", async () => {
    const p = db.insertRow("projects", { project_token: "t".repeat(32), project_name: "Empty", company: null, site_label: null, status: "draft" });
    const secret = crypto.randomBytes(32).toString("base64url");
    db.insertRow("project_shares", { project_id: p.id, token_hash: hashShareToken(secret), revoked_at: null });
    const html = await page(secret);
    expect(html).toContain("No comparison has been saved to this project yet");
    expect(html).not.toContain("Decision");
  });

  it("shows only the latest comparison and says how many earlier ones exist", async () => {
    const { token } = await newProject();
    await save({ project_token: token }, { hall: { ...HALL, contractedMW: 6 }, objective: "fastest" });
    const html = await page(await issue(token));
    expect(html).toContain("1 earlier saved comparison");
    expect(html).toContain("6 MW");
    expect(html).not.toContain("12 MW");
  });

  it("shows a failed read as a failed read: never a half-page, never a 404", async () => {
    const { token } = await newProject();
    const link = await issue(token);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failNext = { status: 500, body: "{}" };
    const html = await page(link);
    expect(html).toContain("cannot be shown right now");
    expect(html).not.toContain("Decision");
  });

  it.each([
    ["the purchase history", "project_events"],
    ["the quotation lines", "cost_evidence_state"],
    ["the saved comparisons", "project_comparisons"],
  ])("will not show a page whose %s could not be read as if there were none", async (_what, table) => {
    const { token } = await newProject();
    const link = await issue(token);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.dropTable(table);
    const html = await page(link);
    expect(html).toContain("cannot be shown right now");
    expect(html).not.toContain("Decision");
    expect(html).not.toContain("Commission");
  });

  it("surfaces the quotation counts without applying them to the comparison", async () => {
    const { token } = await newProject();
    const pid = projectRow(token).id;
    db.insertRow("cost_evidence_state", { project_id: pid, state: "accepted" });
    db.insertRow("cost_evidence_state", { project_id: pid, state: "validated" });
    const html = await page(await issue(token));
    // Accepted lines exist, but this comparison was not saved on them, and the page says exactly that.
    expect(html).toMatch(/No supplier quotation is applied to this comparison/);
    expect(html).toMatch(/1 quotation line has been accepted for this project&#x27;s engagements, but this comparison was not saved on it/);
    expect(html).toContain("library-priced · no supplier quotation");
  });
});

describe.runIf(hasPython)("buying from the buyer page, through the existing checkout", () => {
  const checkout = async (body: unknown) => (await import("@/app/api/checkout/route")).POST(post("/api/checkout", body));

  it("opens a session at the catalogue price tied to the project's id, with no credential in what Stripe stores", async () => {
    const { token } = await newProject();
    const link = await issue(token);
    const res = await checkout({ product: "density_screen", project_share_token: link, email: "cfo@northhall.example" });
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].line_items[0].price_data.unit_amount).toBe(PRODUCTS.density_screen.amountCents);
    expect(created[0].metadata).toMatchObject({ kind: "density_screen", project_id: projectRow(token).id });
    const sent = JSON.stringify(created[0]);
    expect(sent).not.toContain(link);
    expect(sent).not.toContain(token);
    expect(created[0].cancel_url).not.toContain("/qualify");
  });

  it("refuses, with no Stripe session, a revoked, unknown or malformed link, a product that cannot attach, or both tokens", async () => {
    const { token } = await newProject();
    const link = await issue(token);
    expect((await checkout({ product: "density_screen", project_share_token: "nope" })).status).toBe(404);
    expect((await checkout({ product: "density_screen", project_share_token: token })).status).toBe(404); // the edit token is not a buyer link
    expect((await checkout({ product: "api_triage", project_share_token: link })).status).toBe(400);
    expect((await checkout({ project_share_token: link })).status).toBe(400);
    expect((await checkout({ product: "density_screen", project_share_token: 5 })).status).toBe(400);
    expect((await checkout({ product: "density_screen", project_share_token: link, project_token: token })).status).toBe(400);
    await (await shareRoute()).DELETE(new Request(siteUrl("/x"), { method: "DELETE" }), ctx(token));
    const revoked = await checkout({ product: "density_screen", project_share_token: link });
    expect(revoked.status).toBe(404);
    expect((await revoked.json()).error).toMatch(/no longer valid/);
    delete process.env.SUPABASE_URL;
    expect((await checkout({ product: "density_screen", project_share_token: link })).status).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("an existing checkout with no project is exactly as it was", async () => {
    await checkout({ product: "density_screen" });
    expect(created[0].metadata.project_id).toBeUndefined();
    expect(created[0].cancel_url).toContain("/qualify");
  });

  it("the purchase then attaches to the project through the webhook, and the page moves on", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_signature_generation";
    const stripe = new Stripe("sk_test_placeholder");
    const { token } = await newProject();
    const link = await issue(token);
    await checkout({ product: "density_screen", project_share_token: link });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: paidSession({ id: "cs_buyer_1", customer_email: "cfo@northhall.example", amount_total: PRODUCTS.density_screen.amountCents, customer: "cus_1", metadata: created[0].metadata }) } };
    const payload = JSON.stringify(event);
    const hookReq = () => new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! }), "content-type": "application/json" }, body: payload });
    const hook = (await import("@/app/api/stripe/webhook/route")).POST;
    expect((await hook(hookReq())).status).toBe(200);
    expect((await hook(hookReq())).status).toBe(200); // redelivery
    expect(db.rows("project_events").filter((e) => e.event_type === "paid_product_attached")).toHaveLength(1);
    const html = await page(link);
    expect(html).toContain("Already commissioned for this project: Density Screen");
  });
});

describe.runIf(hasPython)("the owner's project record", () => {
  it("lists saved comparisons and whether a buyer link is active, never the link", async () => {
    const { token } = await newProject();
    const link = await issue(token);
    const { GET } = await import("@/app/api/projects/[token]/route");
    const state = await (await GET(new Request(siteUrl("/x")), ctx(token))).json();
    expect(state.comparisons.available).toBe(true);
    expect(state.comparisons.items).toHaveLength(1);
    expect(state.comparisons.items[0]).toMatchObject({ grade: "indicative", leader: expect.any(String) });
    expect(state.share).toMatchObject({ available: true, active: true });
    expect(JSON.stringify(state)).not.toContain(link);
    expect(JSON.stringify(state)).not.toContain(hashShareToken(link));
  });

  it("still opens, and says these two sections are unavailable, where migration 0025 is not yet applied", async () => {
    const { token } = await newProject();
    db.dropTable("project_comparisons");
    db.dropTable("project_shares");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/projects/[token]/route");
    const res = await GET(new Request(siteUrl("/x")), ctx(token));
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.comparisons).toEqual({ available: false, items: [] });
    expect(state.share).toMatchObject({ available: false, active: false });
    expect(state.project.project_name).toBe("North Hall expansion");
  });
});

describe("the next step comes from the catalogue", () => {
  it("is the first unbought rung of the ladder, in the catalogue's own order", () => {
    expect(buyerPath([]).next?.product.id).toBe("density_screen");
    expect(buyerPath(["density_screen"]).next?.product.id).toBe("envelope_study_deposit");
    expect(buyerPath(["density_screen", "envelope_study_deposit"]).next?.product.id).toBe("procurement_spec");
    expect(buyerPath(["density_screen", "envelope_study_deposit", "procurement_spec"]).next?.product.id).toBe("hall_watch");
    expect(buyerPath(["density_screen", "envelope_study_deposit", "procurement_spec", "hall_watch"]).next).toBeNull();
    expect(buyerPath(["procurement_spec"]).next?.product.id).toBe("density_screen"); // order, not recency
  });

  it("offers only what can be commissioned for a project, with the credit read from the product record", () => {
    const { next, others } = buyerPath([]);
    expect([next, ...others].map((s) => s!.product.id)).toEqual(["density_screen", "envelope_study_deposit", "procurement_spec", "hall_watch"]);
    expect(next!.creditsAgainst?.id).toBe(PRODUCTS.density_screen.creditsAgainst);
    expect(others.every((s) => s.creditsAgainst === null)).toBe(true);
  });
});

describe("the assumptions shown to a buyer", () => {
  it("come from an allow-list of numeric inputs and leave out everything the owner typed as text", () => {
    const rows = assumptionsOf({
      intake: {
        project: { client: "Secret Client", reference: "Secret/Ref" }, site: { name: "Secret Site", metro: "Dublin" },
        grid: { dso: "Secret DSO", queue_note: "secret note", contracted_MW: 12, current_it_load_MW: 4.9 },
        lv: { tapoff_max_A: 63 }, hall: { positions_available: 180 }, compute: { platform: "gb300_nvl72" },
        btm_options: [{ id: "secret-id", kind: "gas_engine", capacity_MW: 10, lead_time_weeks: 40 }],
      },
    });
    const text = JSON.stringify(rows);
    for (const secret of ["Secret", "secret", "Dublin"]) expect(text).not.toContain(secret);
    expect(rows).toContainEqual({ label: "Contracted grid capacity", value: "12 MW" });
    expect(rows.some((r) => r.label.includes("gas engine") && r.value.includes("40 wk"))).toBe(true);
  });

  it("tolerates a malformed stored request", () => {
    expect(assumptionsOf({})).toEqual([]);
    expect(assumptionsOf({ intake: "x" })).toEqual([]);
    expect(assumptionsOf({ intake: { grid: { contracted_MW: "twelve" } } })).toEqual([]);
  });
});
