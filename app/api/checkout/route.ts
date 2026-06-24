import { NextResponse } from "next/server";
import Stripe from "stripe";
import { COMMERCE, foundingSlotsRemaining } from "@/lib/commerce";

export const runtime = "nodejs";

// Creates a Stripe Checkout Session for the engagement reservation deposit.
// Applies the Founding Partner credit server-side when slots remain, so the
// promotion can't be forged from the client. Returns the hosted payment URL.
export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "Payments not configured" },
      { status: 503 }
    );
  }
  const stripe = new Stripe(key);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — deposit has fixed defaults */
  }

  const company = typeof body.company === "string" ? body.company : "";
  const email = typeof body.email === "string" ? body.email : undefined;
  const capacityMW = typeof body.capacityMW === "number" ? body.capacityMW : undefined;
  const service = typeof body.service === "string" ? body.service : undefined;
  const wantsFounding = body.founding === true;

  const origin =
    req.headers.get("origin") ||
    process.env.SITE_URL ||
    "https://timetopower.ai";

  // Apply founding credit only if explicitly requested AND slots remain.
  const applyFounding = wantsFounding && foundingSlotsRemaining() > 0;
  const discounts: Stripe.Checkout.SessionCreateParams.Discount[] = [];
  if (applyFounding) {
    const coupon = await stripe.coupons.create({
      amount_off: COMMERCE.founding.creditCents,
      currency: COMMERCE.currency,
      duration: "once",
      name: "Founding Partner credit",
      max_redemptions: 1,
    });
    discounts.push({ coupon: coupon.id });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: COMMERCE.currency,
            product_data: {
              name: COMMERCE.deposit.label,
              description: COMMERCE.deposit.description,
            },
            unit_amount: COMMERCE.deposit.amountCents,
          },
          quantity: 1,
        },
      ],
      discounts,
      customer_email: email,
      metadata: {
        company,
        capacity_mw: capacityMW ? String(capacityMW) : "",
        service: service ?? "",
        founding_applied: applyFounding ? "yes" : "no",
        kind: "engagement_deposit",
      },
      success_url: `${origin}/?deposit=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?deposit=cancelled`,
    });

    return NextResponse.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[GridForge] Stripe checkout error:", err);
    return NextResponse.json(
      { ok: false, error: "Could not start checkout" },
      { status: 500 }
    );
  }
}
