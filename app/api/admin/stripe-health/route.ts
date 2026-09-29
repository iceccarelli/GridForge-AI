import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import Stripe from "stripe";
import { verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { checkStripeWebhookHealth } from "@/lib/stripe-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET -> whether Stripe's own webhook configuration actually delivers the
// events app/api/stripe/webhook/route.ts depends on. Auth-gated: this calls
// the live Stripe account, and its result (which events are or are not
// wired up) is exactly the kind of operational detail that should not be
// public. Never assume this is healthy — ask Stripe directly, every time.
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = key ? new Stripe(key) : null;
  const health = await checkStripeWebhookHealth(stripe, siteUrl("/api/stripe/webhook"));
  return NextResponse.json({ ok: true, health });
}
