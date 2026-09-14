import { NextResponse } from "next/server";
import Stripe from "stripe";
import { COMMERCE, foundingSlotsRemaining } from "@/lib/commerce";
import { PRODUCTS, isProductId } from "@/lib/products";

export const runtime = "nodejs";

// Creates a Stripe Checkout Session.
//
// Two shapes. Without `product` it is the engagement reservation deposit, exactly
// as before. With `product` it is a catalogue engagement (see lib/products.ts) —
// the Density Screen buys a real deliverable, so its session carries the
// qualification id and the webhook starts the intake → generate → release flow.
//
// Original behaviour, unchanged:
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
  const productId = isProductId(body.product) ? body.product : null;
  const product = productId ? PRODUCTS[productId] : null;
  const qualificationId =
    typeof body.qualificationId === "string" ? body.qualificationId : "";

  const origin =
    req.headers.get("origin") ||
    process.env.SITE_URL ||
    "https://timetopower.ai";

  // The founding credit applies to the engagement deposit, not to a fixed-fee
  // engineering deliverable — discounting the screen would undercut the only
  // qualification signal that means anything.
  const applyFounding = !product && wantsFounding && foundingSlotsRemaining() > 0;
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
              name: product ? product.name : COMMERCE.deposit.label,
              description: product ? product.description : COMMERCE.deposit.description,
            },
            unit_amount: product ? product.amountCents : COMMERCE.deposit.amountCents,
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
        kind: product ? product.kind : "engagement_deposit",
        qualification_id: qualificationId,
      },
      success_url: product
        ? `${origin}/commissioned?session_id={CHECKOUT_SESSION_ID}`
        : `${origin}/?deposit=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: product ? `${origin}/qualify?purchase=cancelled` : `${origin}/pricing?deposit=cancelled`,
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
