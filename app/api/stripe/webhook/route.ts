import { SITE_URL, siteUrl } from "@/lib/site";
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
import { lookupSubscriptionByStripeId, recordSubscription, updateSubscription, type SubscriptionRecord } from "@/lib/subscribers";
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
      await notifyFounder({ email, company, amount });
    } else if (kind === "hall_watch") {
      const opened = await openWatch({
        email,
        company,
        sessionId: session.id,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        customerId: typeof session.customer === "string" ? session.customer : null,
      });
      if (!opened) return fulfilmentFailed("hall watch", session.id);
      const subId = typeof session.subscription === "string" ? session.subscription : null;
      const attachedWatch = await attachToProject(session, kind, amount, async () =>
        subId ? (await watchBySubscription(subId))?.id ?? null : null
      );
      if (attachedWatch) return attachedWatch;
      await notifyFounder({ email, company, amount });
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
      const attachedDeliverable = await attachToProject(session, kind, amount, async () =>
        (await deliverableBySession(session.id))?.id ?? null
      );
      if (attachedDeliverable) return attachedDeliverable;
      await notifyFounder({ email, company, amount });
    } else if (kind === "intelligence_subscription") {
      // The subscription id is what makes cancellation possible later. Storing
      // only the session and customer ids — which is what this did — left
      // customer.subscription.deleted with nothing to resolve against, so a
      // cancelled Intelligence plan would have stayed active forever.
      const plan = (session.metadata?.plan as string) || "unknown";
      const row = await recordSubscription({
        email,
        plan,
        sessionId: session.id,
        customerId: typeof session.customer === "string" ? session.customer : null,
        subscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      });
      if (row) {
        await notifySubscriber({ email, plan });
      } else {
        // Do not welcome somebody to a subscription we failed to record. Return a
        // 500 so Stripe retries the event, and recordSubscription() is idempotent
        // on the session id so the retry cannot double-issue.
        console.error(
          "[GridForge] intelligence subscription NOT recorded; asking Stripe to retry:",
          email,
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
      // Mark the most recent matching lead deposit_paid (match by email, newest first).
      await markDepositPaid({ email, company, amount, sessionId: session.id });
      await notifyFounder({ email, company, amount });
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
      else console.log(`[GridForge] hall watch ${found.watch.token} cancelled; scheduled runs stop`);
    }
    if (found.intelligence) {
      if (!(await updateSubscription(found.intelligence.id, { status: "cancelled" }))) applied = false;
      else console.log(`[GridForge] intelligence subscription for ${found.intelligence.email} cancelled; /account drops to the free view`);
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
}): Promise<boolean> {
  if (p.subscriptionId) {
    const already = await findBySubscription(p.subscriptionId);
    if (already) {
      console.log(`[GridForge] api account already open for subscription ${p.subscriptionId}`);
      return true;
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
    console.error("[GridForge] could not open an api account for", p.email || "unknown");
    return false;
  }
  const base = SITE_URL;
  const url = `${base}/api-access/${created.token}`;
  console.log(`[GridForge] api account opened for ${p.email || "unknown"} — ${url}`);

  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  // The row is written; from here the work is done. Email is best-effort and must
  // never turn a fulfilled purchase back into a failed webhook — a retry would
  // find the row and do nothing anyway, and the link is in the log above.
  if (!key || !from || !p.email) return true;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: p.email,
        subject: "Your GridForge API access is live",
        text:
          "Your key is waiting here:\n\n" +
          url +
          "\n\nIt is shown once. We do not store it — the engine verifies it by its " +
          "signature, so there is no copy anywhere for anyone to take.\n\n" +
          `Your allowance is ${p.units.toLocaleString("en-IE")} units a month. A constraint ` +
          "screen is 1 unit, a full solve is 5, and a portfolio run is 1 per hall. The free " +
          "qualifier stays free and never touches the allowance. Rates are published at " +
          "/v1/version so you can price a job before you run it.\n\n" +
          "One thing worth reading before you integrate: every number we return carries an " +
          "evidence class and a provenance digest, and every response carries our calibration " +
          "state. Screening-mode output is not an issued engineering opinion — it has no named " +
          "signatory and no indemnity behind it. That distinction matters more inside an agent " +
          "loop than it does in a board pack, because nobody downstream reads the footnote.\n\n" +
          "Schemas: https://gridforge-engine.fly.dev/v1/tools\n" +
          "MCP:     https://gridforge-engine.fly.dev/mcp",
      }),
    });
  } catch (err) {
    console.error("[GridForge] api key email failed:", err);
  }
  return true;
}

async function openWatch(p: {
  email: string;
  company: string;
  sessionId: string;
  subscriptionId: string | null;
  customerId: string | null;
}): Promise<boolean> {
  if (p.subscriptionId) {
    const already = await watchBySubscription(p.subscriptionId);
    if (already) {
      console.log(`[GridForge] watch already open for subscription ${p.subscriptionId}`);
      return true;
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
  const base = SITE_URL;
  const url = `${base}/watch/${row.token}`;
  console.log(`[GridForge] hall watch opened for ${p.email || "unknown"} — ${url}`);
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  // The row is written; from here the work is done. Email is best-effort and must
  // never turn a fulfilled purchase back into a failed webhook — a retry would
  // find the row and do nothing anyway, and the link is in the log above.
  if (!key || !from || !p.email) return true;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: p.email,
        subject: "Your hall is now watched",
        text:
          "The model stays live from here.\n\n" +
          "Give it the hall's current numbers once, and from then on it is re-solved every " +
          "quarter and whenever you change an input. You get a change note naming what moved " +
          "and which input moved it — including when the movement came from our side because a " +
          "library or the constraint set was revised.\n\n" +
          url +
          "\n\nIf nothing material changes, we will tell you that in three lines rather than " +
          "send you a document to justify the fee.",
      }),
    });
  } catch (err) {
    console.error("[GridForge] watch email failed:", err);
  }
  return true;
}

async function openDeliverable(p: {
  kind: string;
  email: string;
  company: string;
  amount: number;
  sessionId: string;
  qualificationId: string | null;
}): Promise<boolean> {
  // Replay first. Stripe redelivers until it gets a 2xx and this handler now
  // asks for that, so a second delivery of a session already opened must be a
  // no-op rather than a second intake link for one payment.
  const already = await deliverableBySession(p.sessionId);
  if (already) {
    console.log(`[GridForge] deliverable already open for session ${p.sessionId}`);
    return true;
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
  const base = SITE_URL;
  // The INTAKE token, not the document token. They are different credentials now
  // (migration 0012): this one only submits the hall's numbers, so it is safe to
  // put in an email and on /commissioned, while reading the released document
  // still needs the token we never publish.
  const intakeToken = record.intake_token ?? record.token;
  console.log(
    `[GridForge] deliverable opened (${p.kind}) for ${p.email || "unknown"} — intake link: ${base}/intake/${intakeToken}`
  );
  await emailIntakeLink({ email: p.email, kind: p.kind, url: `${base}/intake/${intakeToken}` });
  return true;
}

async function emailIntakeLink(p: { email: string; kind: string; url: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !p.email) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: p.email,
        subject: "Your GridForge engagement — the numbers we need",
        text:
          "Thank you. The engagement is open.\n\n" +
          "The next step is the hall's own numbers. Everything you do not supply is filled " +
          "from a library default and named as an assumption in the deliverable, so the more " +
          "of it you complete, the fewer of your conclusions rest on our guesses.\n\n" +
          p.url +
          "\n\nThe link is unguessable and specific to this engagement. Do not forward it to " +
          "anyone who should not read the result.",
      }),
    });
    // Resend answers a rejection with a status, not a throw. This is the message
    // that carries a EUR 4,500 engagement's only intake link; losing it silently
    // is how a paid customer sits waiting for an email nobody knows never left.
    // The link is in the log above, so this is recoverable — but only if it is
    // said out loud.
    if (!res.ok) {
      console.error(
        "[GridForge] intake email NOT sent:",
        res.status,
        await res.text(),
        "— link was",
        p.url
      );
    }
  } catch (err) {
    console.error("[GridForge] intake email failed:", err, "— link was", p.url);
  }
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
  if (!life.needs_rotation) return;

  const url = `${SITE_URL}/api-access/${row.token}`;
  const when = life.expired
    ? `expired on ${life.expires}`
    : `expires on ${life.expires} — ${life.days_left} day(s) from now`;
  console.log(`[GridForge] api account ${row.account}: key ${when}; reminding ${row.email ?? "no email"}`);

  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from || !row.email) return;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: row.email,
        subject: life.expired
          ? "Your GridForge API key has expired — mint a new one"
          : "Your GridForge API key expires shortly",
        text:
          `Your subscription has renewed. Your API key ${when}.\n\n` +
          "Keys carry their own expiry so the engine can verify them offline, with no " +
          "database and no call home. The price of that is that a key cannot be extended " +
          "in place — a new expiry means a new key, and only you can put it into your " +
          "deployment.\n\n" +
          "Mint the replacement here:\n\n" +
          url +
          "\n\n" +
          (life.expired
            ? "The old key is dead, so the new one replaces it immediately."
            : "Your current key keeps working until it expires, so you can deploy the new " +
              "one first and let the old one lapse. Nothing stops in between.") +
          "\n\nYour allowance and account are unchanged.",
      }),
    });
    if (!res.ok) {
      console.error("[GridForge] rotation reminder failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[GridForge] rotation reminder error:", err);
  }
}

async function notifySubscriber(p: { email: string; plan: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "Time to Power <power@timetopower.ai>";
  if (!apiKey) return;
  if (to) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `New Intelligence subscriber \u2014 ${p.plan} (${p.email})`,
          text: `New GridForge Intelligence subscription.\n\nEmail: ${p.email}\nPlan: ${p.plan}`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] subscriber notify error:", err);
    }
  }
  if (p.email && p.email.includes("@")) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [p.email],
          reply_to: process.env.LEAD_TO_EMAIL || "power@timetopower.ai",
          subject: "Welcome to GridForge Intelligence",
          text:
            `Your ${p.plan} subscription is active.\n\n` +
            `Sign in to your live dashboard: ${siteUrl('/account/login')}\n\n` +
            `\u2014 Time to Power`,
        }),
      });
    } catch (err) {
      console.error("[GridForge] subscriber welcome error:", err);
    }
  }
}

/** A plain operator notice. Best effort, never fails a webhook; without email configured it is logged loudly. */
async function notifyOperator(subject: string, text: string): Promise<void> {
  console.error(`[GridForge] OPERATOR ACTION NEEDED: ${subject} — ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "Time to Power <onboarding@resend.dev>";
  if (!apiKey || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
  } catch (err) {
    console.error("[GridForge] operator notice error:", err);
  }
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
        body: JSON.stringify({
          deposit_paid: true,
          deposit_amount_cents: p.amount,
          stripe_session_id: p.sessionId,
          status: "deposit_paid",
        }),
      }
    );
    if (!res.ok) console.error("[GridForge] deposit PATCH failed:", await res.text());
  } catch (err) {
    console.error("[GridForge] deposit PATCH error:", err);
  }
}

async function notifyFounder(p: { email: string; company: string; amount: number }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_TO_EMAIL;
  const from = process.env.LEAD_FROM_EMAIL || "Time to Power <onboarding@resend.dev>";
  if (!apiKey || !to) return;
  const eur = (c: number) => `€${(c / 100).toLocaleString("en-IE")}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `💳 Deposit paid — ${p.company || p.email} (${eur(p.amount)})`,
        text: `Engagement deposit received.\n\nCompany: ${p.company}\nEmail: ${p.email}\nAmount: ${eur(p.amount)}\n\nThe lead has been marked deposit_paid. Follow up to scope the engagement.`,
      }),
    });
  } catch (err) {
    console.error("[GridForge] deposit notify error:", err);
  }
}
