import { SITE } from "@/lib/site";

// The one name of the self-service cancel control, so the page that SELLS a subscription and the page that holds it cannot describe it in two ways.
//
// What exists: an API subscription plan (a catalogue product with `apiUnits` and a monthly `recurring`) has a private account page
// (/api-access/<token>, linked from the email that carries its key and from /commissioned). With a Stripe customer on record and the account
// not cancelled, that page shows a button with this label (components/PaygPortal.tsx ManageSubscription), which opens Stripe's billing
// portal (POST /api/billing/portal); a cancellation made there reaches the site through the signed customer.subscription.deleted webhook.
// Hall Watch has the same control on its own page (components/WatchManage.tsx). The free allowance and pay-as-you-go have no subscription,
// so they have nothing to cancel and show no such button (their portal says so).
//
// A GridForge Intelligence subscription has it on the signed-in account page (/account, components/IntelligenceManage.tsx) for the BILLING
// OWNER only: POST /api/billing/portal { account: "intelligence" } with the Supabase session, which opens Stripe's billing portal for the
// customer on the owner's own subscription row (the server reads it; the request names none). A seat member sees who the owner is instead.
//
// What this does NOT prove: that the Stripe Billing Portal is configured to allow cancelling, or whether it cancels at once or at the end
// of the paid period. That lives in the Stripe dashboard; the route answers "not available right now" if it is not, and the owner confirms
// it in test mode (docs/EXECUTION_STATE.md, issue #4). /api/admin/stripe-health reports whether the default portal configuration enables
// cancellation (lib/stripe-health.ts checkBillingPortal).
export const MANAGE_SUBSCRIPTION_LABEL = "Manage or cancel subscription";

/**
 * What cancelling a GridForge Intelligence subscription does, and what else ends access. ONE sentence group, read by the sales page
 * (components/IntelligenceClient.tsx), the signed-in account page (components/IntelligenceManage.tsx) and the Terms (app/legal/terms/page.tsx),
 * so the promise cannot differ between the page that sells it and the page that holds it (tests/site/intelligence-cancel.test.ts). Every
 * clause is a thing the code does:
 *
 *   - "While access is on, the billing owner can cancel from the account page ... which opens Stripe's billing page": the button and POST
 *     /api/billing/portal's session branch (app/api/billing/portal/route.ts), owner only (lib/team.ts ownerContext), and only while the
 *     subscription entitles (lib/subscribers.ts lookupEntitlement: active and past_due rows, a scheduled pause not yet due). For an owner whose
 *     access is suspended or whose pause has started, the account page shows no button and the portal answers 402 with the contact address
 *     (subscriptionRequiredMessage), which is why the sentence says "if access is suspended, write to ...".
 *   - "when the cancellation takes effect is Stripe's": the site changes nothing when the portal is opened or when a cancellation is merely
 *     scheduled (customer.subscription.updated with a live status writes nothing here, app/api/stripe/webhook/route.ts applySubscriptionUpdate);
 *     whether the portal cancels at once or at the end of the paid period is its configuration in the Stripe dashboard, which no code here can see.
 *   - "ends access when Stripe reports the subscription as ended": customer.subscription.deleted, or .updated to canceled / unpaid /
 *     incomplete_expired, sets the row to `cancelled` (applyCancellation); lookupEntitlement entitles only active and past_due rows.
 *   - "suspends it for a full refund, an open dispute or a pause once the period already paid for is over": the three hold kinds of
 *     lib/billing-holds.ts (HoldKind: refunded, disputed, paused). A refund counts only when it is a FULL one (isFullRefund), a dispute only when
 *     a chargeback is open, and a pause only from the end of the paid period (billing_pause_from, lib/billing-pause-due.ts pauseDue). The Stripe
 *     subscription itself goes on, so this is a suspension of access, not a cancellation. tests/site/intelligence-cancel.test.ts derives that
 *     set from those two files and fails if the sentence names fewer causes than the code has.
 *   - "for every seat on it": a seat is the owner's subscription row read now (lib/subscribers.ts lookupMembership), so it ends with it.
 *   - "not reinstated ... a new purchase": a cancelled row is never reopened by a later invoice event (lib/billing-holds.ts, the invoice.paid
 *     branch of the webhook), and a new checkout records a new row (recordSubscription). A SUSPENDED row is not a cancelled one: its hold can be
 *     lifted (lib/billing-holds.ts liftHold), which is why the sentence says "ended" for the one and "suspends" for the other.
 *   - "refunds nothing automatically": no code path refunds anything when a subscription ends (applyCancellation writes the row and a funnel
 *     event, nothing else). It says nothing about what Stripe's portal may be set to do, and it is not a refund policy: the Terms state none
 *     ("Refund terms are not yet stated on this page; ask before you buy"), which is why it says "automatically".
 */
export const INTELLIGENCE_CANCEL_TERMS =
  `While access is on, the billing owner can cancel from the account page (“${MANAGE_SUBSCRIPTION_LABEL}”), which opens Stripe's billing page; ` +
  `if access is suspended, write to ${SITE.email} from the address you signed in with. ` +
  "When the cancellation takes effect is Stripe's: this site ends access when Stripe reports the subscription as ended, and suspends it " +
  "for a full refund, an open dispute or a pause once the period already paid for is over (the Terms say more), in each case for every seat on it. " +
  "An ended subscription is not reinstated (subscribing again is a new purchase), and this site refunds nothing automatically when one ends.";

/**
 * The 402 for a caller with no ENTITLING subscription, where the owner-only routes cannot tell "never subscribed" from "subscribed, then
 * suspended by a full refund or an open dispute, or paused" (lookupEntitlement answers null for all of them, by design: the same door). It
 * must not be a dead end for the second kind of caller, and must not tell the first kind that they hold a subscription: so it says which
 * callers the next step is for. Nothing is called on Stripe's side to produce it.
 */
export function subscriptionRequiredMessage(email: string = SITE.email): string {
  return `An active GridForge Intelligence subscription is required. If you have one that is suspended (a full refund, an open dispute or a pause), write to ${email} from the address you signed in with.`;
}

/** What /account tells a visitor it shows no subscription for: the next step if theirs is suspended. Not a claim that they hold one. */
export function suspendedAccessNote(email: string = SITE.email): string {
  return `Already subscribed and seeing this? If your subscription is suspended (a full refund, an open dispute or a pause), write to ${email} from the address you signed in with: this page cannot open billing for it.`;
}

/** What a seat member is told on the account page: who manages billing. The owner's address is shown only where the page already shows it to members. */
export function memberBillingNote(ownerEmail: string | null): string {
  return `${ownerEmail ? `The account owner (${ownerEmail}) manages billing` : "The account owner manages billing"}. Only the billing owner can change seats, manage billing or cancel the subscription.`;
}

/**
 * The request the account page sends to POST /api/billing/portal to open the portal for the SIGNED-IN owner's Intelligence subscription. It names
 * no customer, and the route would ignore one: the customer is read from the owner's own row.
 */
export const INTELLIGENCE_PORTAL_REQUEST = { account: "intelligence" } as const;

/** Where Stripe's billing page returns the owner to. No token or identifier: the Supabase session in the browser is what opens the account page. */
export const INTELLIGENCE_PORTAL_RETURN_PATH = "/account?billing=returned";

/** What to do when self-service billing cannot be opened: the one next step the page can name. */
export function portalUnavailableMessage(email: string = SITE.email): string {
  return `Managing billing here is not available right now: write to ${email} from the address you signed in with. Nothing was changed.`;
}

/**
 * What the control opens, said only as far as the code can see. The Billing Portal is Stripe's page: which of its functions are on (cancelling,
 * the card, invoices) is its configuration in the Stripe dashboard (docs/EXECUTION_STATE.md, issue #4; lib/stripe-health.ts checkBillingPortal
 * reports whether cancellation is enabled), which no code here can read at request time. So the account page promises none of them but the one
 * it relies on: that a cancellation made there is what ends the subscription (the signed webhook applies it).
 */
export const INTELLIGENCE_PORTAL_EXPLANATION =
  "This opens Stripe's billing page. What it lets you change is set in Stripe, and cancelling there is what ends the subscription. Nothing is cancelled by opening it.";

/** When a cancellation made in Stripe's billing page takes effect: Stripe's setting, not the site's. One sentence, read by every plan that is cancelled there. */
export const CANCEL_TIMING_NOTE = "When a cancellation takes effect is set in Stripe's billing page.";

/**
 * Hall Watch's own, shorter promise, backed by WatchManage (components/WatchManage.tsx) through the same portal route. Read by WatchUpsell and the
 * price ladder. "No minimum term" is a thing the code does not impose: the subscription-mode checkout sets only metadata on the subscription (no
 * cancel_at, schedule, iterations or trial: app/api/checkout/route.ts), the webhook schedules none, and the product's `recurring` is an interval and
 * nothing else (lib/products.ts); tests/site/intelligence-cancel.test.ts fails if any of them gains one. When the cancellation takes effect is Stripe's
 * setting (CANCEL_TIMING_NOTE), which is why the note says so rather than "ends at once" or "at the end of the quarter".
 */
export const HALL_WATCH_CANCEL_NOTE = "Cancel any time; no minimum term. " + CANCEL_TIMING_NOTE;
