import { NextResponse } from "next/server";
import { checkoutOrigin } from "@/lib/site";
import { readBoundedJson } from "@/lib/http-body";
import { getWatch } from "@/lib/watches";
import { accountByToken } from "@/lib/payg-accounts";
import { BILLING_RETURN_PATH, billingReturnCookie, type BillingSubject } from "@/lib/payg-return";
import { paygStripe, stripeFault } from "@/lib/payg-stripe";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

/**
 * POST { token } -> { ok, url }: a Stripe Billing Portal session for the Stripe customer behind this token. The token is either an API /
 * pay-as-you-go portal token or a Hall Watch token; whichever it opens is the account whose customer is used, and nothing in the request
 * names a customer. In the portal the customer can cancel a subscription, replace their card and read their invoices (what is allowed is
 * configured in the Stripe dashboard: docs/10_PAYG_LAUNCH_CHECKLIST.md). A cancellation there reaches the site through the signed
 * `customer.subscription.deleted` webhook, which revokes the key and ends the account: this route changes nothing itself.
 *
 * The return URL carries NO token. The way back is resolved by a short-lived HttpOnly cookie (lib/payg-return.ts), as for checkout.
 */
export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { token?: unknown };
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
