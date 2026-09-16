import { NextResponse } from "next/server";
import { lookupSubscription, normaliseEmail, subscriptionsConfigured } from "@/lib/subscribers";

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
  let body: { email?: string } = {};
  try {
    body = (await req.json()) as { email?: string };
  } catch {
    return NextResponse.json({ ok: false, active: false, error: "Invalid payload" }, { status: 400 });
  }
  const email = normaliseEmail(body?.email);
  if (!email) return NextResponse.json({ ok: true, active: false });

  if (!subscriptionsConfigured()) {
    return NextResponse.json(
      { ok: false, active: false, error: "Subscription store unavailable" },
      { status: 503 }
    );
  }

  const found = await lookupSubscription(email);
  if (!found.reachable) {
    // A store we could not ask says nothing about this customer. Answering
    // `active: false` here is what showed a paying subscriber the upgrade prompt.
    return NextResponse.json(
      { ok: false, active: false, error: "Subscription store unavailable" },
      { status: 503 }
    );
  }
  if (!found.subscription) return NextResponse.json({ ok: true, active: false });
  return NextResponse.json({ ok: true, active: true, plan: found.subscription.plan });
}
