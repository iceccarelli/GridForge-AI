/**
 * The two ends of the human review step of a paid deliverable (Density Screen, Procurement Spec).
 *
 *   intake -> the engine writes a DRAFT -> [a person reviews and releases] -> the buyer reads it
 *
 * Both ends used to be silent: nobody was told a draft was waiting, and releasing it sent the buyer
 * nothing, although the intake page promises "You will get the link once it is released". A paid
 * document could sit unreleased, or be released and never reach the person who paid.
 *
 * FAKE-BACKED store; the engine is the REAL Python engine; email is intercepted (Resend is not contacted).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const WH = "whsec_delivery_handoff_secret";
const ENGINE_KEY = "delivery-handoff-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let undo: () => void;
let mail: { to: string[] | string; subject: string; text: string }[];
const realFetch = globalThis.fetch;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${ENGINE_KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
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

beforeEach(() => {
  mail = [];
  jar.length = 0;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = ENGINE_KEY;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  db = new PostgrestFake(["deliverables", "leads", "qualifications"]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) { mail.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }
    if (ENGINE && url.startsWith(ENGINE)) return realFetch(i as RequestInfo, init);
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => undo());

const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const json = (b: unknown, method = "POST") => new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const stripe = new Stripe("sk_test_placeholder");
async function buy(email = "buyer@hall.example") {
  const payload = JSON.stringify({ id: "evt_ds", type: "checkout.session.completed", data: { object: {
    id: "cs_ds_1", object: "checkout_session", customer_email: email, customer: "cus_1", amount_total: 450_000, metadata: { kind: "density_screen", company: "Hall Co" } } } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
  return db.rows("deliverables")[0] as any;
}
const submit = async (d: any) => (await import("@/app/api/intake/[token]/route")).POST(json(INTAKE), ctx(d.intake_token));
const signIn = () => jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
const release = async (d: any) => (await import("@/app/api/admin/deliverables/route")).PATCH(json({ token: d.token }, "PATCH"));
const to = (m: { to: string[] | string }) => ([] as string[]).concat(m.to).join(",");

describe.runIf(hasPython)("a draft waiting for review is announced to the operator", () => {
  it("a generated draft tells the operator what is waiting and where to review it", async () => {
    const d = await buy();
    mail.length = 0;
    expect((await submit(d)).status).toBe(200);
    const notice = mail.filter((m) => to(m).includes("ops@example.test"));
    expect(notice).toHaveLength(1);
    expect(notice[0].subject).toMatch(/draft/i);
    expect(notice[0].text).toContain("/admin/pipeline");
    expect(notice[0].text).toContain("buyer@hall.example");
    expect(JSON.stringify(mail)).not.toContain(d.token);        // the document token is never put in an email
  });

  it("an engine failure is announced too (the customer was told 'we will pick this up')", async () => {
    const d = await buy();
    mail.length = 0;
    process.env.GRIDFORGE_API_URL = "http://127.0.0.1:1";        // nothing listens here
    const r = await submit(d);
    expect(r.status).toBeGreaterThanOrEqual(500);
    const notice = mail.filter((m) => to(m).includes("ops@example.test"));
    expect(notice).toHaveLength(1);
    expect(notice[0].subject).toMatch(/engine|could not/i);
  });
});

describe.runIf(hasPython)("releasing a document reaches the person who paid", () => {
  it("emails the buyer their private link once, and tells the operator it was sent", async () => {
    const d = await buy();
    await submit(d);
    signIn();
    mail.length = 0;
    const res = await release(d);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ ok: true, status: "released", customer_notified: true });
    const sent = mail.filter((m) => to(m).includes("buyer@hall.example"));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`/deliverable/${d.token}`);
    expect(sent[0].text).not.toContain(d.intake_token);

    // releasing again (an idempotent click) must not email the buyer a second time
    mail.length = 0;
    expect(((await (await release(d)).json()) as any).customer_notified).toBe(false);
    expect(mail.filter((m) => to(m).includes("buyer@hall.example"))).toHaveLength(0);
  });

  it("when the buyer cannot be emailed the release says so and hands the operator the link — it never pretends", async () => {
    const d = await buy();
    await submit(d);
    signIn();
    delete process.env.RESEND_API_KEY;
    const body: any = await (await release(d)).json();
    expect(body.status).toBe("released");
    expect(body.customer_notified).toBe(false);
    expect(body.notify_error).toMatch(/not configured|email/i);
    expect(body.link).toContain(`/deliverable/${d.token}`);       // the operator can send it by hand
  });

  it("a buyer with no email on record is told apart from a failed send", async () => {
    const d = await buy("");
    await submit(d).catch(() => null);
    signIn();
    const row = db.rows("deliverables")[0] as any;
    row.status = "draft"; row.document_html = row.document_html || "<p>doc</p>";
    const body: any = await (await release(row)).json();
    expect(body.customer_notified).toBe(false);
    expect(body.notify_error).toMatch(/no email/i);
    expect(body.link).toContain("/deliverable/");
  });
});
