// The one name of the self-service cancel control, so the page that SELLS a subscription and the page that holds it cannot describe it in two ways.
//
// What exists: an API subscription plan (a catalogue product with `apiUnits` and a monthly `recurring`) has a private account page
// (/api-access/<token>, linked from the email that carries its key and from /commissioned). With a Stripe customer on record and the account
// not cancelled, that page shows a button with this label (components/PaygPortal.tsx ManageSubscription), which opens Stripe's billing
// portal (POST /api/billing/portal); a cancellation made there reaches the site through the signed customer.subscription.deleted webhook.
// Hall Watch has the same control on its own page (components/WatchManage.tsx). The free allowance and pay-as-you-go have no subscription,
// so they have nothing to cancel and show no such button (their portal says so).
//
// What this does NOT prove: that the Stripe Billing Portal is configured to allow cancelling. That lives in the Stripe dashboard; the route
// answers "not available right now" if it is not, and the owner confirms it in test mode (docs/EXECUTION_STATE.md, issue #4).
export const MANAGE_SUBSCRIPTION_LABEL = "Manage or cancel subscription";
