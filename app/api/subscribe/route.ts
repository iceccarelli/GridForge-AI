import { NextResponse } from "next/server";
import Stripe from "stripe";
import { PLANS } from "@/lib/subscriptions";

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

  const origin = req.headers.get("origin") || process.env.SITE_URL || "https://timetopower.ai";

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
      customer_email: body.email,
      metadata: { plan: plan.id, kind: "intelligence_subscription" },
      success_url: `${origin}/account?sub=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/intelligence?sub=cancelled`,
    });

    return NextResponse.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[GridForge] subscribe error:", err);
    return NextResponse.json({ ok: false, error: "Could not start checkout" }, { status: 500 });
  }
}
