import { checkoutOrigin, siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { PLANS } from "@/lib/subscriptions";
import { identify } from "@/lib/portal";
import { activeSubscription } from "@/lib/subscribers";

export const runtime = "nodejs";

// Creates a Stripe Checkout Session in subscription mode for a GridForge
// Intelligence plan. Prices are created inline from lib/subscriptions (single
// source of truth), so there's no separate Stripe dashboard product to drift.
export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "Payments not configured" }, { status: 503 });
  }
  const stripe = new Stripe(key);

  let body: { plan?: string; email?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const plan = PLANS.find((p) => p.id === body.plan);
  if (!plan) {
    return NextResponse.json({ ok: false, error: "Unknown plan" }, { status: 400 });
  }

  const origin = checkoutOrigin(req.headers.get("origin"));

  // The email on a checkout is NEVER taken from the request body: anyone can type anybody's address, and the webhook entitles by
  // address. Only a VERIFIED signed-in session names one, and for an address that already has a subscription the existing Stripe
  // customer is reused, so an upgrade from the portal is the same payer (and may replace the old plan) while a stranger's checkout
  // is not (lib/subscribers.ts recordSubscription).
  let customerParams: { customer: string } | { customer_email: string } | Record<string, never> = {};
  if (req.headers.get("authorization")) {
    const who = await identify(req);
    if (who.ok && who.verified) {
      const current = await activeSubscription(who.email);
      customerParams = current?.stripe_customer_id ? { customer: current.stripe_customer_id } : { customer_email: who.email };
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            recurring: { interval: "month" },
            product_data: {
              name: `GridForge Intelligence — ${plan.name}`,
              description: plan.tagline,
            },
            unit_amount: plan.priceCents,
          },
          quantity: 1,
        },
      ],
      ...customerParams,
      metadata: { plan: plan.id, kind: "intelligence_subscription" },
      // Stamped on the Stripe SUBSCRIPTION too, so a cancellation event (which carries no session
      // metadata) can be recognised as ours — and retried if it beats its own checkout event.
      subscription_data: { metadata: { plan: plan.id, kind: "intelligence_subscription" } },
      success_url: `${origin}/account?sub=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/intelligence?sub=cancelled`,
    });

    return NextResponse.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[GridForge] subscribe error:", err);
    return NextResponse.json({ ok: false, error: "Could not start checkout" }, { status: 500 });
  }
}
