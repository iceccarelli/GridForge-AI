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
 * What cancelling a GridForge Intelligence subscription does. ONE sentence, read by the sales page (components/IntelligenceClient.tsx), the
 * signed-in account page (components/IntelligenceManage.tsx) and the Terms (app/legal/terms/page.tsx), so the promise cannot differ between
 * the page that sells it and the page that holds it (tests/site/intelligence-cancel.test.ts). Every clause is a thing the code does:
 *
 *   - "the billing owner can cancel from the account page ... which opens Stripe's billing page": the button and POST /api/billing/portal's
 *     session branch (app/api/billing/portal/route.ts), owner only (lib/team.ts ownerContext).
 *   - "when the cancellation takes effect is Stripe's": the site changes nothing when the portal is opened or when a cancellation is merely
 *     scheduled (customer.subscription.updated with a live status writes nothing here, app/api/stripe/webhook/route.ts applySubscriptionUpdate);
 *     whether the portal cancels at once or at the end of the paid period is its configuration in the Stripe dashboard, which no code here can see.
 *   - "ends access only when Stripe reports the subscription as ended": customer.subscription.deleted, or .updated to canceled / unpaid /
 *     incomplete_expired, sets the row to `cancelled` (applyCancellation); lookupEntitlement entitles only active and past_due rows.
 *   - "for every seat on it": a seat is the owner's subscription row read now (lib/subscribers.ts lookupMembership), so it ends with it.
 *   - "not reinstated ... a new purchase": a cancelled row is never reopened by a later invoice event (lib/billing-holds.ts, the invoice.paid
 *     branch of the webhook), and a new checkout records a new row (recordSubscription).
 *   - "refunds nothing automatically": no code path refunds anything when a subscription ends (applyCancellation writes the row and a funnel
 *     event, nothing else). It says nothing about what Stripe's portal may be set to do, and it is not a refund policy: the Terms state none
 *     ("Refund terms are not yet stated on this page; ask before you buy"), which is why it says "automatically".
 */
export const INTELLIGENCE_CANCEL_TERMS =
  `The billing owner can cancel from the account page (“${MANAGE_SUBSCRIPTION_LABEL}”), which opens Stripe's billing page. ` +
  "When the cancellation takes effect is Stripe's: this site ends access only when Stripe reports the subscription as ended, for every seat on it. " +
  "An ended subscription is not reinstated (subscribing again is a new purchase), and this site refunds nothing automatically when one ends.";

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

/** Hall Watch's own, shorter promise, backed by WatchManage (components/WatchManage.tsx) through the same portal route. Read by WatchUpsell. */
export const HALL_WATCH_CANCEL_NOTE = "Cancel any time; no minimum term.";
