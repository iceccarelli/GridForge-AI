import { NextResponse } from "next/server";
import { SITE, checkoutOrigin } from "@/lib/site";
import { readBoundedJson } from "@/lib/http-body";
import { getWatch } from "@/lib/watches";
import { accountByToken } from "@/lib/payg-accounts";
import { BILLING_RETURN_PATH, billingReturnCookie, type BillingSubject } from "@/lib/payg-return";
import { paygStripe, stripeFault } from "@/lib/payg-stripe";
import { guardRequest } from "@/lib/rate-limit";
import { bearer } from "@/lib/portal";
import { ownerContext } from "@/lib/team";
import { INTELLIGENCE_PORTAL_REQUEST, INTELLIGENCE_PORTAL_RETURN_PATH, portalUnavailableMessage } from "@/lib/subscription-manage";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

/**
 * POST { token } -> { ok, url }: a Stripe Billing Portal session for the Stripe customer behind this token. The token is either an API /
 * pay-as-you-go portal token or a Hall Watch token; whichever it opens is the account whose customer is used, and nothing in the request
 * names a customer. In the portal the customer can cancel a subscription, replace their card and read their invoices (what is allowed is
 * configured in the Stripe dashboard; no document in this repository describes it). A cancellation there reaches the site through the signed
 * `customer.subscription.deleted` webhook, which revokes the key and ends the account: this route changes nothing itself.
 *
 * The return URL carries NO token. The way back is resolved by a short-lived HttpOnly cookie (lib/payg-return.ts), as for checkout.
 *
 * POST { account: "intelligence" } + the Supabase session (Authorization: Bearer) -> the same, for a GridForge Intelligence subscription.
 * Its subscriber has no portal token; the verified session is the credential. Only the BILLING OWNER may open it (a seat member is refused,
 * 403: lib/team.ts ownerContext, the door every owner-only route uses), and the Stripe customer is the one on the owner's OWN subscription row,
 * read by the server from the verified address. Nothing in the request can name a customer, and none is read from it. The way back is
 * /account?billing=returned, with nothing in the URL. Every answer on this branch carries Cache-Control: no-store, and every answer that
 * means "cannot be done here" names the one next step: write to the contact address.
 */
export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { token?: unknown; account?: unknown };

  // The branch is chosen by what the caller ASKS for, not by what it happens to send: a request for the Intelligence subscription never falls
  // back to a token, and a token request never looks at the session.
  if (body.account === INTELLIGENCE_PORTAL_REQUEST.account) return intelligencePortal(req);

  const token = typeof body.token === "string" ? body.token : "";
  const g = await guardRequest(req, "payg_manage");
  if (g.denied) return g.denied;

  let customer: string | null = null;
  let subject: BillingSubject = "api";
  let known = false;
  if (token) {
    const acct = await accountByToken(token);
    if (acct === "error") return NextResponse.json({ ok: false, error: "This is unavailable just now." }, { status: 503 });
    if (acct) {
      known = true;
      customer = acct.stripe_customer_id;
    } else {
      const watch = await getWatch(token);
      if (watch) {
        known = true;
        subject = "watch";
        customer = watch.stripe_customer_id;
      }
    }
  }
  if (!known) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  if (!customer) {
    return NextResponse.json(
      { ok: false, error: "There is no billing record to manage yet: no card or subscription has been set up for this account.", reason: "no_customer" },
      { status: 409 }
    );
  }
  const stripe = paygStripe();
  if (!stripe) return NextResponse.json({ ok: false, error: "Billing is not configured on this deployment." }, { status: 503 });

  const origin = checkoutOrigin(req.headers.get("origin"));
  try {
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}${BILLING_RETURN_PATH}` });
    if (!session.url) return NextResponse.json({ ok: false, error: "Could not open the billing portal." }, { status: 502 });
    const res = NextResponse.json({ ok: true, url: session.url });
    res.headers.append("Set-Cookie", billingReturnCookie(subject, token));
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    // Typically: the Billing Portal has not been configured in the Stripe dashboard yet. The category goes to the log, never Stripe's message.
    console.error(`[GridForge] billing portal session failed (${stripeFault(err)})`);
    return NextResponse.json({ ok: false, error: "The billing portal is not available right now. Nothing was changed.", reason: "portal_unavailable" }, { status: 502 });
  }
}

/** Every answer on the Intelligence branch: never cached, whoever it is for. */
function uncached(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** A refusal that names the next step (the contact address), with the stable `reason` the page can branch on. `detail` says what is wrong, if it is worth saying. */
function unavailable(status: number, reason: string, detail = ""): NextResponse {
  const error = [detail, portalUnavailableMessage(SITE.email)].filter(Boolean).join(" ");
  return uncached(NextResponse.json({ ok: false, error, reason }, { status }));
}

async function intelligencePortal(req: Request): Promise<NextResponse> {
  // No credential is a plain 401, before anything is counted or asked: the page sends the session on every call it makes.
  if (!bearer(req)) return uncached(NextResponse.json({ ok: false, error: "Sign in to manage your subscription." }, { status: 401 }));

  // The same hourly limit as the token branch and the other account changes (lib/rate-limit.ts payg_manage), counted per caller address and
  // before the session is checked, so a flood of tokens cannot spend the site's Supabase Auth budget through this route.
  const g = await guardRequest(req, "payg_manage");
  if (g.denied) return uncached(g.denied);

  // Verified identity, an entitling subscription, and ownership of it: or the refusal (401 / 403 / 402 / 429 / 503), worded for billing.
  const ctx = await ownerContext(req, {
    notOwner: "Only the billing owner can manage billing or cancel the subscription. Ask the account owner.",
    unavailable: portalUnavailableMessage(SITE.email),
  });
  if (!ctx.ok) return uncached(ctx.response);

  // The customer is the owner's own row's. It is the only source: the request body was not read for one.
  const customer = ctx.subscription.stripe_customer_id;
  if (!customer) return unavailable(409, "no_customer", "No billing record is linked to this subscription.");

  const stripe = paygStripe();
  if (!stripe) return unavailable(503, "billing_not_configured");

  const origin = checkoutOrigin(req.headers.get("origin"));
  try {
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}${INTELLIGENCE_PORTAL_RETURN_PATH}` });
    if (!session.url) return unavailable(502, "portal_unavailable");
    return uncached(NextResponse.json({ ok: true, url: session.url }));
  } catch (err) {
    // Typically: the Billing Portal has not been configured in the Stripe dashboard yet. The category goes to the log, never Stripe's message.
    console.error(`[GridForge] billing portal session failed (${stripeFault(err)})`);
    return unavailable(502, "portal_unavailable");
  }
}
