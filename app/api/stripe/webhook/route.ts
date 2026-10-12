import { SITE_URL, siteUrl } from "@/lib/site";
import { storeFault } from "@/lib/safe-log";
import { notifyOperator } from "@/lib/mail";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createDeliverable, deliverableBySession } from "@/lib/deliverables";
import { createWatch, lookupWatchBySubscription, updateWatch, watchBySubscription, type WatchRecord } from "@/lib/watches";
import { PRODUCT_BY_KIND, isApiProduct } from "@/lib/products";
import {
  createApiAccount,
  findBySubscription,
  keyLife,
  lookupBySubscription,
  revokeOnEngine,
  updateApiAccount,
  type ApiAccount,
} from "@/lib/api-access";
import { lookupSubscriptionByStripeId, recordSubscription, subscriptionBySession, updateSubscription, type SubscriptionRecord } from "@/lib/subscribers";
import { recordDeposit } from "@/lib/deposits";
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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
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
    if (isApiProduct(kind)) {
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
      if (row) {
        // The operator hears of a NEW subscriber once, not on every Stripe redelivery; the customer's welcome
        // is a durable obligation of its own (a failed email never touches the paid subscription).
        if (!existedBefore) await notifyOperator("New Intelligence subscriber", `Plan: ${plan}. Subscription record ${row.id}.`);
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
      // One email per payment, not one per redelivery.
      if (recorded.created) await notifyFounder({ email, company, amount });
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
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const found = await resolveSubscription(sub.id);
    if (!found.ok) return lifecycleRetry("cancellation (lookup failed)", sub.id);
    if (!found.api && !found.watch && !found.intelligence) {
      // One of ours with no record yet may simply have arrived before its checkout event: retry.
      // Anything else is somebody else's subscription on the same Stripe account: acknowledge.
      if (isOurSubscriptionKind(sub.metadata?.kind)) return lifecycleRetry("cancellation (no record yet)", sub.id);
      console.warn("[GridForge] cancellation for a subscription that is not ours; ignored:", sub.id);
      return NextResponse.json({ ok: true, received: true });
    }
    let applied = true;
    if (found.api) {
      const row = found.api;
      // Revoke the live key id and mark the account cancelled. The ENGINE refuses revoked ids, so the
      // account row is only half of it: tell the engine as well (below).
      const revoked = new Set(row.revoked_key_ids ?? []);
      if (row.key_id) revoked.add(row.key_id);
      const done = await updateApiAccount(row.token, { status: "cancelled", revoked_key_ids: [...revoked] });
      if (!done) applied = false;
      else {
        // Best-effort on purpose (see revokeOnEngine): an engine that is briefly unreachable must not
        // turn a cancellation that HAS been recorded into an endlessly redelivered event. The id is
        // logged so it can be pushed by hand, and the key still dies at its expiry.
        await revokeOnEngine(row.key_id);
        console.log(`[GridForge] api account ${row.account} cancelled; revoked key id ${row.key_id ?? "-"}`);
      }
    }
    if (found.watch) {
      if (!(await updateWatch(found.watch.token, { status: "cancelled" }))) applied = false;
      else console.log(`[GridForge] hall watch ${found.watch.id} cancelled; scheduled runs stop`);
    }
    if (found.intelligence) {
      if (!(await updateSubscription(found.intelligence.id, { status: "cancelled" }))) applied = false;
      else console.log(`[GridForge] intelligence subscription ${found.intelligence.id} cancelled; /account drops to the free view`);
    }
    if (!applied) return lifecycleRetry("cancellation (write failed)", sub.id);
  }

  if (event.type === "invoice.payment_failed") {
    const subId = subscriptionIdOf(event.data.object as Stripe.Invoice);
    if (subId) {
      const found = await resolveSubscription(subId);
      if (!found.ok) return lifecycleRetry("payment failure (lookup failed)", subId);
      let applied = true;
      // Only an ACTIVE entitlement moves. A late failure notice must never reopen a cancelled account
      // (past_due can still mint keys) or demote something already ended.
      if (found.api && found.api.status === "active") {
        if (!(await updateApiAccount(found.api.token, { status: "past_due" }))) applied = false;
      }
      // "paused", not "cancelled": Stripe retries, and a card that fails on Tuesday and clears on
      // Thursday should not have cost the client a quarter.
      if (found.watch && found.watch.status === "active") {
        if (!(await updateWatch(found.watch.token, { status: "paused" }))) applied = false;
      }
      if (found.intelligence && found.intelligence.status === "active") {
        if (!(await updateSubscription(found.intelligence.id, { status: "past_due" }))) applied = false;
      }
      if (!applied) return lifecycleRetry("payment failure (write failed)", subId);
    }
  }

  if (event.type === "invoice.paid") {
    const subId = subscriptionIdOf(event.data.object as Stripe.Invoice);
    if (subId) {
      const found = await resolveSubscription(subId);
      if (!found.ok) return lifecycleRetry("renewal (lookup failed)", subId);
      let applied = true;
      let remind: ApiAccount | null = null;
      if (found.api && found.api.status !== "cancelled") {
        if (!(await updateApiAccount(found.api.token, { status: "active" }))) applied = false;
        else remind = found.api;
      }
      // A watch paused by a failed payment comes back when the payment clears. A cancelled one does
      // not come back by itself — that is a new sale.
      if (found.watch && found.watch.status === "paused") {
        if (!(await updateWatch(found.watch.token, { status: "active" }))) applied = false;
      }
      // Same rule for Intelligence: a payment that clears reinstates access that a failed payment had
      // put past_due. A cancelled one stays cancelled.
      if (found.intelligence && found.intelligence.status === "past_due") {
        if (!(await updateSubscription(found.intelligence.id, { status: "active" }))) applied = false;
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
      // The payment renewed. The KEY does not — it is a signed token with a fixed expiry, and nothing
      // can extend one in place. Tell the customer while there is still a working key to replace
      // (after the writes, so a retried event does not email twice). A key is shown once and never
      // stored, so the email carries the portal link, not a key.
      if (remind) await remindToRotate(remind);
    }
  }

  return NextResponse.json({ ok: true, received: true });
}

/** Every table a Stripe subscription can entitle, read in one go; `ok: false` means a read failed. */
async function resolveSubscription(subId: string): Promise<
  | { ok: false }
  | { ok: true; api: ApiAccount | null; watch: WatchRecord | null; intelligence: SubscriptionRecord | null }
> {
  const [api, watch, intelligence] = await Promise.all([
    lookupBySubscription(subId),
    lookupWatchBySubscription(subId),
    lookupSubscriptionByStripeId(subId),
  ]);
  if (!api.ok || !watch.ok || !intelligence.ok) return { ok: false };
  return { ok: true, api: api.row, watch: watch.row, intelligence: intelligence.row };
}

/** A subscription this site sells: its checkout stamped the subscription with one of these kinds. */
function isOurSubscriptionKind(kind: unknown): boolean {
  return typeof kind === "string" && (isApiProduct(kind) || kind === "hall_watch" || kind === "intelligence_subscription");
}

function lifecycleRetry(what: string, subId: string) {
  console.error(`[GridForge] billing event NOT applied — ${what} for ${subId}; asking Stripe to retry`);
  return NextResponse.json({ ok: false, error: "Billing event could not be applied" }, { status: 500 });
}

/**
 * The subscription id on an invoice.
 *
 * Stripe moved this off the top level of Invoice in a recent API version, and the
 * typings follow the newest one. Read it structurally so the handler works whether
 * the account is pinned to an older version or the current one — a webhook that
 * throws on an unexpected shape silently stops renewing everybody's keys.
 */
function subscriptionIdOf(inv: Stripe.Invoice): string {
  const raw = inv as unknown as {
    subscription?: string | { id?: string };
    parent?: { subscription_details?: { subscription?: string | { id?: string } } };
  };
  const candidate = raw.subscription ?? raw.parent?.subscription_details?.subscription;
  if (typeof candidate === "string") return candidate;
  return candidate?.id ?? "";
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
    `Engagement deposit received.\n\nCompany: ${p.company}\nEmail: ${p.email}\nAmount: ${eur(p.amount)}\n\nIt is recorded in engagement_deposits (GET /api/admin/deposits). Contact the buyer to scope the engagement and record who did.`
  );
}
