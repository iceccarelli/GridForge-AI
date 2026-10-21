import { NextResponse } from "next/server";
import { identify } from "@/lib/portal";
import { lookupEntitlement, subscriptionsConfigured } from "@/lib/subscribers";

export const runtime = "nodejs";

// Whether a given email has an active GridForge Intelligence subscription.
// /account gates the paid view on this.
//
// The distinction that matters: `active: false` means "this person is not a
// subscriber", and it is what the page shows an upgrade prompt for. It must never
// also mean "we could not reach the store" — for two patches it did, because the
// `subscriptions` table had no migration and a 404 from PostgREST was swallowed
// into a plain false. A paying customer was shown the upgrade prompt.
//
// So a store we cannot reach is a 503 and the page can say so, rather than
// telling a subscriber they have not subscribed.
export async function POST(req: Request) {
  // The email is the verified bearer token's, never the request body's: asking
  // "is this address a subscriber" about anybody was an enumeration oracle.
  const who = await identify(req);
  if (!who.ok) {
    return NextResponse.json({ ok: false, active: false, error: who.error }, { status: who.status });
  }
  const email = who.email;

  // A session that merely claims an address (Supabase has not confirmed it: no emailed link was followed) must not learn
  // whether that address subscribes, on what plan, or whose seat it holds. It sees the not-subscribed view, flagged as
  // unverified so the page can say why instead of silently showing an upgrade prompt.
  if (!who.verified) {
    return NextResponse.json({ ok: true, active: false, verified: false });
  }

  if (!subscriptionsConfigured()) {
    return NextResponse.json(
      { ok: false, active: false, error: "Subscription store unavailable" },
      { status: 503 }
    );
  }

  const found = await lookupEntitlement(email);
  if (!found.reachable) {
    // A store we could not ask says nothing about this customer. Answering
    // `active: false` here is what showed a paying subscriber the upgrade prompt.
    return NextResponse.json(
      { ok: false, active: false, error: "Subscription store unavailable" },
      { status: 503 }
    );
  }
  if (!found.entitlement) return NextResponse.json({ ok: true, active: false });
  // `role` says whether this address owns the subscription or holds a seat on someone else's; the page uses it to decide
  // whether to offer seat management, and the server enforces it again on every /api/team route.
  const { subscription, role, ownerEmail } = found.entitlement;
  return NextResponse.json({
    ok: true,
    active: true,
    plan: subscription.plan,
    role,
    ...(role === "member" ? { ownerEmail } : {}),
  });
}
