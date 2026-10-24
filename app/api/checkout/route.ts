import { checkoutOrigin, siteUrl } from "@/lib/site";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { COMMERCE, foundingSlotsRemainingLive } from "@/lib/commerce";
import { apiSalesReadiness } from "@/lib/api-readiness";
import { PRODUCTS, isApiProduct, isProductId, type ProductId } from "@/lib/products";
import { getProjectByToken, isProjectAttachable } from "@/lib/projects";
import { projectForShare } from "@/lib/project-share";
import { qualificationForCheckout } from "@/lib/qualify";
import { pg, rpc } from "@/lib/payg-store";
import { guardRequest } from "@/lib/rate-limit";
import { LEGACY_DEPOSIT_KIND, recordCheckoutEvent, type CheckoutFailureReason } from "@/lib/funnel";

export const runtime = "nodejs";

/** How long a Founding Partner slot stays reserved for a checkout that has not completed. */
const FOUNDING_RESERVATION_MINUTES = 35;

/** Give a reserved slot back when no session carries it (best effort: an unreleased one simply expires). */
async function releaseFoundingReservation(id: string | null): Promise<void> {
  if (!id) return;
  await pg("DELETE", `founding_reservations?id=eq.${encodeURIComponent(id)}`, undefined, "return=minimal");
}

/** RFC 4122 shape. The database column is a uuid; nothing else can be stored. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which ONE catalogue selector a body names. The same rule the route applies, in one place so the funnel and the route cannot disagree
 * about what a valid product is. Anything else (several selectors, an unknown id, a non-object) is not a valid product.
 */
function selectProduct(body: unknown): { valid: true; productId: ProductId | null } | { valid: false } {
  if (body === null || typeof body !== "object") return { valid: false };
  const b = body as Record<string, unknown>;
  const selectorKeys = ["product", "productId", "sku", "product_id", "priceId", "price_id"] as const;
  const supplied = selectorKeys.filter((key) => key in b);
  if (supplied.length === 0) return { valid: true, productId: null };
  if (supplied.length !== 1 || !isProductId(b.product)) return { valid: false };
  return { valid: true, productId: b.product };
}

// Creates a Stripe Checkout Session.
//
// Funnel (lib/funnel.ts, migration 0042): a VALID catalogue request records `checkout_attempted` when it is handed to Stripe,
// `checkout_session_created` when Stripe returns a URL (that is NOT a payment), or `checkout_failed` with one fixed reason when it is
// refused or Stripe fails. An invalid product, an unknown selector or a malformed body records nothing. Recording is best-effort and
// bounded (recordCheckoutEvent): it cannot change the response, the status, what is sent to Stripe, or whether a session exists.
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
    // The product is not known yet at this point of the route: read it only to count the refusal (a failed read or an invalid product
    // records nothing). The answer below is the same whatever this finds.
    try {
      const peeked = selectProduct(await req.json());
      const peekedKind = peeked.valid ? (peeked.productId ? PRODUCTS[peeked.productId].kind : process.env.GRIDFORGE_LEGACY_DEPOSIT === "1" ? LEGACY_DEPOSIT_KIND : null) : null;
      if (peekedKind) await recordCheckoutEvent("checkout_failed", { kind: peekedKind, reason: "payments_not_configured" });
    } catch {
      /* an unreadable body is not commercial activity */
    }
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
  const selectorKeys = ["product", "productId", "sku", "product_id", "priceId", "price_id"] as const;
  const suppliedSelectors = selectorKeys.filter((key) => key in body);
  const rawProduct = body.product;
  let productId: ProductId | null = null;
  if (suppliedSelectors.length > 0) {
    if (suppliedSelectors.length !== 1 || !isProductId(rawProduct)) {
      return NextResponse.json(
        { ok: false, error: "Unknown or ambiguous checkout product" },
        { status: 400 }
      );
    }
    productId = rawProduct;
  }
  const product = productId ? PRODUCTS[productId] : null;
  // The kind every checkout event carries: the catalogue kind, or (operator-enabled legacy path only) the off-catalogue deposit.
  const funnelKind = product ? product.kind : LEGACY_DEPOSIT_KIND;
  const refused = (reason: CheckoutFailureReason) => recordCheckoutEvent("checkout_failed", { kind: funnelKind, reason });

  // The generic EUR 5,000 "engagement reservation deposit" and its Founding Partner credit are OFF the catalogue: nothing on the site starts
  // them, and the public price list (lib/products.ts, /pricing, llms.txt) says there is no other. A NEW session of either kind is therefore
  // refused unless the operator has switched the legacy path on, so the bare `{}` / `{founding:true}` POST cannot create an off-catalogue
  // price. Sessions created before are unaffected: the webhook still fulfils them.
  if (!productId && process.env.GRIDFORGE_LEGACY_DEPOSIT !== "1") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "There is no generic deposit. Everything on sale is in the catalogue (lib/products.ts, listed at /pricing): name one of its products with `product`. " +
          "Nothing was created and nothing was charged.",
      },
      { status: 400 }
    );
  }

  // A valid request is about to touch the store and Stripe (and the funnel): admitted by the request limit first, which fails closed.
  // Invalid input was refused above and costs nothing. The limiter's own counters, not the funnel, record a request refused here.
  const guard = await guardRequest(req, "checkout");
  if (guard.denied) return guard.denied;

  // Commissioning a paid product FOR a project. The project token is the authority and is
  // checked here, before Stripe is touched: a wrong token, a product that cannot attach, or a
  // store that cannot confirm the project all fail with no session created — the same rule as
  // an invalid product. Only the project's id (not the bearer token) goes into Stripe metadata.
  let projectId = "";
  let fromBuyerLink = false;
  if ("project_token" in body) {
    if (typeof body.project_token !== "string" || !body.project_token || !product || !isProjectAttachable(product.kind)) {
      await refused("project_reference_rejected");
      return NextResponse.json(
        { ok: false, error: "A project can only be named for a Density Screen, Envelope Study deposit, Procurement Specification or Hall Watch" },
        { status: 400 }
      );
    }
    const found = await getProjectByToken(body.project_token);
    if (!found.ok) {
      await refused(found.status === 404 ? "project_reference_rejected" : "store_unavailable");
      return NextResponse.json({ ok: false, error: found.error }, { status: found.status === 404 ? 404 : found.status });
    }
    projectId = found.project.id;
  }
  // The same hand-off from a project's read-only buyer link (app/p/[shareToken]). The link is a weaker capability than the
  // project token: it can start a purchase that attaches to the project and do nothing else to it. A revoked, unknown or
  // malformed link is one answer, and the link itself never goes into Stripe metadata -- only the project's id does.
  if ("project_share_token" in body) {
    if ("project_token" in body) {
      await refused("project_reference_rejected");
      return NextResponse.json({ ok: false, error: "Name the project by its token or by a buyer link, not both" }, { status: 400 });
    }
    if (typeof body.project_share_token !== "string" || !body.project_share_token || !product || !isProjectAttachable(product.kind)) {
      await refused("project_reference_rejected");
      return NextResponse.json(
        { ok: false, error: "A project can only be named for a Density Screen, Envelope Study deposit, Procurement Specification or Hall Watch" },
        { status: 400 }
      );
    }
    const found = await projectForShare(body.project_share_token);
    if (!found.ok) {
      await refused(found.status === 404 ? "project_reference_rejected" : "store_unavailable");
      return NextResponse.json(
        { ok: false, error: found.status === 404 ? "This buyer link is no longer valid. Ask the sender for a new one." : found.error },
        { status: found.status }
      );
    }
    projectId = found.project.id;
    fromBuyerLink = true;
  }
  // `deliverables.qualification_id` is a uuid with a foreign key to `qualifications`, and it seeds the buyer's intake form from
  // the numbers behind that read. Two things follow. (1) Anything that is not a real id fails the insert -- and a failed
  // fulfilment returns 500 so Stripe redelivers, so a malformed id would turn a real payment into one that can never be
  // fulfilled. (2) An id the caller merely NAMES would let one buyer pull another buyer's read into their own intake. So an id
  // is carried only when it exists, is under 24 hours old, and the caller presents the read's q-token (the secret in its
  // /q/<token> link); anything else is dropped and the purchase completes unattached. The id is a convenience, not a requirement.
  const rawQualificationId =
    typeof body.qualificationId === "string" ? body.qualificationId.trim() : "";
  const hasClaim = Boolean(rawQualificationId) || typeof body.qualificationToken === "string";
  let qualificationId = "";
  if (hasClaim) {
    const verified =
      (!rawQualificationId || UUID.test(rawQualificationId))
        ? await qualificationForCheckout(body.qualificationToken, rawQualificationId || undefined)
        : null;
    qualificationId = verified ?? "";
    if (!qualificationId) {
      console.warn("[GridForge] checkout dropped an unverified qualification reference (no matching, recent q-token)");
    }
  }

  // An API plan is a promise: a key the engine accepts, and a way to end it. Prove both against the engine
  // (lib/api-readiness.ts) before Stripe is touched. Anything short of positive proof -- unset secret, a
  // secret the engine rejects, an unreachable engine, no working revocation -- sells nothing and takes no
  // money. The reason category goes to the log; the customer sees a generic, honest message.
  if (productId && isApiProduct(productId)) {
    const ready = await apiSalesReadiness();
    if (!ready.ready) {
      console.error(`[GridForge] API plan checkout refused: ${ready.category}`);
      await refused("api_plan_not_ready");
      return NextResponse.json(
        { ok: false, error: "API plans are temporarily unavailable while we finish verifying key issuance. No payment was taken." },
        { status: 503 }
      );
    }
  }

  const origin = checkoutOrigin(req.headers.get("origin"));

  // The founding credit applies to the engagement deposit, not to a fixed-fee
  // engineering deliverable — discounting the screen would undercut the only
  // qualification signal that means anything.
  // Slots are counted from persisted paid deposits. If the count cannot be read the credit is NOT
  // granted blind: the request is refused (no session, no coupon). When no slot remains the buyer gets the
  // ordinary deposit and the response says the credit was not applied. No coupon is created without a discount.
  let applyFounding = false;
  let foundingReservation: string | null = null;
  if (!product && wantsFounding && COMMERCE.founding.enabled) {
    const remaining = await foundingSlotsRemainingLive();
    if (remaining === null) {
      console.error("[GridForge] founding slots unreadable; checkout refused (fail closed)");
      await refused("founding_slots_unreadable");
      return NextResponse.json(
        { ok: false, error: "We cannot confirm Founding Partner availability right now. No payment was taken. Please try again shortly." },
        { status: 503 }
      );
    }
    if (remaining > 0) {
      // "Remaining" is read from PAID deposits only, so N concurrent checkouts would each see the last slot and each be given
      // the credit (EUR 2,500 each). A slot is therefore RESERVED, atomically in the database (gf_founding_reserve, 0028), before any
      // coupon exists: paid + live reservations < total, serialised. No reservation -> no coupon, and the buyer gets the ordinary
      // deposit. If the reservation cannot be made at all (store down, migration not applied) the credit is NOT granted blind.
      const reserved = await rpc<string | null>("gf_founding_reserve", {
        p_paid: COMMERCE.founding.totalSlots - remaining,
        p_total: COMMERCE.founding.totalSlots,
        p_ttl_minutes: FOUNDING_RESERVATION_MINUTES,
      });
      if (!reserved.ok) {
        console.error("[GridForge] founding slot could not be reserved; checkout refused (fail closed)");
        await refused("founding_reservation_failed");
        return NextResponse.json(
          { ok: false, error: "We cannot confirm Founding Partner availability right now. No payment was taken. Please try again shortly." },
          { status: 503 }
        );
      }
      foundingReservation = typeof reserved.data === "string" && reserved.data ? reserved.data : null;
      applyFounding = foundingReservation !== null;
    }
  }
  // Every gate this site controls has passed: from here the request is handed to Stripe.
  await recordCheckoutEvent("checkout_attempted", { kind: funnelKind });
  const discounts: Stripe.Checkout.SessionCreateParams.Discount[] = [];
  if (applyFounding) {
    try {
      const coupon = await stripe.coupons.create({
        amount_off: COMMERCE.founding.creditCents,
        currency: COMMERCE.currency,
        duration: "once",
        name: "Founding Partner credit",
        max_redemptions: 1,
      });
      discounts.push({ coupon: coupon.id });
    } catch (err) {
      await refused("stripe_coupon_failed");
      await releaseFoundingReservation(foundingReservation);
      throw err;
    }
  }

  let outcomeRecorded = false;
  try {
    const recurring = product?.recurring;
    const session = await stripe.checkout.sessions.create({
      mode: recurring ? "subscription" : "payment",
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
            ...(recurring
              ? {
                  recurring: {
                    interval: recurring.interval,
                    interval_count: recurring.intervalCount,
                  },
                }
              : {}),
          },
          quantity: 1,
        },
      ],
      // Stripe rejects one-off discounts on a subscription session; a recurring
      // engagement is not the place for a founding credit anyway.
      ...(recurring ? {} : { discounts }),
      // A credited session lapses before its reserved slot does (Stripe's minimum session life is 30 minutes), so a slot is never
      // spent by a session that outlived its reservation.
      ...(applyFounding ? { expires_at: Math.floor(Date.now() / 1000) + (FOUNDING_RESERVATION_MINUTES - 4) * 60 } : {}),
      customer_email: email,
      ...(recurring
        ? {
            subscription_data: {
              metadata: {
                company,
                kind: product?.kind ?? "",
                qualification_id: qualificationId,
                ...(projectId ? { project_id: projectId } : {}),
              },
            },
          }
        : {}),
      metadata: {
        company,
        capacity_mw: capacityMW ? String(capacityMW) : "",
        service: service ?? "",
        founding_applied: applyFounding ? "yes" : "no",
        ...(foundingReservation ? { founding_reservation: foundingReservation } : {}),
        kind: product ? product.kind : "engagement_deposit",
        qualification_id: qualificationId,
        ...(projectId ? { project_id: projectId } : {}),
      },
      success_url: product
        ? `${origin}/commissioned?session_id={CHECKOUT_SESSION_ID}`
        : `${origin}/?deposit=success&session_id={CHECKOUT_SESSION_ID}`,
      // A buyer who came from a shared project page has no use for the qualifier, and the link is a credential that does
      // not belong in a URL Stripe stores: they return to the price list.
      cancel_url: product && !fromBuyerLink ? `${origin}/qualify?purchase=cancelled` : `${origin}/pricing?deposit=cancelled`,
    });

    // Stripe returned a hosted-page URL. This is NOT a payment (nothing is charged until the buyer pays on Stripe's page, and the
    // buyer returning from it proves nothing): the only payment evidence is the webhook's engagement_commissioned / subscription_started.
    outcomeRecorded = true;
    if (session.url) {
      await recordCheckoutEvent("checkout_session_created", { kind: funnelKind });
    } else {
      // No URL is no usable session, whatever Stripe's object says: the buyer has nowhere to pay, so this is a failure, not an ok.
      await refused("stripe_session_failed");
      await releaseFoundingReservation(foundingReservation);
      return NextResponse.json({ ok: false, error: "Could not start checkout" }, { status: 502 });
    }

    // Best-effort AI-origin tag: the workspace's CommercialActionCard passes
    // context: `workspace-${productId}` (see components/ai/CommercialActionCard.tsx),
    // which lands here as `service` and is carried into Stripe metadata.service so
    // the webhook can recognise the same session on completion. This is a tag, not
    // session tracking — no new infrastructure, no new identifiers.
    if (service?.startsWith("workspace-")) {
      console.log("[GridForge] ai_checkout_started", {
        productId: productId ?? null,
        service,
        sessionId: session.id,
      });
    }

    return NextResponse.json({
      ok: true,
      url: session.url,
      ...(wantsFounding && !product ? { founding_applied: applyFounding } : {}),
    });
  } catch (err) {
    console.error("[GridForge] Stripe checkout error:", err);
    if (!outcomeRecorded) await refused("stripe_session_failed");
    await releaseFoundingReservation(foundingReservation);
    return NextResponse.json(
      { ok: false, error: "Could not start checkout" },
      { status: 500 }
    );
  }
}
