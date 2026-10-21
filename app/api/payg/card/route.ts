import { NextResponse } from "next/server";
import { checkoutOrigin } from "@/lib/site";
import { readBoundedJson } from "@/lib/http-body";
import { accountByToken } from "@/lib/payg-accounts";
import { RETURN_PATH, returnCookie } from "@/lib/payg-return";
import { paygStripe, stripeFault } from "@/lib/payg-stripe";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

/**
 * POST { token } -> { ok, url }: Stripe Checkout in SETUP mode for the account's EXISTING customer, to replace the card on file.
 *
 * A failed card used to be unrecoverable from here (enable refuses an account that is already pay-as-you-go, the cap does not touch the
 * card) and the next month's charge failed the same way. Nothing is charged. The signed webhook (checkout.session.completed, kind
 * api_payg_card_update) saves the new card as the customer's default and the account's card, points any unpaid failed invoice at it and
 * tries it. Allowed for an active or past_due pay-as-you-go account; a cancelled one is refused.
 */
export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const g = await guardRequest(req, "payg_manage");
  if (g.denied) return g.denied;

  const acct = token ? await accountByToken(token) : null;
  if (acct === "error") return NextResponse.json({ ok: false, error: "This is unavailable just now. Nothing was changed." }, { status: 503 });
  if (!acct) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  if (acct.status === "cancelled") return NextResponse.json({ ok: false, error: "This account has been cancelled." }, { status: 402 });
  if (acct.plan !== "api_payg" || !acct.stripe_customer_id) {
    return NextResponse.json({ ok: false, error: "There is no card on file to replace. Enable pay-as-you-go first.", fix: "enable_payg" }, { status: 409 });
  }
  const stripe = paygStripe();
  if (!stripe) return NextResponse.json({ ok: false, error: "Payments are not configured. Nothing was changed." }, { status: 503 });

  const origin = checkoutOrigin(req.headers.get("origin"));
  const meta = { kind: "api_payg_card_update", account_id: acct.account };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      currency: "eur",
      payment_method_types: ["card"],
      customer: acct.stripe_customer_id,
      metadata: meta,
      setup_intent_data: { metadata: meta },
      success_url: `${origin}${RETURN_PATH}?payg=success`,
      cancel_url: `${origin}${RETURN_PATH}?payg=cancelled`,
    });
    if (!session.url) return NextResponse.json({ ok: false, error: "Could not start checkout" }, { status: 502 });
    const res = NextResponse.json({ ok: true, url: session.url });
    res.headers.append("Set-Cookie", returnCookie(token));
    return res;
  } catch (err) {
    console.error(`[GridForge] payg card update checkout failed (${stripeFault(err)})`);
    return NextResponse.json({ ok: false, error: "Could not start checkout. Nothing was changed." }, { status: 502 });
  }
}
