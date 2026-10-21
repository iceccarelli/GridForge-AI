/**
 * The Envelope Study and Portfolio Screen deposits: what they state, how they are credited, and when a person is overdue.
 *
 * Before: the scoping step recorded a free-text note and nothing else, "credits in full against the Study" was text in
 * lib/deliverables.ts and the admin proposal route (nothing recorded that a Screen had been credited, so a second Study
 * quote would credit it again), the page said no date is promised while the ladder says "25 working days from a complete
 * intake" for a product that has no intake, and a scoped deposit could sit for ever with nothing to be overdue against.
 *
 * MOCKS: the PostgREST fake is the database and tests/site/deposit-rpc-fake.ts mirrors gf_scope_deposit. That the real
 * function and triggers hold these invariants is proven on PostgreSQL in tests/test_delivery_handoff_migration.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { balanceDueCents, depositTerms } from "@/lib/engagement-state";
import { classify } from "@/lib/attention";
import * as shape from "@/lib/attention";
import { PostgrestFake } from "./postgrest-fake";
import { installDepositRpcs } from "./deposit-rpc-fake";

(globalThis as { React?: unknown }).React = React;
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const BUYER = "buyer@hall.example";
const FEE = 2_500_000;
const DUE = "2099-03-31";
let db: PostgrestFake;
let restore: () => void;

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
function deposit(over: Record<string, unknown> = {}) {
  db.seed("engagement_deposits", [{ stripe_session_id: `cs_${db.rows("engagement_deposits").length}`, kind: "envelope_study_deposit", amount_cents: 900_000,
    currency: "eur", email: BUYER, status: "contacted", owner: "Ada", contacted_at: day(1), paid_at: day(2), ...over }]);
  return db.rows("engagement_deposits").at(-1) as any;
}
function screen(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [{ token: `t${db.rows("deliverables").length}`, kind: "density_screen", email: BUYER, amount_cents: 450_000, stripe_session_id: "cs_s", status: "released", ...over }]);
  return db.rows("deliverables").at(-1) as any;
}
async function stepRaw(id: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/admin/deposits/[id]/route");
  const res = await POST(new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { res, body: (await res.json()) as any };
}
/** Credits need an operator's confirmation: `__confirm_all` plays the operator who has checked every candidate and confirms it. */
async function step(id: string, body: Record<string, unknown>) {
  const { __confirm_all: confirmAll, ...rest } = body;
  let r = await stepRaw(id, rest);
  if (confirmAll && r.res.status === 409 && r.body.details?.credits_available) {
    r = await stepRaw(id, { ...rest, confirm_credit_ids: r.body.details.credits_available.map((c: any) => c.source_deliverable_id) });
  }
  return r;
}
const scoping = (over: Record<string, unknown> = {}) => ({ scope_note: "One hall, grid and thermal, two architectures", agreed_fee_cents: FEE, delivery_due_on: DUE, __confirm_all: true, ...over });

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  jar.length = 0;
  db = new PostgrestFake(["engagement_deposits", "leads", "watches", "watch_note_notices"]);
  installDepositRpcs(db);
  restore = db.install();
  jar.push({ name: "gf_admin", value: adminToken()! });
});
afterEach(() => restore());

describe("what a deposit states", () => {
  it.each(["envelope_study_deposit", "portfolio_screen_deposit"])("%s states what it reserves, what it opens, how it is credited and when — from the catalogue", (kind) => {
    const p = PRODUCTS[kind as keyof typeof PRODUCTS];
    const t = depositTerms(kind)!;
    expect(t.reserves).toContain(eurFromCents(p.amountCents));
    expect(t.reserves).toMatch(/not the fee for the work/);
    expect(t.opens).toContain(eurFromCents(p.opensBandCents![0]));
    expect(t.opens).toContain(eurFromCents(p.opensBandCents![1]));
    expect(t.credit).toMatch(/credited in full against the agreed fee/);
    expect(t.timing).toContain(`${p.turnaroundDays} working days`);
    // The reconciliation of "25 working days" with "no date is promised": it counts from intake AND scoping, not from payment.
    expect(t.timing).toMatch(/count from a complete intake and the scoping call, not from payment/);
    expect(JSON.stringify(t)).not.toMatch(/within \d|business days?|guarantee/i);
  });

  it("the Study's terms say a paid Density Screen is credited once; the Portfolio Screen's say nothing of the kind", () => {
    expect(depositTerms("envelope_study_deposit")!.credit).toMatch(/Density Screen.*credited against the same fee, once/);
    expect(depositTerms("portfolio_screen_deposit")!.credit).not.toMatch(/Density Screen/);
  });

  it("is null for something that is not a deposit, rather than a guess", () => {
    expect(depositTerms("density_screen")).toBeNull();
    expect(depositTerms("nonsense")).toBeNull();
  });

  it("the customer page states them, and the recorded date and arithmetic once scoped", async () => {
    const d = deposit({ stripe_session_id: "cs_page" });
    const { default: Page } = await import("@/app/commissioned/page");
    const render = async () => renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: "cs_page" }) }));
    let html = await render();
    expect(html).toContain("What this deposit reserves");
    expect(html).toContain("not from payment");
    screen();
    expect((await step(d.id, scoping())).res.status).toBe(200);
    html = await render();
    expect(html).toContain(`Delivery date recorded when the scope was agreed: ${DUE}`);
    expect(html).toContain(eurFromCents(FEE - 900_000 - 450_000));          // balance
  });
});

describe("scoping records the fee, the date and the credit — or refuses", () => {
  it("needs a fee and a date; neither is guessed", async () => {
    const d = deposit();
    expect((await step(d.id, { scope_note: "x" })).res.status).toBe(422);
    expect((await step(d.id, scoping({ agreed_fee_cents: undefined }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ delivery_due_on: undefined }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ delivery_due_on: "next spring" }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ delivery_due_on: "2020-01-01" }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ agreed_fee_cents: 25_000.5 }))).res.status).toBe(422);
    expect(d.status).toBe("contacted");
  });

  it("holds the fee to the band the deposit was sold against", async () => {
    const d = deposit();
    const [lo, hi] = PRODUCTS.envelope_study_deposit.opensBandCents!;
    expect((await step(d.id, scoping({ agreed_fee_cents: lo - 1 }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ agreed_fee_cents: hi + 1 }))).res.status).toBe(422);
    expect((await step(d.id, scoping({ agreed_fee_cents: lo }))).res.status).toBe(200);
    const p = deposit({ kind: "portfolio_screen_deposit", amount_cents: 1_500_000 });
    expect((await step(p.id, scoping({ agreed_fee_cents: 1_000_000 }))).res.status).toBe(422);
    expect((await step(p.id, scoping({ agreed_fee_cents: 9_000_000 }))).res.status).toBe(200);
  });

  it("credits a paid Density Screen against the Study fee, once, with the arithmetic on the record", async () => {
    const d = deposit();
    const s = screen();
    const r = await step(d.id, scoping());
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deposit).toMatchObject({ status: "scoped", agreed_fee_cents: FEE, credit_applied_cents: 450_000, delivery_due_on: DUE });
    expect(r.body.balance_due_cents).toBe(balanceDueCents(FEE, 900_000, 450_000));
    expect(r.body.balance_due_cents).toBe(1_150_000);                         // 25,000 - 9,000 - 4,500 (EUR)
    expect(db.rows("engagement_credits")).toEqual([expect.objectContaining({ source_deliverable_id: s.id, deposit_id: d.id, amount_cents: 450_000 })]);
  });

  it("never credits the same Screen twice, against a second deposit", async () => {
    screen();
    const first = deposit();
    expect((await step(first.id, scoping())).body.deposit.credit_applied_cents).toBe(450_000);
    const second = deposit();
    const r = await step(second.id, scoping());
    expect(r.res.status).toBe(200);
    expect(r.body.deposit.credit_applied_cents).toBe(0);
    expect(db.rows("engagement_credits")).toHaveLength(1);
  });

  it("credits each of two Screens, and only the buyer's own (email matched case-insensitively)", async () => {
    screen();
    screen({ email: BUYER.toUpperCase() });
    screen({ email: "someone.else@rival.example" });
    const d = deposit();
    expect((await step(d.id, scoping())).body.deposit.credit_applied_cents).toBe(900_000);
    expect(db.rows("engagement_credits")).toHaveLength(2);
  });

  it("an underscore or percent sign in an address is not a wildcard: another buyer's credit is never matched", async () => {
    screen({ email: "john-doe@hall.example" });
    screen({ email: "johnXdoe@hall.example" });
    const d = deposit({ email: "john_doe@hall.example" });
    expect((await step(d.id, scoping())).body.deposit.credit_applied_cents).toBe(0);
    const d2 = deposit({ email: "%@hall.example" });
    expect((await step(d2.id, scoping())).body.deposit.credit_applied_cents).toBe(0);
    expect(db.rows("engagement_credits")).toHaveLength(0);
  });

  it.each(["a*@x.com", "a%b@x.com", "a_b@x.com", "A\\b@x.com"])("%s: identity is the exact normalised address, in code — a wildcard character matches nobody else's credit", async (typed) => {
    // addresses that a LIKE/ILIKE pattern built from `typed` would also match (and that PostgREST's `*` would)
    for (const other of ["ab@x.com", "aXb@x.com", "a-b@x.com", "a1b@x.com", "ac@x.com"]) screen({ email: other });
    const mine = screen({ email: typed.toUpperCase() });          // the buyer's own, typed with other capitals
    const { creditsToward } = await import("@/lib/deliverables");
    const found = await creditsToward(typed, "envelope_study");
    expect(found.from.map((f) => f.id)).toEqual([mine.id]);
    const d = deposit({ email: typed });
    const r = await step(d.id, scoping());                        // would 409 every time if a foreign credit were auto-selected
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.credits_applied).toEqual([expect.objectContaining({ source_deliverable_id: mine.id })]);
    expect(db.rows("engagement_credits")).toHaveLength(1);
  });

  it("credits are applied only when the operator confirms them: an unconfirmed call lists the candidates and records nothing", async () => {
    const s = screen({ company: "Hall Co" });
    const d = deposit();
    const r = await step(d.id, scoping({ __confirm_all: false }));
    expect(r.res.status).toBe(409);
    expect(r.body.error).toMatch(/confirm_credit_ids/);
    expect(r.body.details.credits_available).toEqual([expect.objectContaining({ source_deliverable_id: s.id, amount_cents: 450_000, email: BUYER, company: "Hall Co" })]);
    expect(JSON.stringify(r.body)).not.toContain(s.token);            // the document token is a credential: never listed
    expect(db.rows("engagement_deposits")[0].status).toBe("contacted");
    expect(db.rows("engagement_credits")).toHaveLength(0);
  });

  it("[] confirms none (the deposit is scoped with no credit and the Screen stays available); a subset applies only that", async () => {
    const a = screen(), b = screen();
    const d = deposit();
    const none = await step(d.id, scoping({ __confirm_all: false, confirm_credit_ids: [] }));
    expect(none.res.status).toBe(200);
    expect(none.body.deposit.credit_applied_cents).toBe(0);
    const d2 = deposit();
    const some = await step(d2.id, scoping({ __confirm_all: false, confirm_credit_ids: [a.id] }));
    expect(some.body.credits_applied).toEqual([expect.objectContaining({ source_deliverable_id: a.id })]);
    expect(some.body.credits_unapplied).toEqual([expect.objectContaining({ source_deliverable_id: b.id })]);
  });

  it("refuses to confirm a credit that is not this buyer's, already credited, or not a list — nothing recorded", async () => {
    const foreign = screen({ email: "someone.else@rival.example" });
    const mine = screen();
    const d = deposit();
    const bad = await step(d.id, scoping({ __confirm_all: false, confirm_credit_ids: [foreign.id] }));
    expect(bad.res.status).toBe(422);
    expect(bad.body.details.not_available).toEqual([foreign.id]);
    expect((await step(d.id, scoping({ __confirm_all: false, confirm_credit_ids: "all" }))).res.status).toBe(422);
    expect(db.rows("engagement_deposits")[0].status).toBe("contacted");
    expect((await step(d.id, scoping({ __confirm_all: false, confirm_credit_ids: [mine.id] }))).res.status).toBe(200);
    const d2 = deposit();
    expect((await step(d2.id, scoping({ __confirm_all: false, confirm_credit_ids: [mine.id] }))).res.status).toBe(422);   // already credited
  });

  it("does not credit an engagement that credits nothing (the Portfolio Screen)", async () => {
    screen();
    const p = deposit({ kind: "portfolio_screen_deposit", amount_cents: 1_500_000 });
    expect((await step(p.id, scoping({ agreed_fee_cents: 9_000_000 }))).body.deposit.credit_applied_cents).toBe(0);
    expect(db.rows("engagement_credits")).toHaveLength(0);
  });

  it("a credit never becomes a refund: one that would take deposit + credits past the fee is left unapplied, and stays available", async () => {
    // Four paid Screens (4 x 4,500) with a 9,000 deposit against the lowest fee (22,000): only the ones that FIT are applied.
    for (let i = 0; i < 4; i++) screen();
    const d = deposit();
    const lowest = PRODUCTS.envelope_study_deposit.opensBandCents![0];
    const r = await step(d.id, scoping({ agreed_fee_cents: lowest }));
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.deposit.credit_applied_cents).toBe(450_000 * 2);               // 9,000 + 9,000 = 18,000; a third would make 22,500 > 22,000
    expect(r.body.credits_unapplied).toHaveLength(2);
    expect(r.body.balance_due_cents).toBe(lowest - 900_000 - 900_000);
    expect(r.body.balance_due_cents).toBeGreaterThanOrEqual(0);
    // the two left over were not consumed: the buyer's next engagement can still use them
    const next = deposit();
    const r2 = await step(next.id, scoping({ agreed_fee_cents: lowest }));
    expect(r2.body.deposit.credit_applied_cents).toBe(900_000);
    expect(db.rows("engagement_credits")).toHaveLength(4);
  });

  it("refuses a fee below the deposit itself", async () => {
    const d = deposit({ amount_cents: 2_400_000 });        // contrived: a deposit larger than the lowest fee
    const r = await step(d.id, scoping({ agreed_fee_cents: 2_200_000 }));
    expect(r.res.status).toBe(422);
    expect(r.body.error).toMatch(/never creates a refund/);
    expect(db.rows("engagement_credits")).toHaveLength(0);
  });

  it("applies NO credit, and says why, when it cannot see whether one was already given — it never guesses", async () => {
    const d = deposit();
    screen();
    db.dropTable("engagement_credits");
    const r = await step(d.id, scoping());
    expect(r.res.status).toBe(503);
    expect(r.body.error).toMatch(/credit ledger could not be read/);
    expect(db.rows("engagement_deposits")[0].status).toBe("contacted");
  });

  it("names migration 0030 when the scoping function is not there yet, and records nothing", async () => {
    const d = deposit();
    db.rpcs.delete("gf_scope_deposit");
    const r = await step(d.id, scoping());
    expect(r.res.status).toBe(503);
    expect(r.body.error).toMatch(/0030/);
    expect(db.rows("engagement_deposits")[0].status).toBe("contacted");
  });

  it("a Screen being credited elsewhere at the same moment is a refusal with nothing recorded, not a double credit", async () => {
    const d = deposit();
    const s = screen();
    db.rows("engagement_credits").push({ id: "pre", source_deliverable_id: s.id, deposit_id: "other", amount_cents: 450_000 });
    // the read saw no credit (simulated by hiding the existing row from the availability read only)
    const real = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i).includes("/engagement_credits?source_deliverable_id=in.") ? new Response("[]", { status: 200 }) : real(i, init)) as typeof fetch;
    try {
      const r = await step(d.id, scoping());
      expect(r.res.status).toBe(409);
      expect(db.rows("engagement_deposits")[0].status).toBe("contacted");
      expect(db.rows("engagement_credits")).toHaveLength(1);
    } finally { globalThis.fetch = real; }
  });

  it("delivering does not touch the committed fee, credit or date", async () => {
    const d = deposit();
    await step(d.id, scoping());
    const r = await step(d.id, { delivery_ref: "https://example.test/study-v1" });
    expect(r.body.deposit).toMatchObject({ status: "delivered", agreed_fee_cents: FEE, delivery_due_on: DUE });
  });
});

describe("the proposal does not offer a credit already given", () => {
  it("excludes a Screen that was credited against a deposit, and reports an unreadable ledger as unknown", async () => {
    process.env.GRIDFORGE_API_URL = "http://engine.test";
    process.env.GRIDFORGE_API_KEY = "k";
    const real = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i).startsWith("http://engine.test")
        ? new Response(JSON.stringify({ title: "Proposal", document: "<p>p</p>" }), { status: 200 })
        : real(i, init)) as typeof fetch;
    try {
      screen();
      const propose = async () => {
        const { POST } = await import("@/app/api/admin/proposal/route");
        const res = await POST(new Request(siteUrl("/x"), { method: "POST", body: JSON.stringify({ engagement: "envelope_study", email: BUYER, company: "Hall Co", inputs: { contracted_MW: 12 } }) }));
        return (await res.json()) as any;
      };
      expect((await propose()).credit).toMatchObject({ ok: true, cents: 450_000 });
      const d = deposit();
      await step(d.id, scoping());
      expect((await propose()).credit).toMatchObject({ ok: true, cents: 0 });
      db.dropTable("engagement_credits");
      const unknown = await propose();
      expect(unknown.credit.ok).toBe(false);
      expect(unknown.credit.cents).toBe(0);
    } finally { globalThis.fetch = real; }
  });
});

describe("a paid deposit cannot be stuck with nobody and nothing to be late against", () => {
  const NOW = Date.parse("2027-02-01T12:00:00Z");
  const at = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  const kinds = (deposits: Record<string, unknown>[]) =>
    classify({ deliverables: [], deposits, watches: [], notices: [] }, NOW).map((i) => i.kind);

  it("flags: paid and uncontacted, contacted and unscoped, scoped past its date, scoped with no date on file", () => {
    expect(kinds([{ id: "1", kind: "envelope_study_deposit", status: "paid", paid_at: at(3) }])).toEqual(["deposit_uncontacted"]);
    expect(kinds([{ id: "1", kind: "envelope_study_deposit", status: "contacted", owner: "Ada", contacted_at: at(8), paid_at: at(9) }])).toEqual(["deposit_unscoped"]);
    expect(kinds([{ id: "1", kind: "envelope_study_deposit", status: "scoped", owner: "Ada", delivery_due_on: "2027-01-31", scoped_at: at(20) }])).toEqual(["deposit_overdue"]);
    expect(kinds([{ id: "1", kind: "envelope_study_deposit", status: "scoped", owner: "Ada", scoped_at: at(20) }])).toEqual(["deposit_no_date"]);
  });

  it("does not flag what is on time, or delivered", () => {
    expect(kinds([
      { id: "1", kind: "envelope_study_deposit", status: "paid", paid_at: at(1) },
      { id: "2", kind: "envelope_study_deposit", status: "contacted", owner: "Ada", contacted_at: at(2), paid_at: at(3) },
      { id: "3", kind: "envelope_study_deposit", status: "scoped", owner: "Ada", delivery_due_on: "2027-03-01", scoped_at: at(5) },
      { id: "4", kind: "envelope_study_deposit", status: "delivered", paid_at: at(90) },
    ])).toEqual([]);
  });

  it("an overdue item names its owner, due date and what to do", () => {
    const [item] = classify({ deliverables: [], watches: [], notices: [], deposits: [{ id: "9", kind: "portfolio_screen_deposit", status: "scoped", owner: "Ada", email: BUYER, delivery_due_on: "2027-01-15", scoped_at: at(40) }] }, NOW);
    expect(item).toMatchObject({ kind: "deposit_overdue", owner: "Ada", due: "2027-01-15", buyer: BUYER, table: "engagement_deposits" });
    expect(item.action).toMatch(/Deliver, or tell the buyer/);
  });

  it("the admin list shows them, with the terms and the balance once scoped", async () => {
    deposit({ stripe_session_id: "cs_old", status: "paid", owner: null, contacted_at: null, paid_at: day(5) });
    const scoped = deposit({ stripe_session_id: "cs_sc" });
    await step(scoped.id, scoping());
    const { GET } = await import("@/app/api/admin/deposits/route");
    const listed: any = await (await GET(new Request(siteUrl("/api/admin/deposits")))).json();
    expect(listed.items.every((d: any) => d.terms && d.terms.timing)).toBe(true);
    expect(listed.items.find((d: any) => d.stripe_session_id === "cs_sc").balance_due_cents).toBe(FEE - 900_000);
    const att: any = await (await (await import("@/app/api/admin/deliverables/route")).GET()).json();
    expect(att.items.map((i: any) => i.kind)).toContain("deposit_uncontacted");
  });
});

describe("the operator's deposits table", () => {
  const NOW = Date.parse("2027-02-01T12:00:00Z");
  const at = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  const base = { kind: "envelope_study_deposit", amount_cents: 900_000, email: BUYER, company: "Hall Co" };

  it("shapes status, age, owner/contact, fee, credit, balance and date per deposit, oldest payment first", () => {
    const rows = [
      { id: "b", ...base, status: "scoped", paid_at: at(20), owner: "Ada", contacted_at: at(18), scoped_at: at(10),
        agreed_fee_cents: 2_500_000, credit_applied_cents: 450_000, delivery_due_on: "2027-03-01" },
      { id: "a", ...base, kind: "portfolio_screen_deposit", amount_cents: 1_500_000, status: "paid", paid_at: at(30) },
    ];
    const { shapeDeposits } = shape;
    const t = shapeDeposits(rows, NOW);
    expect(t.map((d) => d.id)).toEqual(["a", "b"]);
    expect(t[0]).toMatchObject({ what: "Portfolio Screen — deposit", status: "paid", age_days: 30, owner: null, fee_cents: null, credit_cents: null, balance_due_cents: null, due: null, flag: "deposit_uncontacted" });
    expect(t[1]).toMatchObject({ status: "scoped", age_days: 20, owner: "Ada", fee_cents: 2_500_000, credit_cents: 450_000, balance_due_cents: 1_150_000, due: "2027-03-01", flag: null });
  });

  it("flags an overdue and a no-date scoped deposit, and never shows a negative balance", () => {
    const { shapeDeposits } = shape;
    const t = shapeDeposits([
      { id: "o", ...base, status: "scoped", paid_at: at(60), owner: "Ada", scoped_at: at(40), agreed_fee_cents: 800_000, credit_applied_cents: 0, delivery_due_on: "2027-01-10" },
      { id: "n", ...base, status: "scoped", paid_at: at(60), owner: "Ada", scoped_at: at(40) },
    ], NOW);
    expect(t.find((d) => d.id === "o")).toMatchObject({ flag: "deposit_overdue", balance_due_cents: 0 });
    expect(t.find((d) => d.id === "n")).toMatchObject({ flag: "deposit_no_date", fee_cents: null });
  });

  it("keeps delivered deposits visible, with when they were delivered", () => {
    const { shapeDeposits } = shape;
    const [d] = shapeDeposits([{ id: "d", ...base, status: "delivered", paid_at: at(90), owner: "Ada", agreed_fee_cents: 2_500_000, credit_applied_cents: 0, delivery_due_on: "2027-01-01", delivered_at: at(5) }], NOW);
    expect(d).toMatchObject({ status: "delivered", flag: null });
    expect(d.delivered_at).toBeTruthy();
  });

  it("the pipeline panel renders them, says 'nobody yet' and 'no date on file', and an unreadable list is an error not an empty table", async () => {
    const { EngagementPipeline } = await import("@/components/EngagementPipeline");
    const { summariseQualifications } = await import("@/lib/admin");
    const { shapeDeposits } = await import("@/lib/attention");
    const props = { deliverables: [], qualifications: [], watches: [], insights: summariseQualifications([]), supabaseReady: true };
    const html = renderToStaticMarkup(React.createElement(EngagementPipeline, {
      ...props,
      deposits: shapeDeposits([
        { id: "a", ...base, status: "paid", paid_at: at(5) },
        { id: "b", ...base, status: "scoped", paid_at: at(50), owner: "Ada", scoped_at: at(40) },
      ], NOW),
    }));
    expect(html).toContain("Deposits");
    expect(html).toContain("nobody yet");
    expect(html).toContain("no date on file");
    expect(html).toContain("deposit uncontacted");
    const failed = renderToStaticMarkup(React.createElement(EngagementPipeline, { ...props, deposits: null, depositsError: "The deposit list could not be read." }));
    expect(failed).toContain("This is not a statement that there are none");
    const none = renderToStaticMarkup(React.createElement(EngagementPipeline, { ...props, deposits: [] }));
    expect(none).toContain("No deposit has been paid yet");
  });

  it("the table's source lists delivered deposits too and reports a failed read", async () => {
    const { depositTable } = await import("@/lib/attention");
    deposit({ stripe_session_id: "cs_t1", status: "delivered", delivered_at: new Date().toISOString(), delivery_ref: "r" });
    deposit({ stripe_session_id: "cs_t2", status: "paid", owner: null, contacted_at: null });
    const ok = await depositTable();
    expect(ok.ok && ok.items.map((d) => d.status).sort()).toEqual(["delivered", "paid"]);
    db.dropTable("engagement_deposits");
    expect((await depositTable()).ok).toBe(false);
  });
});
