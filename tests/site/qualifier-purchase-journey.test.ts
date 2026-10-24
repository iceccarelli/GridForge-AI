/**
 * The journey that makes money, end to end, in one process: qualifier -> result page CTA -> Density Screen checkout -> paid webhook
 * -> intake. Every hop is the real route handler or the real server component; only the three outside services are faked
 * (the engine's /v1/qualify answer, Stripe's session creation, and the email provider), and the store is the in-memory PostgREST
 * fake with the migrations' unique keys.
 *
 * What this proves that the neighbouring files do not: they each test ONE hop with a hand-written input. Here the output of each hop
 * is the input of the next, so a field one hop stops producing, or the next stops reading, breaks the chain. The same chain runs against the REAL
 * engine, a production build and a PostgREST stand-in in `npm run verify:local` (tests/e2e/verify-stack.mjs); what neither can prove
 * is Stripe's own hosted page, a real card, or a real inbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { checkoutEvent, omitPaymentStatus, paidSession, unpaidSession } from "./checkout-fixture";

const created: { id: string; params: Record<string, any> }[] = [];

// Only session creation is faked; webhook signature verification stays the SDK's own.
vi.mock("stripe", async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeStripe extends actual.default {
    constructor(key: string, ...rest: unknown[]) {
      super(key, ...rest);
      (this as any).checkout = {
        sessions: {
          create: async (params: Record<string, any>) => {
            const id = `cs_test_journey_${created.length + 1}`;
            created.push({ id, params });
            return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
          },
        },
      };
      (this as any).coupons = { create: async () => ({ id: "coupon_test" }) };
    }
  }
  return { ...actual, default: FakeStripe };
});

const WH = "whsec_journey_secret_for_signature_generation";
const ENGINE = "http://engine.test";
const HALL = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", country: "Ireland", platform: "gb300_nvl72",
  contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, plantSupplyC: 6, positionsAvailable: 180,
  name: "Pat Ops", company: "North Hall Ltd", email: "ops@northhall.example",
};
const OTHER_HALL = {
  ...HALL, siteName: "Other Hall", hallId: "B1", metro: "Cork", contractedMW: 20, currentPeakMW: 11, currentItLoadMW: 8.5,
  buswayAmpacityA: 630, tapoffMaxA: 125, positionsAvailable: 240, plantSupplyC: 8, name: "Sam Other", company: "Other Grid", email: "sam@othergrid.example",
};

type Mail = { to: string[]; subject: string; text: string };
let db: PostgrestFake;
let undo: () => void;
let mail: Mail[];
let engineUp: boolean;
let faults: { table: string; method: string; throws?: boolean }[];
let logged: string[];

beforeEach(() => {
  created.length = 0;
  mail = [];
  faults = [];
  logged = [];
  engineUp = true;
  vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_API_URL: ENGINE,
    STRIPE_SECRET_KEY: "sk_test_journey", STRIPE_WEBHOOK_SECRET: WH, RESEND_API_KEY: "re_test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
    LEAD_TO_EMAIL: "operator@gridforge.test",
  });
  delete process.env.RESEND_FROM;
  delete process.env.GRIDFORGE_LEGACY_DEPOSIT;

  db = new PostgrestFake(["qualifications", "deliverables", "customer_notifications", "leads", "funnel_events"]);
  db.uniqueKeys.set("qualifications", [["token"]]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"], ["intake_token"]]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(),
    claimed_until: null, last_error: null, last_http_status: null, provider_message_id: null, accepted_at: null,
  }));
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    // The browser's relative call from the CTA reaches the real checkout route.
    if (url === "/api/checkout") {
      const { POST } = await import("@/app/api/checkout/route");
      return POST(new Request(siteUrl("/api/checkout"), { ...init, headers: { ...(init?.headers as Record<string, string>) } }));
    }
    if (url.startsWith(ENGINE)) {
      if (!engineUp) throw new Error("connect ECONNREFUSED");
      return new Response(JSON.stringify({
        platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72" },
        as_found: { racks: 0, binding_constraint: "Rack feed / tap-off rating", domain: "lv", basis: "b", it_load_kW: { value: 4900, evidence: "E1" } },
        after_relief: { racks: 28, architecture: "full_dlc", then_binds_on: null, sets_the_date: "plant" },
        first_three_constraints: [],
        intake: { completeness: 0.5, required_inputs_missing: 8, recommended_engagement: "density_screen" },
        notice: "n",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      mail.push({ to: ([] as string[]).concat(b.to), subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `em_${mail.length}` }), { status: 200 });
    }
    const hit = faults.find((f) => f.method === method && new RegExp(`/rest/v1/${f.table}(\\?|$)`).test(url));
    if (hit?.throws) throw new TypeError("fetch failed");
    if (hit) return new Response(JSON.stringify({ code: "XX000", message: "injected" }), { status: 500, headers: { "content-type": "application/json" } });
    return dbFetch(input as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});

afterEach(() => {
  undo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let ip = 0;
async function qualify(hall: Record<string, unknown> = HALL) {
  const { POST } = await import("@/app/api/qualify/route");
  const res = await POST(new Request(siteUrl("/api/qualify"), {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.7.0.${++ip}` }, body: JSON.stringify(hall),
  }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function checkout(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/checkout/route");
  const res = await POST(new Request(siteUrl("/api/checkout"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product: "density_screen", ...body }) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const lastSession = () => created[created.length - 1];

async function deliver(event: Record<string, unknown>, opts: { signature?: string } = {}) {
  const payload = JSON.stringify(event);
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const signature = opts.signature ?? new Stripe("sk_test_journey").webhooks.generateTestHeaderString({ payload, secret: WH });
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload }));
}

/** The event Stripe would send for a session this checkout created, once the card was charged. */
const paidFor = (s: { id: string; params: Record<string, any> }, over: Record<string, unknown> = {}) =>
  checkoutEvent(paidSession({
    id: s.id, customer_email: "buyer@northhall.example", customer: "cus_1", amount_total: Number(s.params.line_items[0].price_data.unit_amount),
    metadata: s.params.metadata, ...over,
  }));

const toBuyer = (address = "buyer@northhall.example") => mail.filter((m) => m.to.includes(address));
const deliverables = () => db.rows("deliverables") as any[];

async function intakePrefill(token: string) {
  const { GET } = await import("@/app/api/intake/[token]/route");
  const res = await GET(new Request(siteUrl("/api/intake/x")), { params: Promise.resolve({ token }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Depth-first search of a React element tree (a server component's return value) without rendering it. */
function findElements(node: unknown, match: (el: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) { node.forEach((n) => findElements(n, match, out)); return out; }
  if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as any;
    if (match(el)) out.push(el);
    findElements(el.props?.children, match, out);
  }
  return out;
}

describe("1. the qualifier result and its Density Screen CTA carry the original reference", () => {
  it("persists the read and returns BOTH its id and its token, on the share path the UI links to", async () => {
    const r = await qualify();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, saved: true });
    expect(r.body.qualificationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof r.body.qualificationToken).toBe("string");
    expect(r.body.share).toBe(`/q/${r.body.qualificationToken}`);
    const rows = db.rows("qualifications") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.body.qualificationId, token: r.body.qualificationToken, status: "scored", site_name: "North Hall" });
    expect(rows[0].inputs).toMatchObject({ contractedMW: 12, tapoffMaxA: 63, positionsAvailable: 180, metro: "Dublin" });
  });

  it("the result page renders the Density Screen CTA with that id and that token, and clicking it posts them to checkout", async () => {
    const r = await qualify();
    const { default: Page } = await import("@/app/q/[token]/page");
    const tree = await Page({ params: Promise.resolve({ token: r.body.qualificationToken }) });
    const { CommissionScreen } = await import("@/components/CommissionScreen");
    const [cta] = findElements(tree, (el) => el.type === CommissionScreen);
    expect(cta, "the page has a Density Screen CTA").toBeTruthy();
    expect(cta.props).toMatchObject({ productId: "density_screen", qualificationId: r.body.qualificationId, qualificationToken: r.body.qualificationToken });

    // What the button does when pressed: the shared client function, through the real checkout route.
    const href = { value: "" };
    vi.stubGlobal("window", { location: { set href(v: string) { href.value = v; }, get href() { return href.value; } } });
    const { startCommission } = await import("@/lib/ui");
    const outcome = await startCommission(cta.props.productId, {
      qualificationId: cta.props.qualificationId, qualificationToken: cta.props.qualificationToken, company: cta.props.company, capacityMW: cta.props.capacityMW,
    });
    expect(outcome).toEqual({ ok: true });
    expect(lastSession().params.metadata.qualification_id).toBe(r.body.qualificationId);
    expect(href.value).toBe(`https://checkout.stripe.test/c/pay/${lastSession().id}`);
  });

  it("the inline CTA component is the shared checkout button, not a link to the price list", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { CommissionScreen } = await import("@/components/CommissionScreen");
    const { createElement } = await import("react");
    const html = renderToStaticMarkup(createElement(CommissionScreen, { productId: "density_screen", qualificationId: "id", qualificationToken: "tok" }));
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).not.toContain("/pricing");
  });
});

describe("2. checkout puts only a validated qualification id into the Stripe session", () => {
  it("carries the id of a matching, recent read, and nothing else about it", async () => {
    const r = await qualify();
    const c = await checkout({ qualificationId: r.body.qualificationId, qualificationToken: r.body.qualificationToken, company: "Checkout Co", capacityMW: 12 });
    expect(c.status).toBe(200);
    const params = lastSession().params;
    expect(params.metadata.qualification_id).toBe(r.body.qualificationId);
    expect(Object.keys(params.metadata).sort()).toEqual(["capacity_mw", "company", "founding_applied", "kind", "qualification_id", "service"]);
    const wire = JSON.stringify(params);
    for (const secret of [r.body.qualificationToken, "ops@northhall.example", "Pat Ops", "North Hall", "Dublin", "Ireland", "North Hall Ltd"]) {
      expect(wire, `Stripe was given ${secret}`).not.toContain(secret);
    }
    expect(params.customer_email).toBeUndefined();
  });

  it.each([
    ["no reference", () => ({})],
    ["an id with no token", (r: any) => ({ qualificationId: r.qualificationId })],
    ["a wrong token", (r: any) => ({ qualificationId: r.qualificationId, qualificationToken: "wrong-token" })],
    ["a malformed id", (r: any) => ({ qualificationId: "not-a-uuid", qualificationToken: r.qualificationToken })],
    ["another read's token", (r: any, o: any) => ({ qualificationId: r.qualificationId, qualificationToken: o.qualificationToken })],
    ["another read's id", (r: any, o: any) => ({ qualificationId: o.qualificationId, qualificationToken: r.qualificationToken })],
  ])("drops %s: the sale proceeds and the Stripe session names no qualification", async (_label, build) => {
    const r = await qualify();
    const other = await qualify(OTHER_HALL);
    const c = await checkout((build as any)(r.body, other.body));
    expect(c.status).toBe(200);
    expect(lastSession().params.metadata.qualification_id).toBe("");
  });

  it("drops a read older than 24 hours, accepts one just inside it, and drops one dated in the future", async () => {
    const age = async (hours: number) => {
      const r = await qualify({ ...HALL, siteName: `Aged ${hours}` });
      (db.rows("qualifications").find((q: any) => q.id === r.body.qualificationId) as any).created_at = new Date(Date.now() - hours * 3600_000).toISOString();
      await checkout({ qualificationId: r.body.qualificationId, qualificationToken: r.body.qualificationToken });
      return { id: r.body.qualificationId as string, carried: lastSession().params.metadata.qualification_id as string };
    };
    const inside = await age(23);
    const expired = await age(25);
    const future = await age(-1);
    expect(inside.carried).toBe(inside.id);
    expect(expired.carried).toBe("");
    expect(future.carried).toBe("");
  });

  it("is refused outright, with no Stripe session, for an unknown product, no product, or when payments are not configured", async () => {
    const r = await qualify();
    const ref = { qualificationId: r.body.qualificationId, qualificationToken: r.body.qualificationToken };
    expect((await checkout({ product: "free_everything", ...ref })).status).toBe(400);
    expect((await checkout({ product: undefined, ...ref })).status).toBe(400);
    delete process.env.STRIPE_SECRET_KEY;
    const off = await checkout(ref);
    expect(off.status).toBe(503);
    expect(off.body).toEqual({ ok: false, error: "Payments not configured" });
    expect(created).toHaveLength(0);
  });
});

describe("3. a paid webhook opens exactly one engagement, once, joined to the read, and the intake is seeded from it", () => {
  async function purchase(hall: Record<string, unknown>, buyer: string, session = 0) {
    const r = await qualify(hall);
    await checkout({ qualificationId: r.body.qualificationId, qualificationToken: r.body.qualificationToken });
    const s = created[created.length - 1 - session];
    return { r: r.body, s, event: paidFor(s, { customer_email: buyer }) };
  }

  it("opens ONE deliverable linked to the qualification and sends ONE intake email with the intake link", async () => {
    const { r, s, event } = await purchase(HALL, "buyer@northhall.example");
    expect((await deliver(event)).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(deliverables()[0]).toMatchObject({ kind: "density_screen", status: "awaiting_intake", stripe_session_id: s.id, qualification_id: r.qualificationId, amount_cents: 450000 });
    const m = toBuyer();
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain(`/intake/${deliverables()[0].intake_token}`);
    expect(m[0].text).not.toContain(deliverables()[0].token);
  });

  it("a duplicate delivery of the same event creates no second row and sends no second email", async () => {
    const { event } = await purchase(HALL, "buyer@northhall.example");
    expect((await deliver(event)).status).toBe(200);
    const operatorMail = mail.filter((m) => m.to.includes("operator@gridforge.test")).length;
    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
    expect(mail.filter((m) => m.to.includes("operator@gridforge.test"))).toHaveLength(operatorMail);
  });

  it("concurrent duplicate deliveries create one row and one email; every answer is a success or a request to retry", async () => {
    const { event } = await purchase(HALL, "buyer@northhall.example");
    const answers = (await Promise.all(Array.from({ length: 6 }, () => deliver(event)))).map((r) => r.status);
    expect(answers.every((c) => c === 200 || c === 500)).toBe(true);
    expect(answers).toContain(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
    expect((await deliver(event)).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
  });

  it("the post-payment intake link resolves to a form seeded from the ORIGINAL qualification, and never from another one", async () => {
    const a = await purchase(HALL, "buyer@northhall.example");
    const b = await purchase(OTHER_HALL, "sam@othergrid.example");
    await deliver(a.event);
    await deliver(b.event);
    const rowA = deliverables().find((d) => d.stripe_session_id === a.s.id);
    const rowB = deliverables().find((d) => d.stripe_session_id === b.s.id);
    const preA = (await intakePrefill(rowA.intake_token)).body.prefill;
    const preB = (await intakePrefill(rowB.intake_token)).body.prefill;
    expect(preA).toEqual({
      siteName: "North Hall", hallId: "H1", metro: "Dublin", country: "Ireland", platform: "gb300_nvl72", contractedMW: "12", currentPeakMW: "7.4",
      currentItLoadMW: "4.9", buswayAmpacityA: "400", tapoffMaxA: "63", plantSupplyC: "6", positionsAvailable: "180",
    });
    expect(preB).toMatchObject({ siteName: "Other Hall", metro: "Cork", contractedMW: "20", tapoffMaxA: "125" });
    expect(JSON.stringify(preA)).not.toMatch(/Other Hall|Cork|othergrid|Sam Other/);
    expect(JSON.stringify(preB)).not.toMatch(/North Hall|Dublin|northhall|Pat Ops/);
    // The contact details of whoever ran the read are not intake fields.
    expect(JSON.stringify(preA)).not.toContain("@");
  });

  it("if the qualification cannot be fetched at all, the intake still loads (unseeded) instead of failing the link that was paid for", async () => {
    const a = await purchase(HALL, "buyer@northhall.example");
    await deliver(a.event);
    const row = deliverables()[0];
    faults.push({ table: "qualifications", method: "GET", throws: true });
    const res = await intakePrefill(row.intake_token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, kind: "density_screen", status: "awaiting_intake", prefill: {} });
    faults.length = 0;
    expect(Object.keys((await intakePrefill(row.intake_token)).body.prefill)).toContain("contractedMW");
  });

  it("a purchase that only NAMED another read gets an empty intake, not that read's numbers", async () => {
    const victim = await qualify(HALL);
    const attacker = await qualify(OTHER_HALL);
    await checkout({ qualificationId: victim.body.qualificationId, qualificationToken: attacker.body.qualificationToken });
    const s = lastSession();
    expect(s.params.metadata.qualification_id).toBe("");
    await deliver(paidFor(s, { customer_email: "attacker@example.test" }));
    const row = deliverables()[0];
    expect(row.qualification_id ?? null).toBeNull();
    const pre = (await intakePrefill(row.intake_token)).body;
    expect(pre.prefill).toEqual({});
    expect(JSON.stringify(pre)).not.toMatch(/North Hall|Dublin/);
  });
});

describe("4. negative paths: nothing is represented as paid, fulfilled or saved", () => {
  async function session() {
    await checkout({});
    return lastSession();
  }
  const nothing = (who: string) => { expect(deliverables()).toHaveLength(0); expect(toBuyer(who)).toHaveLength(0); expect(db.rows("customer_notifications")).toHaveLength(0); };

  it("payment_status 'unpaid': acknowledged (200), nothing fulfilled, no email, no operator notice", async () => {
    const s = await session();
    const res = await deliver(checkoutEvent(unpaidSession({ id: s.id, customer_email: "u@x.example", amount_total: 450000, metadata: s.params.metadata })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, fulfilled: false });
    nothing("u@x.example");
    expect(mail).toHaveLength(0);
  });

  it("an unknown payment_status is not read as paid", async () => {
    const s = await session();
    const res = await deliver(checkoutEvent(paidSession({ id: s.id, payment_status: "requires_review", customer_email: "u@x.example", metadata: s.params.metadata })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fulfilled: false });
    nothing("u@x.example");
  });

  it("a MISSING payment_status is refused (500, Stripe redelivers), fulfils nothing, and the corrected redelivery fulfils once", async () => {
    const s = await session();
    const malformed = checkoutEvent(omitPaymentStatus(paidSession({ id: s.id, customer_email: "m@x.example", metadata: s.params.metadata })));
    // The route throws on purpose (checkoutIsPaid): in production Next answers 500, which Stripe retries; called directly it rejects.
    await expect(deliver(malformed)).rejects.toThrow(/no payment_status/);
    nothing("m@x.example");
    expect((await deliver(paidFor(s, { customer_email: "m@x.example" }))).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer("m@x.example")).toHaveLength(1);
  });

  it("an invalid, a missing and a tampered signature are rejected", async () => {
    const s = await session();
    const event = paidFor(s, { customer_email: "f@x.example" });
    expect((await deliver(event, { signature: "t=1,v1=deadbeef" })).status).toBe(400);
    const { POST } = await import("@/app/api/stripe/webhook/route");
    expect((await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", body: JSON.stringify(event) }))).status).toBe(400);
    nothing("f@x.example");
  });

  it("a database failure at fulfilment answers 500 and leaves no half-state; the redelivery fulfils once", async () => {
    const s = await session();
    faults.push({ table: "deliverables", method: "POST" });
    expect((await deliver(paidFor(s, { customer_email: "d@x.example" }))).status).toBe(500);
    nothing("d@x.example");
    faults.length = 0;
    expect((await deliver(paidFor(s, { customer_email: "d@x.example" }))).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer("d@x.example")).toHaveLength(1);
  });

  it("when the email obligation cannot be recorded, Stripe is asked to retry and the redelivery sends it once", async () => {
    const s = await session();
    faults.push({ table: "customer_notifications", method: "POST" });
    expect((await deliver(paidFor(s, { customer_email: "o@x.example" }))).status).toBe(500);
    expect(toBuyer("o@x.example")).toHaveLength(0);
    faults.length = 0;
    expect((await deliver(paidFor(s, { customer_email: "o@x.example" }))).status).toBe(200);
    expect(deliverables()).toHaveLength(1);
    expect(toBuyer("o@x.example")).toHaveLength(1);
  });

  it("qualifier: a store that cannot keep the read still shows the engine's answer, with saved:false and NO reference or share link", async () => {
    faults.push({ table: "qualifications", method: "POST" });
    const r = await qualify();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, saved: false, share: null, qualificationId: null, qualificationToken: null });
    expect(r.body.result.as_found.binding_constraint).toBeTruthy();
    expect(db.rows("qualifications")).toHaveLength(0);
  });

  it("qualifier: an engine that is down produces no result and no reference, says the figures were saved, and marks the row engine_unavailable", async () => {
    engineUp = false;
    const r = await qualify();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, reason: "unreachable", saved: true });
    expect(r.body.result).toBeUndefined();
    expect(r.body.share ?? null).toBeNull();
    expect(r.body.qualificationId ?? null).toBeNull();
    expect(r.body.qualificationToken ?? null).toBeNull();
    expect(r.body.error).toMatch(/no result was produced/i);
    expect((db.rows("qualifications") as any[]).map((q) => q.status)).toEqual(["engine_unavailable"]);
  });

  it("qualifier: engine AND store down says the figures were NOT saved", async () => {
    engineUp = false;
    faults.push({ table: "qualifications", method: "POST" });
    const r = await qualify();
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, saved: false });
    expect(r.body.error).toMatch(/NOT saved/);
    expect(db.rows("qualifications")).toHaveLength(0);
  });

  it("qualifier: an engine that is not configured is a 503 with no result and no reference", async () => {
    delete process.env.GRIDFORGE_API_URL;
    const r = await qualify();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(r.body.qualificationId ?? null).toBeNull();
  });
});
