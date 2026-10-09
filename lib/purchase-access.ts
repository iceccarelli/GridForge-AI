// Server-only: where a buyer of a SUBSCRIPTION product (an API plan or Hall Watch) finds what they bought.
//
// /commissioned used to describe the intake of a deliverable for every product, and the portal link for
// an API plan or a watch reached the buyer only by email. Email is best-effort and depends on RESEND_*
// being configured; a buyer whose email never arrives had paid and had no way in. The Stripe checkout
// session id the buyer is redirected with is proof of purchase (it is unguessable and the same trust the
// intake link already relies on), but it is only believed after Stripe itself says the session is
// complete and paid and names a kind of ours — never on the strength of the URL alone.

import Stripe from "stripe";
import { findBySubscription } from "@/lib/api-access";
import { PRODUCT_BY_KIND, isApiProduct } from "@/lib/products";
import { watchBySubscription } from "@/lib/watches";

export type PurchaseAccess =
  | { state: "ready"; kind: "api" | "watch"; name: string; path: string; units?: number }
  /** Paid and recognised, but the webhook has not recorded the entitlement (yet). */
  | { state: "pending"; kind: "api" | "watch"; name: string }
  /** Not a subscription product of ours, not paid, or Stripe could not be asked. */
  | { state: "unknown" };

export async function accessForSession(sessionId: string): Promise<PurchaseAccess> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { state: "unknown" };
  let session: Stripe.Checkout.Session;
  try {
    session = await new Stripe(key).checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error("[GridForge] could not retrieve checkout session for the landing page:", err);
    return { state: "unknown" };
  }
  const kind = String(session.metadata?.kind ?? "");
  const paid = session.status === "complete" && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? "";
  if (!paid || !subId) return { state: "unknown" };
  const name = PRODUCT_BY_KIND[kind]?.name ?? kind;

  if (isApiProduct(kind)) {
    const row = await findBySubscription(subId);
    return row
      ? { state: "ready", kind: "api", name, path: `/api-access/${row.token}`, units: row.monthly_units }
      : { state: "pending", kind: "api", name };
  }
  if (kind === "hall_watch") {
    const row = await watchBySubscription(subId);
    return row ? { state: "ready", kind: "watch", name, path: `/watch/${row.token}` } : { state: "pending", kind: "watch", name };
  }
  return { state: "unknown" };
}
