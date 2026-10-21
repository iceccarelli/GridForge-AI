import { NextResponse } from "next/server";
import { checkoutOrigin } from "@/lib/site";
import { readBoundedJson } from "@/lib/http-body";
import { PAYG, parseCapEur } from "@/lib/payg";
import { accountByToken } from "@/lib/payg-accounts";
import { paygStripe, stripeFault } from "@/lib/payg-stripe";
import { guardRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;

/**
 * POST { token, cap_eur } -> { ok, url }: Stripe Checkout in SETUP mode, to save a card. NOTHING is charged here or ever at
 * enable time; usage is invoiced afterwards, in arrears, within the cap the customer chose. Enabling is a separate explicit act
 * from the free allowance and is only completed by the signed webhook (checkout.session.completed, kind api_payg_enable), never by
 * this response or by the redirect back.
 */
export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { token?: unknown; cap_eur?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const cap = parseCapEur(body.cap_eur);
  if (cap === null) {
    return NextResponse.json(
      { ok: false, error: `The monthly cap must be a whole number of euros between ${PAYG.minCapEur} and ${PAYG.maxCapEur}.`, min_cap_eur: PAYG.minCapEur, max_cap_eur: PAYG.maxCapEur },
      { status: 400 }
    );
  }
  const g = await guardRequest(req, "payg_manage");
  if (g.denied) return g.denied;

  const acct = token ? await accountByToken(token) : null;
  if (acct === "error") return NextResponse.json({ ok: false, error: "This is unavailable just now. Nothing was changed." }, { status: 503 });
  if (!acct) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  if (acct.status === "cancelled") {
    return NextResponse.json({ ok: false, error: "This account has been cancelled." }, { status: 402 });
  }
  if (acct.status === "past_due") {
    return NextResponse.json(
      { ok: false, error: "A payment on this account has not cleared. Pay the outstanding invoice first (see your invoices on this page).", status: "past_due" },
      { status: 402 }
    );
  }
  if (acct.plan === "api_payg") {
    return NextResponse.json(
      { ok: false, error: "Pay-as-you-go is already enabled on this account. To change the cap, use the cap control.", fix: "change_cap" },
      { status: 409 }
    );
  }
  if (acct.plan !== "api_free") {
    return NextResponse.json(
      { ok: false, error: "This account is on a subscription plan; pay-as-you-go applies to the free developer allowance." },
      { status: 409 }
    );
  }
  const stripe = paygStripe();
  if (!stripe) return NextResponse.json({ ok: false, error: "Payments are not configured. Nothing was changed." }, { status: 503 });

  const origin = checkoutOrigin(req.headers.get("origin"));
  const meta = { kind: "api_payg_enable", account_id: acct.account, cap_eur: String(cap) };
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      currency: PAYG.currency,
      payment_method_types: ["card"],
      // An existing Stripe customer is reused; otherwise Checkout creates one and the webhook records its id.
      ...(acct.stripe_customer_id ? { customer: acct.stripe_customer_id } : { customer_creation: "always" as const, ...(acct.email ? { customer_email: acct.email } : {}) }),
      metadata: meta,
      setup_intent_data: { metadata: meta },
      success_url: `${origin}/api-access/${token}?payg=success`,
      cancel_url: `${origin}/api-access/${token}?payg=cancelled`,
    });
    if (!session.url) return NextResponse.json({ ok: false, error: "Could not start checkout" }, { status: 502 });
    return NextResponse.json({ ok: true, url: session.url });
  } catch (err) {
    console.error(`[GridForge] payg enable checkout failed (${stripeFault(err)})`);
    return NextResponse.json({ ok: false, error: "Could not start checkout. Nothing was changed." }, { status: 502 });
  }
}
