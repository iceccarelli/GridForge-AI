/**
 * Saved comparison -> buyer link -> buyer page -> checkout -> webhook, against REAL PostgreSQL through REAL PostgREST, with
 * the REAL Python engine. The in-memory fake is not involved: this is where the rate-limit counter, the append-only
 * comparison, the single active link and the purchase attachment are shown to work as one chain.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PRODUCTS } from "@/lib/products";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
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

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "buyer-realdb-key";
let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;

describe("real-database prerequisites (buyer page)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
    expect(enabled).toBe(true);
  });
  it.runIf(required && enabled)("migrations 0024 and 0025 are applied", async () => {
    for (const t of ["rate_limit_windows", "project_comparisons", "project_shares"]) {
      expect((await fetch(`${PGRST}/${t}?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } })).status, t).toBe(200);
    }
  });
});

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

/** Supabase's gateway serves PostgREST under /rest/v1; this does the same and nothing else. */
async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await fetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

const sql = async (path: string, init: RequestInit = {}) =>
  fetch(PGRST + path, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await sql(`/${table}?select=*${q}`)).json()) as any[];

const WH = "whsec_realdb_buyer_secret";
beforeAll(async () => {
  if (!enabled) return;
  process.env.GRIDFORGE_API_URL = await startEngine();
  process.env.GRIDFORGE_API_KEY = KEY;
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  delete process.env.RESEND_API_KEY;
}, 40_000);
afterAll(() => { engine?.kill(); gateway?.close(); });

const HALL = {
  siteName: "Realdb Hall", hallId: "H1", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9,
  buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
// A unique caller per test so earlier tests' counters cannot bleed into later ones on a shared database.
const post = (path: string, body: unknown, ip = `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const j = async (r: Response) => (await r.json()) as any;
const saveRoute = () => import("@/app/api/power/compare/save/route");

describe.skipIf(!enabled)("buyer page chain — real PostgreSQL via PostgREST", () => {
  it("save -> link -> page -> checkout -> webhook, then the page moves on", async () => {
    resetMemoryLimiter();
    const name = `Buyer chain ${crypto.randomUUID().slice(0, 8)}`;
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const saved = await (await saveRoute()).POST(post("/api/power/compare/save", { compare: { hall: HALL, objective: "fastest" }, project: { project_name: name, company: "Realdb Co" } }, ip));
    expect(saved.status).toBe(201);
    const s = await j(saved);
    const token = s.project_token as string;
    const [proj] = await rows("projects", `&project_token=eq.${token}`);
    expect(proj.project_name).toBe(name);
    const cmp = await rows("project_comparisons", `&project_id=eq.${proj.id}`);
    expect(cmp).toHaveLength(1);
    expect(cmp[0].request_digest).toBe(s.request_digest);
    expect(cmp[0].result.schema).toBe("gridforge/ttp-compare/1");

    // The database refuses to edit the stored answer even for the service role.
    const patch = await sql(`/project_comparisons?id=eq.${cmp[0].id}`, { method: "PATCH", body: JSON.stringify({ grade: "screening" }) });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    expect((await rows("project_comparisons", `&id=eq.${cmp[0].id}`))[0].grade).toBe(cmp[0].grade);

    const share = await (await import("@/app/api/projects/[token]/share/route")).POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
    expect(share.status).toBe(201);
    const link = ((await j(share)).share_path as string).replace("/p/", "");

    const shares = await rows("project_shares", `&project_id=eq.${proj.id}`);
    expect(shares).toHaveLength(1);
    expect(JSON.stringify(shares)).not.toContain(link);
    expect(shares[0].token_hash).toBe(crypto.createHash("sha256").update(link).digest("hex"));

    const pageMod = await import("@/app/p/[shareToken]/page");
    const html = renderToStaticMarkup(await pageMod.default({ params: Promise.resolve({ shareToken: link }) }));
    expect(html).toContain(name);
    expect(html).toContain("Decision");
    expect(html).not.toContain(token);

    // Checkout from the link, at the catalogue price, tied to the project's id.
    const checkout = (await import("@/app/api/checkout/route")).POST;
    created.length = 0;
    const co = await checkout(post("/api/checkout", { product: "density_screen", project_share_token: link }));
    expect(co.status).toBe(200);
    expect(created[0].line_items[0].price_data.unit_amount).toBe(PRODUCTS.density_screen.amountCents);
    expect(created[0].metadata.project_id).toBe(proj.id);
    expect(JSON.stringify(created[0])).not.toContain(link);

    // The webhook is the authoritative payment event: it opens the deliverable and attaches it, once, on redelivery too.
    const stripe = new Stripe("sk_test_placeholder");
    const sessionId = `cs_realdb_${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      id: `evt_${sessionId}`, type: "checkout.session.completed",
      data: { object: paidSession({ id: sessionId, customer_email: "cfo@realdb.example", amount_total: PRODUCTS.density_screen.amountCents, customer: "cus_1", metadata: created[0].metadata }) },
    });
    const hook = (await import("@/app/api/stripe/webhook/route")).POST;
    const deliver = () => hook(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }), "content-type": "application/json" }, body: payload }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await deliver()).status).toBe(200);
    expect((await deliver()).status).toBe(200);
    const attached = (await rows("project_events", `&project_id=eq.${proj.id}&event_type=eq.paid_product_attached`));
    expect(attached).toHaveLength(1);
    const html2 = renderToStaticMarkup(await pageMod.default({ params: Promise.resolve({ shareToken: link }) }));
    expect(html2).toContain("Already commissioned for this project: Density Screen");

    // Revoking closes the page and the checkout.
    await (await import("@/app/api/projects/[token]/share/route")).DELETE(new Request(siteUrl("/x"), { method: "DELETE" }), ctx(token));
    await expect(pageMod.default({ params: Promise.resolve({ shareToken: link }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    created.length = 0;
    expect((await checkout(post("/api/checkout", { product: "density_screen", project_share_token: link }))).status).toBe(404);
    expect(created).toHaveLength(0);
    vi.restoreAllMocks();

    // Privacy: the counter holds an HMAC of the caller, never the address.
    const windows = await rows("rate_limit_windows");
    expect(JSON.stringify(windows)).not.toContain(ip);
    for (const w of windows) expect(w.subject).toMatch(/^[0-9a-f]{64}$/);
  });

  it("racing saves of one question store exactly one comparison", async () => {
    const mk = await (await saveRoute()).POST(post("/api/power/compare/save", { compare: { hall: HALL }, project: { project_name: `Race ${crypto.randomUUID().slice(0, 6)}` } }));
    const token = (await j(mk)).project_token as string;
    const same = { compare: { hall: { ...HALL, contractedMW: 9 } }, project: { project_token: token } };
    const results = await Promise.all(Array.from({ length: 8 }, () => saveRoute().then((m) => m.POST(post("/api/power/compare/save", same)))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const [proj] = await rows("projects", `&project_token=eq.${token}`);
    expect(await rows("project_comparisons", `&project_id=eq.${proj.id}`)).toHaveLength(2);
    expect(await rows("project_events", `&project_id=eq.${proj.id}&event_type=eq.comparison_saved`)).toHaveLength(2);
  });

  it("the real counter refuses a caller over its allowance before the engine is called", async () => {
    const ip = `192.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < RATE_POLICIES.ttp_compare_save.limit + 2; i++) {
      statuses.push((await (await saveRoute()).POST(post("/api/power/compare/save", { compare: { hall: HALL }, project: { project_name: `Limited ${i}` } }, ip))).status);
    }
    expect(statuses.slice(0, RATE_POLICIES.ttp_compare_save.limit).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });

  it("concurrent issues of the buyer link leave one active link", async () => {
    const mk = await (await saveRoute()).POST(post("/api/power/compare/save", { compare: { hall: HALL }, project: { project_name: `Links ${crypto.randomUUID().slice(0, 6)}` } }));
    const token = (await j(mk)).project_token as string;
    const route = await import("@/app/api/projects/[token]/share/route");
    const rs = await Promise.all(Array.from({ length: 8 }, () => route.POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token))));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const [proj] = await rows("projects", `&project_token=eq.${token}`);
    const all = await rows("project_shares", `&project_id=eq.${proj.id}`);
    expect(all).toHaveLength(8);
    expect(all.filter((r) => !r.revoked_at)).toHaveLength(1);
  });
});
