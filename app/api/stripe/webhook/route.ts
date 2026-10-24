import { SITE_URL, siteUrl } from "@/lib/site";
import { storeFault } from "@/lib/safe-log";
import { notifyOperator } from "@/lib/mail";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createDeliverable, deliverableBySession } from "@/lib/deliverables";
import { abandonPendingNotices, createWatch, updateWatch, watchBySubscription, type WatchRecord } from "@/lib/watches";
import { INTELLIGENCE_PLANS, PRODUCTS, PRODUCT_BY_KIND, isApiProduct } from "@/lib/products";
import { accountRef } from "@/lib/payg";
import { notifyOperatorOnce, operatorMailExpected } from "@/lib/payg-operator";
import { handlePaygCardUpdate, handlePaygEnable, handlePaygInvoice } from "@/lib/payg-billing";
import { recordFunnelEvent } from "@/lib/funnel";
import { pg } from "@/lib/payg-store";
import { paygStripe } from "@/lib/payg-stripe";
import {
  cancelApiAccount,
  confirmRevoked,
  createApiAccount,
  findBySubscription,
  keyLife,
  retryRevocationsFor,
  revokeOnEngineDetailed,
  type ApiAccount,
} from "@/lib/api-access";
import { recordSubscription, subscriptionBySession, updateSubscription, type SubscriptionRecord } from "@/lib/subscribers";
import {
  billingEventIsCurrent,
  clockedWrite,
  endedRow,
  enforceGraceRow,
  isFullRefund,
  isOurSubscriptionKind,
  liftedByEvent,
  liftHold,
  noteUnconfirmedRevocation,
  resolveSubscription,
  reversePayment,
  subscriptionIdOf,
  subscriptionOfPayment,
  writeApi,
  writeIntelligence,
  writeWatch,
  type ReversalStripe,
  type Resolved as ResolvedResult,
} from "@/lib/billing-holds";
import { reconcileDispute } from "@/lib/billing-disputes";
import { applyPauseState, extendScheduledPause, reassertPause, type PausedSub } from "@/lib/billing-pause";
import { cents, reverseSettlement, settlementRefOf } from "@/lib/payg-refunds";
import { depositBySession, recordDeposit } from "@/lib/deposits";
import { depositTerms } from "@/lib/engagement-state";
import { notifyCustomer } from "@/lib/notifications";
import { attachPurchase, isProjectAttachable, purchaseObjectType } from "@/lib/projects";

export const runtime = "nodejs";

// Stripe webhook. Verifies the signature (so events can't be forged), then on
// checkout.session.completed marks the matching lead deposit_paid in Supabase
// and emails the founder. Reads the raw body — required for signature checks.
/**
 * A payment we could not fulfil must not be reported to Stripe as delivered.
 *
 * Stripe treats a 2xx as done and never redelivers. So the old shape — log the
 * failure, return, fall through to a 200 — turned a failed write into a permanent
 * orphan: the customer had paid between EUR 4,500 and EUR 95,000, and there was no
 * engagement row, no intake link and nothing in the admin dashboard. The only
 * trace was a log line nobody was watching.
 *
 * A 500 makes Stripe redeliver, and every open* helper above checks for its own
 * prior row first, so a replay is a no-op rather than a second fulfilment.
 */
function fulfilmentFailed(what: string, sessionId: string) {
  console.error(
    `[GridForge] ${what} NOT fulfilled for session ${sessionId}; asking Stripe to retry`
  );
  return NextResponse.json(
    { ok: false, error: "Purchase could not be fulfilled" },
    { status: 500 }
  );
}

/**
 * Has this Checkout Session been PAID? Fails closed.
 *
 *   "paid" | "no_payment_required"  -> true  (a card payment that settled; a setup-mode or free session that owes nothing)
 *   "unpaid"                        -> false (a delayed method that has not settled: fulfilled at checkout.session.async_payment_succeeded)
 *   any other string                -> false (a status we do not know is never read as money received); logged, acknowledged unfulfilled
 *   absent / null / not a string    -> THROWS
 *
 * Stripe puts `payment_status` on every Checkout Session it sends, so an event without one is malformed (a hand-built payload, a
 * truncated body, an API shape we do not understand). It is neither "paid" nor "unpaid", and the two wrong answers are both bad:
 * reading it as paid fulfils a sale nobody paid for (what this function used to do), and acknowledging it with a 200 would make
 * Stripe stop redelivering a REAL payment whose payload we merely could not read, so a paying customer would be left with nothing
 * and no retry. So it throws: the route answers 500, nothing is fulfilled or recorded, and Stripe redelivers (and shows the failing
 * endpoint to the operator) until the payload can be read. The error carries only the session id, never buyer data.
 */
class MalformedCheckoutSessionError extends Error {
  constructor(sessionId: unknown) {
    super(`checkout session ${typeof sessionId === "string" ? sessionId : "(no id)"} has no payment_status; refusing to read it as paid or unpaid`);
    this.name = "MalformedCheckoutSessionError";
  }
}

function checkoutIsPaid(session: Stripe.Checkout.Session): boolean {
  const ps = session.payment_status as unknown;
  if (typeof ps !== "string" || ps === "") {
    console.error(`[GridForge] checkout ${String(session.id)} arrived WITHOUT payment_status; not fulfilled, answering 500 so Stripe redelivers`);
    throw new MalformedCheckoutSessionError(session.id);
  }
  return ps === "paid" || ps === "no_payment_required";
}

export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whSecret) {
    return NextResponse.json({ ok: false, error: "Webhook not configured" }, { status: 503 });
  }
  const stripe = new Stripe(key);

  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig ?? "", whSecret);
  } catch (err) {
    console.error("[GridForge] Stripe signature verify failed:", err);
    return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 400 });
  }

  // A checkout that has not been PAID is not a sale. Card checkout completes only once paid, but a delayed method (a bank debit or
  // transfer) completes with payment_status "unpaid" and settles days later, or fails: fulfilling at completion would hand a key, an
  // intake or a subscription to somebody whose money never arrives. The sale is fulfilled when it is paid: either at completion
  // (payment_status paid, or no_payment_required for a setup or a free checkout) or, for a delayed method, at
  // checkout.session.async_payment_succeeded. async_payment_failed fulfils nothing. A payload with NO payment_status (Stripe always
  // sends one) is malformed: checkoutIsPaid throws and the route answers 500, so nothing is fulfilled and Stripe redelivers.
  if (event.type === "checkout.session.async_payment_failed") {
    const failed = event.data.object as Stripe.Checkout.Session;
    console.error(`[GridForge] checkout payment FAILED after completion; nothing fulfilled: session ${failed.id} (kind ${String(failed.metadata?.kind ?? "-")})`);
    return NextResponse.json({ ok: true, received: true });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (!checkoutIsPaid(session)) {
      const ps = String(session.payment_status);
      if (ps === "unpaid") {
        console.log(`[GridForge] checkout ${session.id} completed with payment_status ${ps}; not fulfilled until it is paid (checkout.session.async_payment_succeeded)`);
      } else {
        // A value Stripe has never been seen to send (or one this site does not know): a sale that may be PAID is not being fulfilled. The 200
        // stays (a retry cannot change the payload), but a person is told, once per session and value, with the session id to look up.
        console.error(`[GridForge] checkout ${session.id} completed with an UNKNOWN payment_status ${ps.slice(0, 40)}; NOT fulfilled (acknowledged)`);
        const told = await notifyOperatorOnce(
          `payment_status_unknown:${session.id}:${ps.slice(0, 40)}`,
          "A Stripe checkout arrived with a payment_status this site does not know — NOT fulfilled",
          `Checkout session ${session.id} (kind ${String(session.metadata?.kind ?? "-")}) completed with payment_status "${ps.slice(0, 40)}". Only "paid" and "no_payment_required" are fulfilled and "unpaid" waits for ` +
            "checkout.session.async_payment_succeeded; anything else is acknowledged WITHOUT fulfilment. If the customer has paid, look the session up in Stripe and fulfil it by hand. This notice is sent once per session and value."
        );
        // The mail is the only trace of a sale that may be paid: if it could not be delivered, Stripe retries the event (and the claim was released).
        if (told === "unsent" && operatorMailExpected()) return lifecycleRetry("unknown payment_status (operator mail not delivered)", session.id);
      }
      return NextResponse.json({ ok: true, received: true, fulfilled: false });
    }
    const email = session.customer_email || session.customer_details?.email || "";
    const company = (session.metadata?.company as string) || "";
    const amount = session.amount_total ?? 0;

    const kind = (session.metadata?.kind as string) || "engagement_deposit";

    // Same best-effort AI-origin tag as app/api/checkout/route.ts's
    // ai_checkout_started: `service` carries the `workspace-<productId>` context
    // the AI workspace's commercialAction CTA set at checkout start, so a
    // completion can be attributed back to that same session without any new
    // session-tracking infrastructure.
    const service = (session.metadata?.service as string) || "";
    if (service.startsWith("workspace-")) {
      console.log("[GridForge] ai_checkout_completed", {
        kind,
        service,
        sessionId: session.id,
        amount,
      });
    }
    const product = PRODUCT_BY_KIND[kind];
    if (kind === "api_payg_enable") {
      // A card saved for pay-as-you-go (Checkout mode "setup": nothing was charged). Absolute, replay-safe writes; a failed
      // read or write answers 500 so Stripe redelivers (lib/payg-billing.ts).
      const applied = await handlePaygEnable(session, paygStripe());
      if (!applied.ok) return fulfilmentFailed("pay-as-you-go enable", session.id);
    } else if (kind === "api_payg_card_update") {
      // The card on file was replaced (setup mode on the existing customer; nothing was charged).
      const applied = await handlePaygCardUpdate(session, paygStripe());
      if (!applied.ok) return fulfilmentFailed("pay-as-you-go card update", session.id);
    } else if (isApiProduct(kind)) {
      // Metered API access. No intake, no engineering work, no human: the
      // subscription becomes a signed key the engine can verify offline, and the
      // customer is on their own machine-callable endpoint within seconds. That
      // immediacy is the product; a key that arrives tomorrow is a lost customer.
      const opened = await openApiAccount({
        kind,
        email,
        company,
        units: product?.apiUnits ?? 0,
        customerId: typeof session.customer === "string" ? session.customer : null,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      });
      if (!opened) return fulfilmentFailed("api account", session.id);
      if (opened === "created") await notifyFounder({ email, company, amount });
      // Adoption funnel: the product kind only (never the buyer), once per Stripe subscription however often this is delivered.
      await recordFunnelEvent("subscription_started", { kind }, { dedupeKey: `subscription_started:${typeof session.subscription === "string" ? session.subscription : session.id}` });
    } else if (kind === "hall_watch") {
      const opened = await openWatch({
        email,
        company,
        sessionId: session.id,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        customerId: typeof session.customer === "string" ? session.customer : null,
      });
      if (!opened) return fulfilmentFailed("hall watch", session.id);
      if (opened === "created") await notifyFounder({ email, company, amount });
      await recordFunnelEvent("subscription_started", { kind }, { dedupeKey: `subscription_started:${typeof session.subscription === "string" ? session.subscription : session.id}` });
      const subId = typeof session.subscription === "string" ? session.subscription : null;
      const attachedWatch = await attachToProject(session, kind, amount, async () =>
        subId ? (await watchBySubscription(subId))?.id ?? null : null
      );
      if (attachedWatch) return attachedWatch;
    } else if (product?.producesDeliverable) {
      // A purchased engineering deliverable. Paying does not produce a document:
      // it opens an intake the client fills in, which is then generated and
      // released by a human. See lib/deliverables.ts.
      const opened = await openDeliverable({
        kind,
        email,
        company,
        amount,
        sessionId: session.id,
        qualificationId: (session.metadata?.qualification_id as string) || null,
      });
      if (!opened) return fulfilmentFailed("engagement", session.id);
      if (opened === "created") await notifyFounder({ email, company, amount });
      // Adoption funnel: that an engagement was commissioned, and which product (a catalogue kind); never who or how much.
      await recordFunnelEvent("engagement_commissioned", { kind }, { dedupeKey: `engagement_commissioned:${session.id}` });
      const attachedDeliverable = await attachToProject(session, kind, amount, async () =>
        (await deliverableBySession(session.id))?.id ?? null
      );
      if (attachedDeliverable) return attachedDeliverable;
    } else if (kind === "intelligence_subscription") {
      // The subscription id is what makes cancellation possible later. Storing
      // only the session and customer ids — which is what this did — left
      // customer.subscription.deleted with nothing to resolve against, so a
      // cancelled Intelligence plan would have stayed active forever.
      const plan = (session.metadata?.plan as string) || "unknown";
      const existedBefore = typeof session.id === "string" ? await subscriptionBySession(session.id) : null;
      const row = await recordSubscription({
        email,
        plan,
        sessionId: session.id,
        customerId: typeof session.customer === "string" ? session.customer : null,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      });
      if (row && row.status === "superseded") {
        // Paid for by a DIFFERENT Stripe customer than the subscription already entitling this address: it entitles nothing and
        // supersedes nothing (the typed email proves nothing about who owns it). A person decides: refund, or merge deliberately.
        if (!existedBefore) {
          await notifyOperator(
            `Intelligence purchase NOT entitled — ${row.email} already has an active subscription`,
            `Stripe subscription ${row.stripe_subscription_id ?? "-"} (plan ${plan}, customer ${row.stripe_customer_id ?? "-"}) was paid for with ${row.email}, ` +
              `which already has an active Intelligence subscription under a different Stripe customer. The existing subscription and its seats were NOT changed ` +
              `and the new purchase entitles nothing. If this is the same person upgrading, cancel the old subscription in Stripe and ask them to sign in; ` +
              `if not, cancel and refund the new one.`
          );
        }
      } else if (row) {
        // The operator hears of a NEW subscriber once, not on every Stripe redelivery; the customer's welcome
        // is a durable obligation of its own (a failed email never touches the paid subscription).
        if (!existedBefore) await notifyOperator("New Intelligence subscriber", `Plan: ${plan}. Subscription record ${row.id}.`);
        await recordFunnelEvent("subscription_started", { kind: "intelligence_subscription", plan }, { dedupeKey: `subscription_started:${typeof session.subscription === "string" ? session.subscription : session.id}` });
        if ((await notifyCustomer("subscription_welcome", row.id, "", { replay: Boolean(existedBefore) })) === "retry_webhook") {
          return fulfilmentFailed("subscription notification", session.id);
        }
      } else {
        // Do not welcome somebody to a subscription we failed to record. Return a
        // 500 so Stripe retries the event, and recordSubscription() is idempotent
        // on the session id so the retry cannot double-issue.
        console.error(
          "[GridForge] intelligence subscription NOT recorded; asking Stripe to retry: session",
          session.id
        );
        return NextResponse.json(
          { ok: false, error: "Subscription could not be recorded" },
          { status: 500 }
        );
      }
    } else {
      // A deposit opens no object; for a project's Envelope Study deposit the event alone
      // records it. Done BEFORE the deposit bookkeeping so a transient failure retries a clean slate.
      const attachedDeposit = await attachToProject(session, kind, amount, async () => null);
      if (attachedDeposit) return attachedDeposit;
      // The durable record comes FIRST and decides the response: a deposit is a EUR 9,000-15,000 promise
      // to do scoped work, and the lead bookkeeping below can no more be its only trace than the
      // founder email can. A failed write answers 500 so Stripe redelivers (the unique session id
      // makes the retry a no-op once it has landed).
      const recorded = await recordDeposit({
        sessionId: session.id,
        kind,
        amountCents: amount,
        currency: session.currency ?? null,
        email,
        company,
        projectId: (session.metadata?.project_id as string) || "",
      });
      if (!recorded.ok) {
        console.error("[GridForge] deposit NOT recorded; asking Stripe to retry:", session.id, recorded.error);
        return NextResponse.json({ ok: false, error: "Deposit could not be recorded" }, { status: 500 });
      }
      // Mark the most recent matching lead deposit_paid (match by email, newest first). Best effort.
      await markDepositPaid({ email, company, amount, sessionId: session.id });
      // The paid deposit now counts the Founding slot by itself; the reservation that held it is released (best effort: an
      // unreleased one expires on its own and only ever errs towards fewer credits).
      const reserved = (session.metadata?.founding_reservation as string) || "";
      if (/^[0-9a-f-]{36}$/i.test(reserved)) await pg("DELETE", `founding_reservations?id=eq.${reserved}`, undefined, "return=minimal");
      // One email per payment, not one per redelivery.
      if (recorded.created) await notifyFounder({ email, company, amount });
      await recordFunnelEvent("engagement_commissioned", { kind }, { dedupeKey: `engagement_commissioned:${session.id}` });
      // The buyer's own receipt of what the deposit states: a durable obligation of its own (one per deposit, redelivery-safe),
      // for the deposits this site sells. A redelivery retries it if it never went out.
      if (depositTerms(kind)) {
        const dep = await depositBySession(session.id);
        if (!dep) return fulfilmentFailed("deposit receipt (record unreadable)", session.id);
        if ((await notifyCustomer("deposit_receipt", dep.id, "", { replay: !recorded.created })) === "retry_webhook") {
          return fulfilmentFailed("deposit receipt", session.id);
        }
      }
    }
  }

  // ---- subscription lifecycle ------------------------------------------------------------------------
  // THREE things are sold on a Stripe subscription: metered API access (api_accounts), Hall Watch
  // (watches) and GridForge Intelligence (subscriptions). Every event below resolves ALL THREE, and it
  // is acknowledged only once everything it required has been durably applied: a failed read or write
  // answers 500 so Stripe redelivers. Every write here sets an absolute state, so a redelivery is safe.
  // (A store outage used to be read as "no such account" and a failed write was ignored, so a
  // cancellation could be acknowledged without ever being applied — a cancelled customer's account
  // stayed active and could mint fresh keys indefinitely.)
  // Counted when Stripe sends them (the webhook endpoint must be subscribed to charge.refunded and charge.dispute.created, which this site
  // cannot verify): an amount and, for a dispute, Stripe's own reason code. Never the customer, the charge's description or its metadata.
  // A payment that is taken back stops paid access as well as being counted (lib/billing-holds.ts): a charge refunded IN FULL, or
  // disputed, whose invoice belongs to a subscription suspends what that subscription entitles (API key revoked and minting refused,
  // Hall Watch paused, Intelligence not entitled), reversibly, with an audit row. A partial refund only counts. The charge is traced to its
  // subscription through the Stripe objects in the event, falling back to Stripe itself; a lookup that fails answers 500 so Stripe redelivers.
  // A refund or dispute of a pay-as-you-go MONTHLY SETTLEMENT invoice (no subscription behind it) is recorded as an append-only event
  // linked to the settlement and, in full / when the dispute stands, suspends further pay-as-you-go use the same reversible way; a
  // partial refund is recorded and mailed, nothing more (lib/payg-refunds.ts). The usage ledger is never touched.
  if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    await recordFunnelEvent("refund_issued", { amount_cents: ch.amount_refunded ?? 0 }, { dedupeKey: `refund_issued:${ch.id}:${ch.amount_refunded ?? 0}` });
    const stripeClient = reversalStripe();
    // Which payment is it? (A partial refund asks too: a refund of a settlement invoice is recorded whatever its size.)
    const owner = await subscriptionOfPayment(stripeClient, { invoice: (ch as unknown as { invoice?: unknown }).invoice, paymentIntent: ch.payment_intent });
    if (!owner.ok) return lifecycleRetry("refund (payment could not be resolved to its subscription)", ch.id);
    const settlement = settlementRefOf(owner);
    if (settlement !== null) {
      const recorded = await reverseSettlement({
        s: settlement,
        ev: { kind: "refund", ref: ch.id, full: isFullRefund(ch), refundedCents: cents(ch.amount_refunded), chargeCents: cents(ch.amount) },
        eventId: event.id,
        created: event.created,
      });
      if (!recorded.ok) return lifecycleRetry(`settlement refund (${recorded.why})`, ch.id);
    } else if (isFullRefund(ch)) {
      const held = await reversePayment({ kind: "refunded", ref: ch.id, stripe: stripeClient, eventId: event.id, created: event.created, owner });
      if (!held.ok) return lifecycleRetry(`refund (${held.why})`, ch.id);
    }
  }
  if (event.type === "charge.dispute.created") {
    const d = event.data.object as Stripe.Dispute;
    await recordFunnelEvent("dispute_opened", { amount_cents: d.amount ?? 0, ...(typeof d.reason === "string" && /^[a-z_]{1,40}$/.test(d.reason) ? { reason: d.reason } : {}) }, { dedupeKey: `dispute_opened:${d.id}` });
  }
  // A dispute has an evidence deadline that is real money (the amount is debited at once and lost if nobody answers in time), so the operator
  // is MAILED when one opens and when it closes, not left to find a funnel counter.
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    await disputeNotice(event.type === "charge.dispute.closed", event.data.object as Stripe.Dispute);
  }
  // A real chargeback (not a warning inquiry, where no money has moved) suspends paid access; it is lifted only if Stripe says it was won.
  // The three events (created, updated, closed) arrive in any order and are redelivered, so NONE of them is trusted for the dispute's
  // state: each asks Stripe what the dispute is NOW and decides from that (lib/billing-disputes.ts). A stale created/updated after the
  // dispute is over cannot create a hold; a closed (won) before its created leaves none; a lost dispute applies the hold once.
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated" || event.type === "charge.dispute.closed") {
    const d = event.data.object as Stripe.Dispute;
    const out = await reconcileDispute({ payload: d as never, stripe: reversalStripe(), eventId: event.id, created: event.created });
    if (!out.ok) return lifecycleRetry(`dispute (${out.why})`, d.id);
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const found = await resolveSubscription(sub.id);
    if (!found.ok) return lifecycleRetry("cancellation (lookup failed)", sub.id);
    const out = await applyCancellation(sub, found);
    if (out) return out;
  }

  // A plan switch, a pause or a cancellation made in the Stripe Billing Portal (or the Dashboard) arrives here and nowhere else.
  if (event.type === "customer.subscription.updated") {
    const out = await applySubscriptionUpdate(event.data.object as Stripe.Subscription, { id: event.id, created: event.created });
    if (out) return out;
  }

  // Pay-as-you-go month-end invoices carry metadata.kind === "payg_settlement" and no subscription: they are settled against their
  // usage_settlements row (paid is terminal against a late failed), never against a subscription (lib/payg-billing.ts).
  if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
    const payg = await handlePaygInvoice(event);
    if (payg) {
      if (!payg.ok) return lifecycleRetry(`pay-as-you-go invoice event (${payg.why})`, (event.data.object as Stripe.Invoice).id ?? "unknown");
      return NextResponse.json({ ok: true, received: true });
    }
  }

  if (event.type === "invoice.payment_failed") {
    const subId = subscriptionIdOf(event.data.object as Stripe.Invoice);
    if (subId) {
      const found = await resolveSubscription(subId);
      if (!found.ok) return lifecycleRetry("payment failure (lookup failed)", subId);
      let applied = true;
      // Only an ACTIVE entitlement moves. A late failure notice must never reopen a cancelled account
      // (past_due can still mint keys) or demote something already ended. Nor may it override a LATER event already applied:
      // events are not delivered in order, so a failure older than the payment that cleared it is ignored.
      // The SAME ordering rule holds for all three entitlements (migration 0039 gave watches and subscriptions the clock api_accounts had).
      // A failure that is current but finds the row already failed (paused / past_due) still advances the clock, so a payment older than
      // THAT failure, delivered late, cannot reinstate it.
      if (found.api && !endedRow(found.api) && billingEventIsCurrent(found.api, event.created, "failed")) {
        const clock = event.created ? { last_billing_event_ts: event.created } : {};
        let ok: boolean;
        let since = found.api.past_due_since ?? null;
        if (found.api.status === "active") {
          // The FIRST failure of an episode starts the grace (API_PAST_DUE_GRACE_DAYS): the minted key keeps working until it ends. If the
          // store lacks the column (migration 0041 not applied) the status is still written, and the daily pass starts the grace when it
          // first sees the row.
          since = new Date(event.created ? event.created * 1000 : Date.now()).toISOString();
          ok = (await writeApi(found.api.token, { status: "past_due", past_due_since: since, ...clock })) ||
            (await writeApi(found.api.token, { status: "past_due", ...clock }));
        } else {
          ok = event.created ? await writeApi(found.api.token, clock) : true;
        }
        if (!ok) applied = false;
        // A later failure of the SAME episode (Stripe retries) after the grace has run out revokes the live key now rather than at the
        // next daily pass. A held account was cut off already (its hold revoked the key).
        else if (!found.api.billing_hold) {
          const g = await enforceGraceRow({ ...found.api, status: "past_due", past_due_since: since }, Date.now(), event.id);
          if (!g.ok) applied = false;
        }
      }
      // "paused", not "cancelled": Stripe retries, and a card that fails on Tuesday and clears on
      // Thursday should not have cost the client a quarter.
      if (found.watch && !endedRow(found.watch) && billingEventIsCurrent(found.watch, event.created, "failed")) {
        const patch: Partial<WatchRecord> = found.watch.status === "active" ? { status: "paused" } : {};
        if (!(await clockedWrite((p) => writeWatch(found.watch!.token, p), patch, event.created))) applied = false;
      }
      if (found.intelligence && (found.intelligence.status === "active" || found.intelligence.status === "past_due") && billingEventIsCurrent(found.intelligence, event.created, "failed")) {
        const patch: Partial<SubscriptionRecord> = found.intelligence.status === "active" ? { status: "past_due" } : {};
        if (!(await clockedWrite((p) => writeIntelligence(found.intelligence!.id, p), patch, event.created))) applied = false;
      }
      if (!applied) return lifecycleRetry("payment failure (write failed)", subId);
      // A revocation the engine has not confirmed is retried with the next billing event for the account, not only by the daily job.
      if (found.api?.revocation_pending) await retryRevocationsFor(found.api.token);
      // Once per invoice however many times Stripe retries and reports it.
      await recordFunnelEvent("payment_failed", { kind: "subscription" }, { dedupeKey: `payment_failed:${(event.data.object as Stripe.Invoice).id ?? subId}` });
    }
  }

  if (event.type === "invoice.paid") {
    const paidInvoice = event.data.object as Stripe.Invoice;
    const subId = subscriptionIdOf(paidInvoice);
    if (subId) {
      const found = await resolveSubscription(subId);
      if (!found.ok) return lifecycleRetry("renewal (lookup failed)", subId);
      let applied = true;
      let remind: ApiAccount | null = null;
      // A later verified payment, for a DIFFERENT invoice than the one that was refunded or disputed, ends that hold (the customer paid
      // again). A paused hold is not a payment matter and is lifted only by the update that resumes billing. An older payment, or the
      // same invoice, lifts nothing (the clock and the invoice id say so), and a row that is still held takes no state from this event.
      const lift = await liftHold(found, { kinds: ["refunded", "disputed"], notInvoice: paidInvoice.id, paidCents: paidInvoice.amount_paid, restore: "active", cause: "invoice_paid", subscriptionId: subId, eventId: event.id, created: event.created });
      if (!lift.ok) return lifecycleRetry("renewal (hold could not be lifted)", subId);
      // A payment for a period that ends after a scheduled pause starts moves the pause to the end of that period (order-independent: a maximum).
      if (!(await extendScheduledPause(found, paidInvoice as never, { id: event.id }))) return lifecycleRetry("renewal (scheduled pause could not be extended)", subId);
      const apiHeld = Boolean(found.api?.billing_hold) && !lift.lifted.api;
      const watchHeld = Boolean(found.watch?.billing_hold) && !lift.lifted.watch;
      if (found.api && found.api.status !== "cancelled" && !apiHeld && billingEventIsCurrent(found.api, event.created, "paid")) {
        const clock = event.created ? { last_billing_event_ts: event.created } : {};
        // The grace is over when a payment clears; the key revoked at its end stays revoked and the customer mints a new one.
        const clearing = found.api.status === "past_due" || found.api.past_due_since ? { past_due_since: null } : {};
        const ok = (await writeApi(found.api.token, { status: "active", ...clearing, ...clock })) ||
          (Object.keys(clearing).length > 0 && (await writeApi(found.api.token, { status: "active", ...clock })));
        if (!ok) applied = false;
        else remind = found.api;
      }
      // A watch paused by a failed payment comes back when the payment clears. A cancelled one does
      // not come back by itself — that is a new sale.
      // The payment is RECORDED even when nothing changes state (an active watch), so a failure that was older than it and is delivered
      // after it finds the clock ahead and changes nothing.
      if (found.watch && found.watch.status !== "cancelled" && !watchHeld && billingEventIsCurrent(found.watch, event.created, "paid") && (found.watch.status === "paused" || typeof event.created === "number")) {
        if (!(await clockedWrite((p) => writeWatch(found.watch!.token, p), { status: "active" as const }, event.created))) applied = false;
      }
      // Same rule for Intelligence: a payment that clears reinstates access that a failed payment had
      // put past_due. A cancelled one stays cancelled.
      if (found.intelligence && (found.intelligence.status === "active" || found.intelligence.status === "past_due") && billingEventIsCurrent(found.intelligence, event.created, "paid") && (found.intelligence.status === "past_due" || typeof event.created === "number")) {
        if (!(await clockedWrite((p) => writeIntelligence(found.intelligence!.id, p), { status: "active" as const }, event.created))) applied = false;
      }
      // A payment cleared for a subscription that a NEWER purchase superseded: the buyer re-bought (an upgrade,
      // or simply a second click) and the old Stripe subscription is still billing them. Nothing here may
      // cancel it (that is money moved on a customer's behalf), and it must not revive the superseded
      // entitlement; the operator is told, with the ids, so it is cancelled and refunded deliberately.
      if (found.intelligence && found.intelligence.status === "superseded") {
        await notifyOperator(
          `Superseded Intelligence subscription is still billing — ${found.intelligence.email}`,
          `A payment cleared on Stripe subscription ${subId} for ${found.intelligence.email}, but a newer Intelligence ` +
            `purchase replaced it, so it entitles nothing and the customer is paying twice.\n\n` +
            `Cancel ${subId} in the Stripe Dashboard and decide on a refund for the invoice. ` +
            `This notice repeats on every renewal until it is cancelled.`
        );
      }
      if (!applied) return lifecycleRetry("renewal (write failed)", subId);
      // A hold that replaced a pause is gone and the writes above restored what the rows were before; if billing is STILL paused at Stripe the
      // pause goes back (the hold now, or the schedule) instead of access returning with no payment. After the writes, so it has the last word.
      if (lift.lifted.api || lift.lifted.watch || lift.lifted.intelligence || (await liftedByEvent(event.id))) {
        if (!(await reassertPause(subId, reversalStripe(), { id: event.id })).ok) return lifecycleRetry("renewal (pause could not be re-checked)", subId);
      }
      if (found.api?.revocation_pending) await retryRevocationsFor(found.api.token);
      // The payment renewed. The KEY does not — it is a signed token with a fixed expiry, and nothing
      // can extend one in place. Tell the customer while there is still a working key to replace
      // (after the writes, so a retried event does not email twice). A key is shown once and never
      // stored, so the email carries the portal link, not a key.
      if (remind) await remindToRotate(remind);
    }
  }

  return NextResponse.json({ ok: true, received: true });
}

type Resolved = Extract<ResolvedResult, { ok: true }>;

/**
 * A subscription that has ended on Stripe's side: every entitlement it carried is cancelled, in absolute state, idempotently.
 * Used for customer.subscription.deleted and for customer.subscription.updated when the status has become canceled, unpaid or
 * incomplete_expired (a portal cancellation or an exhausted dunning cycle, which can arrive before or without a .deleted).
 * Returns a Response when the event must be retried or is acknowledged early, null to carry on.
 */
async function applyCancellation(sub: Stripe.Subscription, found: Resolved): Promise<NextResponse | null> {
  if (!found.api && !found.watch && !found.intelligence) {
    // One of ours with no record yet may simply have arrived before its checkout event: retry.
    // Anything else is somebody else's subscription on the same Stripe account: acknowledge.
    if (isOurSubscriptionKind(sub.metadata?.kind)) return lifecycleRetry("cancellation (no record yet)", sub.id);
    console.warn("[GridForge] cancellation for a subscription that is not ours; ignored:", sub.id);
    return NextResponse.json({ ok: true, received: true });
  }
  let applied = true;
  if (found.api) {
    // The revoked set is built from a FRESH read, compare-and-set on the key id (cancelApiAccount): a key minted between this event's
    // lookup and its write is the live key, and it is in the set.
    const done = await cancelApiAccount(found.api.token);
    if (!done.ok) applied = false;
    else {
      // An engine that is unreachable, or that does not serve /v1/revoke yet, must not turn a cancellation that HAS been recorded into an
      // endlessly redelivered event, and must not be forgotten either: every id is already in revoked_key_ids, and what the engine does
      // not confirm stays a durable obligation (revocation_pending) that the daily sweep and the next billing event push again, that the
      // operator is told about once per account, and that /api/admin/stripe-health lists.
      // Every id we ever superseded is pushed too (a rotation or overlap mint may not have been confirmed
      // by the engine), plus the live one. Each is attempted independently; the ids stay recorded.
      const confirmedIds: string[] = [];
      const unconfirmed: { id: string; reason: string }[] = [];
      for (const id of done.revoked) {
        const out = await revokeOnEngineDetailed(id);
        if (out.ok) confirmedIds.push(id);
        else unconfirmed.push({ id, reason: out.reason });
      }
      // What the engine confirmed is recorded; the rest stays unconfirmed and the daily sweep keeps pushing it.
      await confirmRevoked(done.row.token, confirmedIds);
      if (unconfirmed.length) await noteUnconfirmedRevocation(done.row, unconfirmed, "subscription cancelled", sub.id);
      console.log(
        `[GridForge] api account ${done.row.account} cancelled; key id ${done.row.key_id ?? "-"}: ` +
          (unconfirmed.length ? `${unconfirmed.length} revocation(s) NOT confirmed by the engine, kept pending` : "every revocation confirmed by the engine")
      );
    }
  }
  if (found.watch) {
    if (!(await updateWatch(found.watch.token, { status: "cancelled" }))) applied = false;
    else {
      console.log(`[GridForge] hall watch ${found.watch.id} cancelled; scheduled runs stop`);
      // A change note already queued for an email is not sent to somebody who has cancelled.
      await abandonPendingNotices(found.watch.id, "watch_not_active");
    }
  }
  if (found.intelligence) {
    if (!(await updateSubscription(found.intelligence.id, { status: "cancelled" }))) applied = false;
    else console.log(`[GridForge] intelligence subscription ${found.intelligence.id} cancelled; /account drops to the free view`);
  }
  if (!applied) return lifecycleRetry("cancellation (write failed)", sub.id);
  // Adoption funnel: which kind of subscription ended, and Stripe's own stated reason when it gives one (a fixed vocabulary, never a
  // free-text field: cancellation_details.comment is deliberately NOT read). Once per Stripe subscription however it ended.
  const stated = sub.cancellation_details?.reason;
  const reason = stated === "cancellation_requested" || stated === "payment_failed" || stated === "payment_disputed" ? stated : undefined;
  const endedKind = found.api ? found.api.plan : found.watch ? "hall_watch" : "intelligence_subscription";
  await recordFunnelEvent("subscription_cancelled", { kind: endedKind, ...(reason ? { reason } : {}) }, { dedupeKey: `subscription_cancelled:${sub.id}` });
  return null;
}

/**
 * customer.subscription.updated.
 *  - The subscription ENDED (canceled, unpaid, incomplete_expired): same as a deletion.
 *  - Its price, interval or quantity no longer matches what the catalogue sells for the record it entitles (a plan switch in the Billing
 *    Portal, a Dashboard edit): entitlement is NOT changed (the site cannot know whether a person meant it), and the operator is told
 *    once, with the ids, so it is put right deliberately.
 * Anything else (a renewal moving the period, a metadata edit) changes nothing.
 */
async function applySubscriptionUpdate(sub: Stripe.Subscription, ev: { id: string; created?: number }): Promise<NextResponse | null> {
  const ended = sub.status === "canceled" || sub.status === "unpaid" || sub.status === "incomplete_expired";
  const found = await resolveSubscription(sub.id);
  if (!found.ok) return lifecycleRetry("subscription update (lookup failed)", sub.id);
  if (!found.api && !found.watch && !found.intelligence) {
    // An update with nothing of ours to compare it to is routine (Stripe sends one right after checkout, possibly before our own
    // record exists): acknowledge it. An ENDED one for our own kind is retried like a deletion that beat its checkout.
    if (ended && isOurSubscriptionKind(sub.metadata?.kind)) return lifecycleRetry("cancellation (no record yet)", sub.id);
    return null;
  }
  if (ended) return applyCancellation(sub, found);
  // Billing PAUSED (pause_collection set, or status paused). Stripe's pause stops FUTURE invoices only, so the customer keeps the period
  // already paid for: the pause is SCHEDULED for the end of that period and becomes the "paused" hold then (the daily job, the Hall Watch
  // cron and the access checks apply it; lib/billing-pause.ts). A resume before that instant cancels the schedule, and one after it lifts the
  // hold, putting everything back exactly where it was. Pause and resume events are ordered by their own clock (billing_pause_event_ts):
  // a pause older than a resume (or the reverse) already applied changes nothing.
  const paused = Boolean(sub.pause_collection) || (sub.status as string) === "paused";
  const held = await applyPauseState(found, sub as unknown as PausedSub, ev, reversalStripe());
  if (!held.ok) return lifecycleRetry(paused ? "pause (write failed)" : "resume (write failed)", sub.id);
  await checkPlanAgainstCatalogue(sub, found);
  return null;
}

/** What the catalogue sells for the record(s) this subscription entitles. Ended records are not compared. */
function expectedTerms(found: Resolved): { label: string; amount: number; interval: string; count: number }[] {
  const out: { label: string; amount: number; interval: string; count: number }[] = [];
  if (found.api && found.api.status !== "cancelled") {
    const p = PRODUCTS[found.api.plan as keyof typeof PRODUCTS];
    if (p?.recurring) out.push({ label: `API plan ${p.id}`, amount: p.amountCents, interval: p.recurring.interval, count: p.recurring.intervalCount });
  }
  if (found.watch && found.watch.status !== "cancelled") {
    const p = PRODUCTS.hall_watch;
    if (p.recurring) out.push({ label: "Hall Watch", amount: p.amountCents, interval: p.recurring.interval, count: p.recurring.intervalCount });
  }
  if (found.intelligence && (found.intelligence.status === "active" || found.intelligence.status === "past_due")) {
    const p = INTELLIGENCE_PLANS[found.intelligence.plan as keyof typeof INTELLIGENCE_PLANS];
    if (p) out.push({ label: `Intelligence plan ${p.id}`, amount: p.priceCents, interval: p.interval, count: 1 });
  }
  return out;
}

async function checkPlanAgainstCatalogue(sub: Stripe.Subscription, found: Resolved): Promise<void> {
  const items = sub.items?.data ?? [];
  const want = expectedTerms(found);
  if (items.length === 0 || want.length === 0) return; // a payload without items, or nothing live to compare: nothing to say
  const w = want[0];
  const price = items[0]?.price;
  const qty = items[0]?.quantity ?? 1;
  const interval = price?.recurring?.interval;
  const count = price?.recurring?.interval_count ?? 1;
  const matches =
    items.length === 1 &&
    qty === 1 &&
    price?.unit_amount === w.amount &&
    (price?.currency ?? "eur") === "eur" &&
    interval === w.interval &&
    count === w.count;
  if (matches) return;
  const ids = items.map((i) => `price ${i.price?.id ?? "-"} (product ${typeof i.price?.product === "string" ? i.price.product : "-"}, ${i.price?.unit_amount ?? "-"} ${String(i.price?.currency ?? "").toUpperCase()}/${i.price?.recurring?.interval_count ?? 1} ${i.price?.recurring?.interval ?? "-"}, quantity ${i.quantity ?? 1})`).join("; ");
  const records = [found.api && `API account record ${found.api.id}`, found.watch && `Hall Watch record ${found.watch.id}`, found.intelligence && `Intelligence record ${found.intelligence.id}`].filter(Boolean).join(", ");
  // Once per subscription and price: Stripe sends an update at every renewal, and the condition persists until a person resolves it.
  await notifyOperatorOnce(
    `plan_mismatch:${sub.id}:${items.map((i) => `${i.price?.id ?? ""}x${i.quantity ?? 1}`).join("+")}`,
    `Stripe subscription no longer matches the catalogue — ${w.label}`,
    `Stripe subscription ${sub.id} (customer ${typeof sub.customer === "string" ? sub.customer : "-"}) now bills ${ids}.\n\n` +
      `The catalogue sells ${w.label} at ${w.amount} cents every ${w.count} ${w.interval}(s), quantity 1. The record it entitles: ${records}.\n\n` +
      "NOTHING was changed on the site: entitlement (units, key, access) is exactly what it was. This is usually a plan switch made in the Stripe " +
      "Billing Portal (turn off subscription_update in the portal configuration: the site does not handle plan switches) or an edit in the Dashboard. " +
      "Decide deliberately: put the subscription back, or change the customer's plan and allowance by hand. This notice is sent once per subscription and price."
  );
}

/** The Stripe client the reversal handlers use (the same injectable one the pay-as-you-go billing and the dispute notice use). */
function reversalStripe(): ReversalStripe | null {
  return paygStripe() as unknown as ReversalStripe | null;
}

/**
 * A dispute opened or closed, as a mail to the operator: the amount, the Stripe charge id, the Stripe customer id and the site's own
 * reference for the account when one matches. Never the customer's email, the card, or the evidence Stripe attaches to the dispute, and
 * nothing of those is logged (lib/mail.ts logs the subject and the first characters of this text). Best effort: the funnel counter and
 * the response to Stripe do not depend on it, and it is sent once per dispute and phase however often Stripe redelivers.
 */
async function disputeNotice(closed: boolean, d: Stripe.Dispute): Promise<void> {
  const chargeId = typeof d.charge === "string" ? d.charge : (d.charge as { id?: string } | null)?.id ?? "";
  const currency = typeof d.currency === "string" && /^[a-z]{3}$/.test(d.currency) ? d.currency.toUpperCase() : "EUR";
  const amount = `${((d.amount ?? 0) / 100).toFixed(2)} ${currency}`;
  const reason = typeof d.reason === "string" && /^[a-z_]{1,40}$/.test(d.reason) ? d.reason : "unspecified";
  const status = typeof d.status === "string" && /^[a-z_]{1,40}$/.test(d.status) ? d.status : "unknown";
  const dueBy = d.evidence_details?.due_by;
  const due = typeof dueBy === "number" && dueBy > 0 ? new Date(dueBy * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;

  let customer = "";
  try {
    const stripe = paygStripe();
    if (stripe && chargeId) {
      const c = await stripe.charges.retrieve(chargeId);
      customer = typeof c.customer === "string" ? c.customer : c.customer?.id ?? "";
    }
  } catch {
    /* the notice goes out without the customer: the charge id is enough to find it in Stripe */
  }
  let account = "no matching account on the site (a one-off engagement deposit has no Stripe customer; find the payment by its charge id)";
  if (customer) {
    const api = await pg<{ account: string }[]>("GET", `api_accounts?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=account&limit=1`);
    const watch = api.ok && api.data?.[0] ? null : await pg<{ id: string }[]>("GET", `watches?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=id&limit=1`);
    const sub = api.ok && api.data?.[0] || (watch?.ok && watch.data?.[0]) ? null : await pg<{ id: string }[]>("GET", `subscriptions?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=id&limit=1`);
    if (api.ok && api.data?.[0]) account = `API account reference ${accountRef(api.data[0].account)}`;
    else if (watch?.ok && watch.data?.[0]) account = `Hall Watch record ${watch.data[0].id}`;
    else if (sub?.ok && sub.data?.[0]) account = `Intelligence subscription record ${sub.data[0].id}`;
  }
  const head = `Charge ${chargeId || "-"}, dispute ${d.id}, ${amount}, reason ${reason}.\nStripe customer: ${customer || "-"}. Account: ${account}.`;
  if (closed) {
    await notifyOperatorOnce(
      `dispute:${d.id}:closed`,
      `Stripe dispute CLOSED (${status}) — ${amount} (charge ${chargeId || "-"})`,
      `${head}\n\nOutcome: ${status}. ${status === "won" ? "The disputed amount is returned to the balance." : status === "lost" ? "The disputed amount stays debited, and the dispute fee is not returned." : "See the dispute in the Stripe Dashboard."}`
    );
    return;
  }
  await notifyOperatorOnce(
    `dispute:${d.id}:created`,
    `Stripe dispute OPENED — ${amount} (charge ${chargeId || "-"})${due ? `, evidence due ${due}` : ""}`,
    `${head}\n\n${due ? `Evidence is due by ${due}. ` : ""}Unanswered, the dispute is lost and the amount stays debited. Respond in the Stripe Dashboard (Payments, Disputes) before the deadline. ` +
      "This notice changes nothing itself. Access is handled separately: a real dispute on a SUBSCRIPTION payment suspends that subscription's paid " +
      "access (recorded in billing_audit) and a dispute won restores it; a one-off engagement is not released while the payment is disputed " +
      "unless you acknowledge it."
  );
}

function lifecycleRetry(what: string, subId: string) {
  console.error(`[GridForge] billing event NOT applied — ${what} for ${subId}; asking Stripe to retry`);
  return NextResponse.json({ ok: false, error: "Billing event could not be applied" }, { status: 500 });
}

/**
 * If the checkout named a project, attach the purchase to it. The payment and its fulfilment
 * object already exist when this runs; this only adds the link and the history event.
 *
 * Returns a Response to send back when the delivery should be RETRIED (a transient failure —
 * the attachment is idempotent, so a retry is safe), or null to carry on. A permanent failure
 * (the project does not exist) is logged and does NOT fail the webhook: the customer has paid
 * and been fulfilled, and redelivery could never fix it.
 */
async function attachToProject(
  session: Stripe.Checkout.Session,
  kind: string,
  amount: number,
  findObjectId: () => Promise<string | null>
): Promise<NextResponse | null> {
  const projectId = (session.metadata?.project_id as string) || "";
  if (!projectId) return null;
  if (!isProjectAttachable(kind)) {
    console.error("[GridForge] project_id on a kind that cannot attach; ignored:", kind, session.id);
    return null;
  }
  const objectType = purchaseObjectType(kind);
  let objectId: string | null = null;
  if (objectType) {
    objectId = await findObjectId();
    if (!objectId) {
      return NextResponse.json({ ok: false, error: "Purchase object not readable yet" }, { status: 500 });
    }
  }
  const r = await attachPurchase({
    project_id: projectId,
    kind,
    object_type: objectType,
    object_id: objectId,
    session_id: session.id,
    amount_cents: amount || null,
  });
  if (r.ok) return null;
  if (r.permanent) {
    console.error("[GridForge] purchase NOT attached to its project (permanent):", session.id, r.error);
    return null;
  }
  console.error("[GridForge] purchase attach failed; asking Stripe to retry:", session.id, r.error);
  return NextResponse.json({ ok: false, error: "Project attachment failed" }, { status: 500 });
}

async function openApiAccount(p: {
  kind: string;
  email: string;
  company: string;
  units: number;
  customerId: string | null;
  subscriptionId: string | null;
}): Promise<false | "created" | "existing"> {
  if (p.subscriptionId) {
    const already = await findBySubscription(p.subscriptionId);
    if (already) {
      console.log(`[GridForge] api account already open for subscription ${p.subscriptionId}`);
      // A redelivery must not abandon an access email that never went out (the obligation is durable).
      if ((await notifyCustomer("api_access_link", already.id, "", { replay: true })) === "retry_webhook") return false;
      return "existing";
    }
  }
  const created = await createApiAccount({
    email: p.email || null,
    company: p.company || null,
    plan: p.kind,
    monthly_units: p.units,
    stripe_customer_id: p.customerId,
    stripe_subscription_id: p.subscriptionId,
  });
  if (!created) {
    console.error("[GridForge] could not open an api account for subscription", p.subscriptionId ?? "none");
    return false;
  }
  console.log(`[GridForge] api account opened (record ${created.row.id})`);
  // The row is written; from here the work is done. The access email is a durable obligation on its own
  // (lib/notifications.ts): a provider failure is retried and observable, and never reverses this purchase.
  if ((await notifyCustomer("api_access_link", created.row.id)) === "retry_webhook") return false;
  return "created";
}

async function openWatch(p: {
  email: string;
  company: string;
  sessionId: string;
  subscriptionId: string | null;
  customerId: string | null;
}): Promise<false | "created" | "existing"> {
  if (p.subscriptionId) {
    const already = await watchBySubscription(p.subscriptionId);
    if (already) {
      console.log(`[GridForge] watch already open for subscription ${p.subscriptionId}`);
      if ((await notifyCustomer("watch_link", already.id, "", { replay: true })) === "retry_webhook") return false;
      return "existing";
    }
  }
  const row = await createWatch({
    email: p.email || null,
    company: p.company || null,
    stripe_subscription_id: p.subscriptionId,
    stripe_customer_id: p.customerId,
    cadence: "quarterly",
  });
  if (!row) {
    console.error("[GridForge] could not open a watch for session", p.sessionId);
    return false;
  }
  console.log(`[GridForge] hall watch opened (record ${row.id})`);
  if ((await notifyCustomer("watch_link", row.id)) === "retry_webhook") return false;
  return "created";
}

async function openDeliverable(p: {
  kind: string;
  email: string;
  company: string;
  amount: number;
  sessionId: string;
  qualificationId: string | null;
}): Promise<false | "created" | "existing"> {
  // Replay first. Stripe redelivers until it gets a 2xx and this handler now
  // asks for that, so a second delivery of a session already opened must be a
  // no-op rather than a second intake link for one payment.
  const already = await deliverableBySession(p.sessionId);
  if (already) {
    console.log(`[GridForge] deliverable already open for session ${p.sessionId}`);
    // Fulfilment is idempotent; the intake email is its own durable obligation, so a redelivery
    // retries it if it never went out instead of treating "already fulfilled" as "already told".
    if ((await notifyCustomer("intake_link", already.id, "", { replay: true })) === "retry_webhook") return false;
    return "existing";
  }
  const record = await createDeliverable({
    kind: p.kind,
    email: p.email || null,
    company: p.company || null,
    amount_cents: p.amount || null,
    stripe_session_id: p.sessionId,
    qualification_id: p.qualificationId || null,
    status: "awaiting_intake",
  });
  if (!record) {
    console.error("[GridForge] could not open a deliverable for session", p.sessionId);
    return false;
  }
  // The email carries the INTAKE token (migration 0012), never the document token; it is rebuilt from
  // this row when sent, so no link is ever written to a log.
  console.log(`[GridForge] deliverable opened (${p.kind}, record ${record.id})`);
  if ((await notifyCustomer("intake_link", record.id)) === "retry_webhook") return false;
  return "created";
}

/**
 * Tell an API customer their key is about to age out, at the moment we know they
 * have just paid for another month of it.
 *
 * Sends the portal link, never the key — same rule as the welcome email. A key
 * is shown once, at mint, and there is no copy anywhere for this to attach.
 *
 * Silent when the key is healthy, so a customer on a long-lived key is not
 * emailed every month about nothing.
 */
async function remindToRotate(row: ApiAccount): Promise<void> {
  const life = keyLife(row);
  // No key means nothing to warn about (the access email covers a customer who has not minted one), and
  // a key that is comfortably valid needs no reminder.
  if (!life.has_key || !life.expires || !life.needs_rotation) return;
  console.log(`[GridForge] api account ${row.id}: key ${life.expired ? "expired" : `${life.days_left} day(s) left`}; reminding`);
  // One obligation per key expiry date: a renewal redelivery does not send a second, and a message queued
  // for an old expiry is cancelled (not sent) once the key has been rotated or renewed.
  await notifyCustomer("key_rotation", row.id, life.expires);
}

async function markDepositPaid(p: {
  email: string;
  company: string;
  amount: number;
  sessionId: string;
}): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !p.email) return;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  try {
    // PATCH the newest lead with this email.
    const res = await fetch(
      `${url}/rest/v1/leads?email=eq.${encodeURIComponent(p.email)}&order=created_at.desc&limit=1`,
      {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json", Prefer: "return=minimal" },
        // `status` is the only deposit-related column leads has; the payment itself lives in
        // engagement_deposits (0019). This marks the lead a person may be tracking, nothing more.
        body: JSON.stringify({ status: "deposit_paid" }),
      }
    );
    if (!res.ok) console.error("[GridForge] deposit PATCH failed:", await storeFault(res));
  } catch (err) {
    console.error("[GridForge] deposit PATCH error:", err);
  }
}

async function notifyFounder(p: { email: string; company: string; amount: number }): Promise<void> {
  const eur = (c: number) => `€${(c / 100).toLocaleString("en-IE")}`;
  // Best effort and never throws; sendMail validates the provider's answer and logs a category only.
  await notifyOperator(
    `💳 Deposit paid — ${p.company || "a buyer"} (${eur(p.amount)})`,
    `Engagement deposit received.\n\nCompany: ${p.company}\nEmail: ${p.email}\nAmount: ${eur(p.amount)}\n\nIt is recorded in engagement_deposits (GET /api/admin/deposits). Contact the buyer to scope the engagement and record who did. Scoping records the fee agreed (inside the published band), the delivery date you commit to, and applies any earlier Density Screen as a one-time credit.`
  );
}
