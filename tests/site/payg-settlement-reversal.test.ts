/**
 * Stripe refunds (in full or in part) or a customer disputes a pay-as-you-go MONTHLY SETTLEMENT invoice (idempotency key
 * payg:{account}:{YYYY-MM}).
 *
 * Before this change nothing happened: the settlement stayed "paid", the customer's page kept saying so, and the account went on using
 * the engine. Now (lib/payg-refunds.ts): the refund / dispute state is appended to payg_settlement_reversals, linked to the settlement
 * (never editing the settlement row and never the usage ledger); a refund in full or a dispute that stands suspends further pay-as-you-go
 * use, reversibly, exactly like a subscription hold; a partial refund is recorded and mailed, nothing else; the operator is mailed once
 * per refund amount / dispute state; nothing is re-granted and nothing is credited to a later invoice.
 *
 *   MOCK STRIPE / MOCK ENGINE / FAKE STORE   tests/site/billing-holds-harness.ts. The fake enforces the table's UNIQUE dedupe_key and its
 *   append-only rule (the SQL itself is proven against PostgreSQL in tests/test_billing_pause_reversals_migration.py).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { accountRef } from "@/lib/payg";
import { settleClosedMonths } from "@/lib/payg-settle";
import { paygAccount } from "./payg-harness";
import { at, audit, operatorMail, revokeCalls, send, startRig, type Rig } from "./billing-holds-harness";
import { releaseSql } from "@/lib/payg-release-sql";
import type { Row } from "./postgrest-fake";

let rig: Rig;
beforeEach(() => {
  rig = startRig();
  rig.db.appendOnly.add("payg_settlement_reversals");
  // the table's own default for a release that names no key
  rig.db.rowDefaults.set("payg_settlement_reversals", () => ({ dedupe_key: `release:${++releaseSeq}` }));
});
afterEach(() => rig.stop());

const ACCOUNT = "acme-123456";
const releaseFor = (settlement: Row, ref: string) => releaseSql({ id: String(settlement.id), account: ACCOUNT, month: "2026-09" }, ref);
let releaseSeq = 0;
/**
 * Run the INSERT the operator's mail gives (or releaseSql builds) against the fake store: the column list and the values are parsed from the
 * statement, so what the statement leaves out (dedupe_key) is what the table's own default fills, as in PostgreSQL.
 */
function operatorRuns(text: string) {
  const m = text.match(/insert into payg_settlement_reversals \(([^)]*)\)\s+values \(([^;]*)\);/);
  if (!m) throw new Error("no release statement in: " + text.slice(0, 200));
  const cols = m[1].split(",").map((c) => c.trim());
  const vals = [...m[2].matchAll(/'([^']*)'|(\d+)/g)].map((x) => (x[1] !== undefined ? x[1] : Number(x[2])));
  const row: Record<string, unknown> = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
  rig.db.insertRow("payg_settlement_reversals", row as Row);
}
const reversals = () => rig.db.rows("payg_settlement_reversals") as Row[];

/** A pay-as-you-go account with a live key, and its September settlement, PAID. */
function setup(over: { account?: Record<string, unknown>; settlement?: Record<string, unknown> } = {}) {
  const acct = paygAccount(rig.db, { key_id: "keyPAYG1", key_scope: "payg", key_issued_at: "2026-10-01", key_expires_at: "2026-11-30", ...(over.account ?? {}) });
  const settlement = rig.db.insertRow("usage_settlements", {
    account: ACCOUNT, month: "2026-09", units: 100, amount_cents: 10_000, status: "paid", stripe_invoice_id: "in_set_09", hosted_invoice_url: "https://invoice.stripe.test/i/in_set_09", ...(over.settlement ?? {}),
  });
  rig.stripe.linkSettlement("ch_s9", "pi_s9", "in_set_09", { account: ACCOUNT, month: "2026-09" });
  return { acct, settlement };
}
const ledger = () => {
  rig.db.rows("usage_events").push(
    { event_id: "e1", seq: 1, account: ACCOUNT, scope: "payg", kind: "charge", units: 60, occurred_at: "2026-09-10T12:00:00.000Z", ref: "", key_id: "keyPAYG1", endpoint: "/v1/study", project: "", idem: "" },
    { event_id: "e2", seq: 2, account: ACCOUNT, scope: "payg", kind: "charge", units: 40, occurred_at: "2026-09-20T12:00:00.000Z", ref: "", key_id: "keyPAYG1", endpoint: "/v1/study", project: "", idem: "" },
  );
  return JSON.parse(JSON.stringify(rig.db.rows("usage_events")));
};
const refunded = (cents: number, over: Record<string, unknown> = {}) => ({ id: "ch_s9", object: "charge", amount: 10_000, amount_refunded: cents, refunded: cents >= 10_000, payment_intent: "pi_s9", currency: "eur", ...over });
const dispute = (status: string, over: Record<string, unknown> = {}) => ({ id: "dp_s9", object: "dispute", amount: 10_000, currency: "eur", charge: "ch_s9", reason: "fraudulent", status, ...over });
const usage = async (token: string) => (await (await import("@/app/api/usage/route")).GET(new Request(siteUrl(`/api/usage?token=${token}`)))).json();

describe("1. a refund IN FULL of a settlement invoice", () => {
  it("records an append-only event linked to the settlement, suspends further use (reversibly), and changes NOTHING in the ledger, the settlement row or the cap", async () => {
    const { acct, settlement } = setup();
    const before = ledger();
    const settlementBefore = JSON.parse(JSON.stringify(settlement));
    const capBefore = acct.cap_units;
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 })).status).toBe(200);

    // the event, linked to the settlement
    expect(reversals()).toHaveLength(1);
    expect(reversals()[0]).toMatchObject({ settlement_id: settlement.id, account: ACCOUNT, month: "2026-09", kind: "refund", state: "full", amount_cents: 10_000, stripe_object_id: "ch_s9", stripe_invoice_id: "in_set_09", dedupe_key: "refund:ch_s9:10000" });
    // the account: the same reversible hold as a subscription, the key revoked (recorded, then confirmed), minting refused, nothing deleted
    expect(acct).toMatchObject({ status: "past_due", key_id: null, billing_hold: "refunded", billing_hold_ref: "ch_s9", billing_hold_invoice: "in_set_09", billing_hold_prev_status: "active", plan: "api_payg" });
    expect(acct.revoked_key_ids).toEqual(["keyPAYG1"]);
    expect(acct.revoked_confirmed_ids).toEqual(["keyPAYG1"]);
    expect(revokeCalls(rig)).toEqual(["keyPAYG1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    const { POST } = await import("@/app/api/keys/route");
    const mint = await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: acct.token }) }));
    expect(mint.status).toBe(402);
    expect((await mint.json()).hold).toBe("refunded");
    // what must NOT move
    expect(rig.db.rows("usage_events")).toEqual(before);
    expect(settlement).toMatchObject({ status: "paid", units: settlementBefore.units, amount_cents: settlementBefore.amount_cents, stripe_invoice_id: "in_set_09" });
    expect(acct.cap_units).toBe(capBefore);
    // the operator hears of it, once, with the facts and the policy
    const m = operatorMail(rig).filter((x) => /REFUNDED IN FULL/.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].subject).toContain(accountRef(ACCOUNT));
    expect(m[0].text).toContain("SUSPENDED further pay-as-you-go use");
    expect(m[0].text).toMatch(/no credit was applied to any future invoice/);
    expect(m[0].text).toContain("insert into payg_settlement_reversals");
    expect(m[0].text).not.toContain("ops@acme.example");
  });

  it("a redelivery double-counts nothing: one event row, one revocation, one hold audit row, one mail", async () => {
    const { acct } = setup();
    for (let n = 0; n < 3; n++) expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_dup" })).status).toBe(200);
    expect(reversals()).toHaveLength(1);
    expect(revokeCalls(rig)).toEqual(["keyPAYG1"]);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    expect(operatorMail(rig).filter((x) => /REFUNDED/.test(x.subject))).toHaveLength(1);
    expect(acct.billing_hold).toBe("refunded");
  });

  it("the customer's usage page states the refund beside the invoice's own status, and the meter is unchanged", async () => {
    const { acct } = setup();
    ledger();
    const before = await usage(acct.token as string);
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const after = await usage(acct.token as string);
    expect(after.settlements).toEqual([{ month: "2026-09", units: 100, amount_cents: 10_000, status: "paid", carried_units: 0, hosted_invoice_url: "https://invoice.stripe.test/i/in_set_09", refunded_cents: 10_000, refund_state: "full", dispute: null }]);
    expect(before.settlements[0]).toMatchObject({ refunded_cents: 0, refund_state: null });
    for (const k of ["units_used", "units_cap", "remaining_units", "billable_units", "eur_accrued_cents"]) expect(after[k], k).toEqual(before[k]);
    expect(after.events).toEqual(before.events);
  });

  it("the month is NOT invoiced again (the settlement row stays; the idempotency key is still the one invoice)", async () => {
    setup();
    ledger();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const rep = await settleClosedMonths(rig.stripe, new Date(Date.UTC(2026, 9, 24)));
    expect(rig.stripe.calls).not.toContain("invoices.create");
    expect(rep.created.pending + rep.created.carried + rep.created.void).toBe(0);
    expect((rig.db.rows("usage_settlements") as Row[]).filter((s) => s.month === "2026-09")).toHaveLength(1);
  });
});

describe("2. a PARTIAL refund is recorded and mailed; access is unchanged", () => {
  it("one row per cumulative amount (never double-counted); the page shows the largest; a full refund later suspends", async () => {
    const { acct } = setup();
    expect((await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0 })).status).toBe(200);
    expect(acct).toMatchObject({ status: "active", key_id: "keyPAYG1", billing_hold: null });
    expect(revokeCalls(rig)).toEqual([]);
    expect(reversals()).toHaveLength(1);
    expect(reversals()[0]).toMatchObject({ state: "partial", amount_cents: 2_500 });
    expect(operatorMail(rig).filter((x) => /partly refunded/.test(x.subject))).toHaveLength(1);
    // redelivered, then a larger cumulative amount, then a late OLDER (smaller) one
    await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0, id: "evt_r1" });
    await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0, id: "evt_r1" });
    await send(rig, "charge.refunded", refunded(6_000), { created: rig.T0 + 10 });
    await send(rig, "charge.refunded", refunded(1_000), { created: rig.T0 + 5 });
    expect(reversals().map((r) => r.amount_cents).sort((a, b) => (a as number) - (b as number))).toEqual([1_000, 2_500, 6_000]);
    expect((await usage(acct.token as string)).settlements[0]).toMatchObject({ refunded_cents: 6_000, refund_state: "partial", status: "paid" });
    expect(acct.billing_hold).toBeNull();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 + 20 });
    expect(acct).toMatchObject({ billing_hold: "refunded", status: "past_due" });
    expect((await usage(acct.token as string)).settlements[0]).toMatchObject({ refunded_cents: 10_000, refund_state: "full" });
  });

  it("a partial refund of a SUBSCRIPTION payment is still just a partial refund (nothing recorded in the settlement table)", async () => {
    setup();
    rig.stripe.link("ch_sub", "pi_sub", "in_sub", "sub_other");
    await send(rig, "charge.refunded", { id: "ch_sub", object: "charge", amount: 90_000, amount_refunded: 1_000, refunded: false, payment_intent: "pi_sub" }, { created: rig.T0 });
    expect(reversals()).toHaveLength(0);
  });
});

describe("3. a dispute of a settlement invoice", () => {
  it("open: suspends and records; under_review: the same hold; won: lifts it back to what the account was, the key stays revoked; a stale created after it holds nothing", async () => {
    const { acct } = setup();
    await send(rig, "charge.dispute.created", dispute("needs_response"), { created: rig.T0 + 10 });
    expect(acct).toMatchObject({ status: "past_due", billing_hold: "disputed", billing_hold_ref: "dp_s9", key_id: null });
    await send(rig, "charge.dispute.updated", dispute("under_review"), { created: rig.T0 + 20 });
    expect(reversals().map((r) => r.state).sort()).toEqual(["needs_response", "under_review"]);
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    expect((await usage(acct.token as string)).settlements[0]).toMatchObject({ dispute: "open", status: "paid" });
    rig.stripe.pinDispute("dp_s9", dispute("won"));
    await send(rig, "charge.dispute.closed", dispute("won"), { created: rig.T0 + 30 });
    expect(acct).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    expect(acct.revoked_key_ids).toEqual(["keyPAYG1"]);
    expect((await usage(acct.token as string)).settlements[0]).toMatchObject({ dispute: "won" });
    await send(rig, "charge.dispute.created", dispute("needs_response"), { created: rig.T0 + 11, id: "evt_stale" });
    await send(rig, "charge.dispute.updated", dispute("under_review"), { created: rig.T0 + 21, id: "evt_stale2" });
    expect(acct).toMatchObject({ status: "active", billing_hold: null });
    expect(audit(rig, "hold_applied")).toHaveLength(1);
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
    expect(operatorMail(rig).filter((x) => /DISPUTED/.test(x.subject)).map((x) => x.subject.match(/: ([a-z_]+)/)?.[1]).sort()).toEqual(["needs_response", "under_review", "won"]);
  });

  const ORDERS: [string, string, string][] = [["created", "updated", "closed"], ["created", "closed", "updated"], ["updated", "created", "closed"], ["updated", "closed", "created"], ["closed", "created", "updated"], ["closed", "updated", "created"]];
  const TYPE: Record<string, string> = { created: "charge.dispute.created", updated: "charge.dispute.updated", closed: "charge.dispute.closed" };
  const SAID = (ev: string, final: string) => dispute(ev === "created" ? "needs_response" : ev === "updated" ? "under_review" : final);
  for (const final of ["won", "lost"] as const) {
    for (const order of ORDERS) {
      it(`any order (${order.join(" -> ")}), Stripe says ${final}: ${final === "won" ? "no hold" : "one hold"}, and the reversal rows are per dispute state`, async () => {
        const { acct } = setup();
        rig.stripe.pinDispute("dp_s9", dispute(final));
        for (const ev of order) for (let n = 0; n < 2; n++) expect((await send(rig, TYPE[ev], SAID(ev, final), { created: rig.T0 + 10, id: `evt_${ev}_${n}` })).status).toBe(200);
        if (final === "won") {
          expect(acct).toMatchObject({ status: "active", key_id: "keyPAYG1", billing_hold: null });
          expect(revokeCalls(rig)).toEqual([]);
        } else {
          expect(acct).toMatchObject({ status: "past_due", billing_hold: "disputed", billing_hold_ref: "dp_s9" });
          expect(revokeCalls(rig)).toEqual(["keyPAYG1"]);
          expect(audit(rig, "hold_applied")).toHaveLength(1);
        }
        expect(reversals().map((r) => r.state)).toEqual([final]); // Stripe's state, once, not one row per event
      });
    }
  }
});

describe("4. when the account is NOT suspended, and why", () => {
  it("a LATER settlement of the account has been paid: the reversed month is history; recorded, audited, not suspended", async () => {
    const { acct } = setup();
    rig.db.insertRow("usage_settlements", { account: ACCOUNT, month: "2026-10", units: 20, amount_cents: 2_000, status: "paid", stripe_invoice_id: "in_set_10" });
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    expect(acct).toMatchObject({ status: "active", key_id: "keyPAYG1", billing_hold: null });
    expect(reversals()).toHaveLength(1);
    expect(audit(rig, "hold_skipped_later_settlement_paid")).toHaveLength(1);
    expect(operatorMail(rig)[0].text).toMatch(/LATER settlement of this account has been paid/);
  });

  it("the refunded invoice is NOT the one the settlement records (a duplicate invoice refunded): recorded, the operator is warned, access untouched", async () => {
    const { acct } = setup({ settlement: { stripe_invoice_id: "in_set_09_REAL" } });
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    expect(acct).toMatchObject({ status: "active", key_id: "keyPAYG1", billing_hold: null });
    expect(reversals()[0].detail).toMatchObject({ invoice_mismatch: true });
    expect(operatorMail(rig)[0].text).toMatch(/NOT the one this settlement records/);
  });

  it("a cancelled account is recorded and left cancelled", async () => {
    const { acct } = setup({ account: { status: "cancelled" } });
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    expect(acct.status).toBe("cancelled");
    expect(reversals()).toHaveLength(1);
    expect(audit(rig, "hold_applied")).toHaveLength(0);
  });

  it("an invoice marked as a settlement with no usable account and month, or with no settlement row, is acknowledged and the operator told (never retried for ever)", async () => {
    setup();
    rig.stripe.linkSettlement("ch_bad", "pi_bad", "in_bad", { account: "", month: "nope" });
    expect((await send(rig, "charge.refunded", refunded(10_000, { id: "ch_bad", payment_intent: "pi_bad" }), { created: rig.T0 })).status).toBe(200);
    rig.stripe.linkSettlement("ch_none", "pi_none", "in_none", { account: ACCOUNT, month: "2025-01" });
    expect((await send(rig, "charge.refunded", refunded(10_000, { id: "ch_none", payment_intent: "pi_none" }), { created: rig.T0 })).status).toBe(200);
    expect(reversals()).toHaveLength(0);
    expect(operatorMail(rig).map((m) => m.subject).sort()).toEqual(["A refund or dispute of a pay-as-you-go invoice could not be linked", "A refund or dispute of a pay-as-you-go invoice has no settlement record"]);
  });
});

describe("5. getting access back", () => {
  it("a LATER settlement invoice PAID lifts the hold (the revoked key stays revoked); the same invoice, an older month and a payment of nothing do not", async () => {
    const { acct } = setup();
    rig.db.insertRow("usage_settlements", { account: ACCOUNT, month: "2026-10", units: 20, amount_cents: 2_000, status: "invoiced", stripe_invoice_id: "in_set_10" });
    rig.db.insertRow("usage_settlements", { account: ACCOUNT, month: "2026-08", units: 20, amount_cents: 2_000, status: "invoiced", stripe_invoice_id: "in_set_08" });
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const paid = (id: string, month: string, amount: number) => send(rig, "invoice.paid", { id, object: "invoice", amount_paid: amount, metadata: { kind: "payg_settlement", account: ACCOUNT, month }, hosted_invoice_url: "https://invoice.stripe.test/x" }, { created: rig.T0 + 100 });
    await paid("in_set_09", "2026-09", 10_000); // the refunded invoice itself
    await paid("in_set_08", "2026-08", 2_000); // an OLDER month
    await paid("in_set_10", "2026-10", 0); // nothing collected
    expect(acct).toMatchObject({ status: "past_due", billing_hold: "refunded" });
    await paid("in_set_10", "2026-10", 2_000);
    expect(acct).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    expect(acct.revoked_key_ids).toEqual(["keyPAYG1"]);
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
  });

  it("a failed settlement elsewhere neither lifts nor stacks on a hold: the hold decides (and the account is not re-derived to active)", async () => {
    const { acct } = setup();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const { reconcileAccount } = await import("@/lib/payg-billing");
    expect(await reconcileAccount(ACCOUNT)).toEqual({ ok: true });
    expect(acct).toMatchObject({ status: "past_due", billing_hold: "refunded" }); // before: no failed settlement -> "active again"
  });

  it("an operator release naming the hold's own charge lifts exactly that hold, once, and audits it; a release for another object does nothing", async () => {
    const { acct, settlement } = setup();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    at(rig.T0 + 60);
    operatorRuns(releaseFor(settlement, "ch_OTHER")); // the SQL the mail shows, for the wrong charge
    let rep = await runSettlementReversalPass();
    expect(rep).toMatchObject({ releasesApplied: 0, errors: 0 });
    expect(rep.heldAccounts).toEqual([{ account_ref: accountRef(ACCOUNT), hold: "refunded", since: expect.any(String) }]);
    expect(acct.billing_hold).toBe("refunded");
    at(rig.T0 + 120);
    operatorRuns(operatorMail(rig).map((m) => m.text).join("\n")); // the SQL in the operator's own mail, verbatim
    rep = await runSettlementReversalPass();
    expect(rep.releasesApplied).toBe(1);
    expect(acct).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    expect(audit(rig, "hold_lifted")[0].detail).toMatchObject({ cause: "operator_release" });
    expect((await runSettlementReversalPass()).releasesApplied).toBe(0); // idempotent
  });

  it("A: a release, then Stripe REDELIVERS the same charge.refunded: the hold is not re-applied, the replacement key the customer minted is not revoked, and no later daily run lifts anything", async () => {
    const { acct, settlement } = setup();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_first" });
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    at(rig.T0 + 60);
    operatorRuns(releaseFor(settlement, "ch_s9"));
    expect((await runSettlementReversalPass()).releasesApplied).toBe(1);
    expect(acct).toMatchObject({ status: "active", billing_hold: null, key_id: null });
    // the customer mints a new key
    const { POST } = await import("@/app/api/keys/route");
    const minted = await POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: acct.token }) }));
    expect(minted.status).toBe(200);
    const newKey = acct.key_id;
    expect(newKey).not.toBeNull();
    const revokesBefore = revokeCalls(rig).length;
    at(rig.T0 + 3600);
    for (const id of ["evt_first", "evt_second"]) expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id })).status).toBe(200);
    expect(acct).toMatchObject({ status: "active", billing_hold: null, key_id: newKey });
    expect(revokeCalls(rig)).toHaveLength(revokesBefore);
    // and the next days' runs find nothing to lift
    at(rig.T0 + 2 * 86_400);
    expect((await runSettlementReversalPass()).releasesApplied).toBe(0);
    expect(acct.key_id).toBe(newKey);
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
  });

  it("B: a release of an OPEN dispute does not cover its later LOST state: the hold applied for `lost` stands, on this run and every later one", async () => {
    const { acct, settlement } = setup();
    await send(rig, "charge.dispute.created", dispute("needs_response"), { created: rig.T0 });
    expect(acct.billing_hold).toBe("disputed");
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    at(rig.T0 + 60);
    operatorRuns(releaseFor(settlement, "dp_s9"));
    expect((await runSettlementReversalPass()).releasesApplied).toBe(1);
    expect(acct.billing_hold).toBeNull();
    // it goes on to be lost
    at(rig.T0 + 120);
    rig.stripe.pinDispute("dp_s9", dispute("lost"));
    await send(rig, "charge.dispute.closed", dispute("lost"), { created: rig.T0 + 120 });
    expect(acct).toMatchObject({ billing_hold: "disputed", billing_hold_ref: "dp_s9", status: "past_due" });
    for (let day = 1; day <= 3; day++) {
      at(rig.T0 + day * 86_400);
      expect((await runSettlementReversalPass()).releasesApplied).toBe(0);
      expect(acct).toMatchObject({ billing_hold: "disputed", status: "past_due" });
    }
    expect(audit(rig, "hold_lifted")).toHaveLength(1);
  });

  it("B2: the dispute turns `lost` BEFORE the daily run has applied the release of its open state: the release does not lift the lost hold either", async () => {
    const { acct, settlement } = setup();
    await send(rig, "charge.dispute.created", dispute("needs_response"), { created: rig.T0 });
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    at(rig.T0 + 60);
    operatorRuns(releaseFor(settlement, "dp_s9"));
    at(rig.T0 + 120);
    rig.stripe.pinDispute("dp_s9", dispute("lost"));
    await send(rig, "charge.dispute.closed", dispute("lost"), { created: rig.T0 + 120 });
    at(rig.T0 + 3600);
    expect((await runSettlementReversalPass()).releasesApplied).toBe(0);
    expect(acct).toMatchObject({ billing_hold: "disputed", status: "past_due" });
  });

  it("a release written BEFORE a hold began never lifts it, and it is not silent: counted, and the operator is told which release to write again", async () => {
    const { acct, settlement } = setup();
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    operatorRuns(releaseFor(settlement, "ch_s9")); // a release for a hold that does not exist yet
    at(rig.T0 + 60);
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 + 60 });
    at(rig.T0 + 3600);
    const rep = await runSettlementReversalPass();
    expect(rep).toMatchObject({ releasesApplied: 0, releasesIgnored: 1 });
    expect(acct).toMatchObject({ status: "past_due", billing_hold: "refunded" });
    const m = () => operatorMail(rig).filter((x) => /Release IGNORED/.test(x.subject));
    expect(m()).toHaveLength(1);
    expect(m()[0].text).toContain("ch_s9");
    expect(m()[0].text).toMatch(/hold began after it/);
    await runSettlementReversalPass();
    expect(m()).toHaveLength(1); // once per release
  });

  it("a release overtaken by a newer state of the dispute is reported too", async () => {
    const { settlement } = setup();
    await send(rig, "charge.dispute.created", dispute("needs_response"), { created: rig.T0 });
    const { runSettlementReversalPass } = await import("@/lib/payg-refunds");
    at(rig.T0 + 60);
    operatorRuns(releaseFor(settlement, "dp_s9"));
    at(rig.T0 + 120);
    rig.stripe.pinDispute("dp_s9", dispute("lost"));
    await send(rig, "charge.dispute.closed", dispute("lost"), { created: rig.T0 + 120 });
    at(rig.T0 + 3600);
    expect(await runSettlementReversalPass()).toMatchObject({ releasesApplied: 0, releasesIgnored: 1 });
    expect(operatorMail(rig).filter((x) => /Release IGNORED/.test(x.subject) && /newer state/.test(x.text))).toHaveLength(1);
  });

  it("the daily route runs the pass, reports the held accounts, and mails the operator once a day while any stands", async () => {
    setup();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const { GET } = await import("@/app/api/cron/payg/route");
    const run = async () => (await GET(new Request(siteUrl("/api/cron/payg"), { headers: { authorization: "Bearer cron-secret-value" } }))).json();
    const j = await run();
    expect(j.settlement_reversals.heldAccounts).toEqual([{ account_ref: accountRef(ACCOUNT), hold: "refunded", since: expect.any(String) }]);
    await run();
    expect(operatorMail(rig).filter((m) => /accounts on a refund or dispute hold/.test(m.subject))).toHaveLength(1);
  });
});

describe("6. the record is append-only and durable", () => {
  it("the fake store enforces what the migration enforces: a reversal row cannot be edited or deleted, and its dedupe key is unique", async () => {
    setup();
    await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0 });
    const r = await fetch("https://stub.supabase.co/rest/v1/payg_settlement_reversals?kind=eq.refund", { method: "PATCH", headers: { apikey: "x", "content-type": "application/json" }, body: JSON.stringify({ amount_cents: 0 }) });
    expect(r.status).toBe(403);
    expect(reversals()[0].amount_cents).toBe(10_000);
    expect(() => rig.db.insertRow("payg_settlement_reversals", { dedupe_key: "refund:ch_s9:10000" })).toThrow(/duplicate/);
  });

  it("migration 0043 not applied: the access decision is still applied, the event is answered 500 (Stripe retries), the operator is told once; once the table exists the retry records it", async () => {
    const { acct } = setup();
    rig.db.dropTable("payg_settlement_reversals");
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_m" })).status).toBe(500);
    expect(acct).toMatchObject({ status: "past_due", billing_hold: "refunded" });
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_m" })).status).toBe(500);
    expect(operatorMail(rig).filter((m) => /Migration 0043/.test(m.subject))).toHaveLength(1);
    rig.db.createTable("payg_settlement_reversals");
    rig.db.uniqueKeys.set("payg_settlement_reversals", [["dedupe_key"]]);
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_m" })).status).toBe(200);
    expect(reversals()).toHaveLength(1);
    expect(revokeCalls(rig)).toEqual(["keyPAYG1"]);
  });

  it("migration 0043 not applied: a PARTIAL refund (no access decision) is acknowledged, not 500-looped, and the operator's mail is its record; a full one still waits for the table", async () => {
    const { acct } = setup();
    rig.db.dropTable("payg_settlement_reversals");
    expect((await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0, id: "evt_p" })).status).toBe(200);
    expect(acct.billing_hold ?? null).toBeNull();
    const m = operatorMail(rig).filter((x) => /partly refunded/.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/NOT RECORDED/);
    expect(operatorMail(rig).filter((x) => /Migration 0043/.test(x.subject))).toHaveLength(1);
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_f" })).status).toBe(500);
    expect(acct.billing_hold).toBe("refunded");
  });

  it("migration 0043 not applied AND the operator mail cannot be delivered: the acknowledged partial refund is retried (500) until the mail goes, because the mail is its only record", async () => {
    const { acct } = setup();
    rig.db.dropTable("payg_settlement_reversals");
    const inner = globalThis.fetch;
    let mailUp = false;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
      if (url.startsWith("https://api.resend.com") && !mailUp) return new Response("{}", { status: 503 });
      return inner(i as RequestInfo, init);
    }) as typeof fetch;
    try {
      expect((await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0, id: "evt_p" })).status).toBe(500);
      mailUp = true;
      expect((await send(rig, "charge.refunded", refunded(2_500), { created: rig.T0, id: "evt_p" })).status).toBe(200);
    } finally {
      globalThis.fetch = inner;
    }
    expect(operatorMail(rig).filter((x) => /partly refunded/.test(x.subject))).toHaveLength(1);
    expect(acct.billing_hold ?? null).toBeNull();
  });

  it("a store failure while recording answers 500 and records nothing twice on the retry", async () => {
    const { acct } = setup();
    rig.db.failMethod = { method: "POST", status: 503, body: JSON.stringify({ message: "outage" }) };
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_f" })).status).toBe(500);
    rig.db.failMethod = null;
    expect(acct.billing_hold ?? null).toBeNull();
    expect((await send(rig, "charge.refunded", refunded(10_000), { created: rig.T0, id: "evt_f" })).status).toBe(200);
    expect(reversals()).toHaveLength(1);
    expect(acct.billing_hold).toBe("refunded");
  });
});
