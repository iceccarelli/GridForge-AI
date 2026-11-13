import { NextResponse } from "next/server";
import {
  createScenario,
  deleteScenario,
  listScenarios,
  lookupSubscription,
  subscriptionsConfigured,
} from "@/lib/subscribers";
import { identify, identityRefusal } from "@/lib/portal";
import { guardRequest } from "@/lib/rate-limit";
import { readBoundedJson } from "@/lib/http-body";
import { MAX_SCENARIOS_PER_SUBSCRIBER, MAX_SCENARIO_BODY_BYTES } from "@/lib/scenario-limits";

export const runtime = "nodejs";

// Saved scenarios belong to a GridForge Intelligence subscriber. Every handler
// here answers three questions in the same order — who is asking, are they
// entitled, and did the store actually do the thing — and the third one used to
// be skipped: the table had no migration, PostgREST returned 404, `fetch` does
// not throw on 404, and the route reported `ok: true` with nothing written.
//
// So a store that cannot answer is a 503 now, never an empty list. An empty list
// means the subscriber has saved nothing; it must never also mean "the database
// is missing".

/**
 * Who is asking: the email comes from the verified Supabase bearer token and from
 * nowhere else. A caller-supplied `email` (query or body) is ignored — it used to be
 * the only credential, so anyone who knew a subscriber's address could read, create
 * and delete their scenarios.
 */
async function whoIs(req: Request) {
  const id = await identify(req);
  if (!id.ok) {
    return {
      email: "",
      denied: identityRefusal(id),
    };
  }
  // A session that merely claims an address (no emailed link followed) must not drive an entitlement lookup for it: that lookup can ask
  // Stripe about, and clear a stale pause on, somebody else's subscription, and its latency tells a stranger what state it is in.
  if (!id.verified) {
    return {
      email: "",
      denied: NextResponse.json({ ok: false, error: "Confirm your email address by signing in with the emailed link, then try again." }, { status: 403 }),
    };
  }
  return { email: id.email, denied: null };
}

/** 402, not 403: they are authenticated, they are simply not a subscriber. */
function notEntitled() {
  return NextResponse.json(
    { ok: false, error: "An active GridForge Intelligence subscription is required." },
    { status: 402 }
  );
}

function storeUnavailable() {
  return NextResponse.json(
    { ok: false, error: "Scenario storage is unavailable." },
    { status: 503 }
  );
}

/**
 * Deny, but do not lie about why.
 *
 * The gate still fails closed when the store cannot be reached — that is the safe
 * direction. What it must not do is report the denial as 402, because 402 is a
 * statement about the CUSTOMER ("you have not subscribed") and an unreachable
 * store is a statement about US. Returning `null` means the caller is entitled and
 * may proceed.
 */
async function denyIfNotEntitled(email: string) {
  const found = await lookupSubscription(email);
  if (!found.reachable) return storeUnavailable();
  if (!found.subscription) return notEntitled();
  return null;
}

// GET -> list this subscriber's saved scenarios
export async function GET(req: Request) {
  const who = await whoIs(req);
  if (who.denied) return who.denied;
  const email = who.email;
  if (!subscriptionsConfigured()) return storeUnavailable();
  const denied = await denyIfNotEntitled(email);
  if (denied) return denied;

  const scenarios = await listScenarios(email);
  if (scenarios === null) return storeUnavailable();
  return NextResponse.json({ ok: true, scenarios });
}

// POST -> save a scenario
export async function POST(req: Request) {
  const who = await whoIs(req);
  if (who.denied) return who.denied;
  const email = who.email;
  // Bounded before it is parsed: a save is a name, a region id and four numbers.
  const read = await readBoundedJson(req, MAX_SCENARIO_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ ok: false, error: read.status === 413 ? "That request is too large." : "Invalid payload" }, { status: read.status });
  }
  const b = read.value as Record<string, unknown>;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  if (!subscriptionsConfigured()) return storeUnavailable();
  const denied = await denyIfNotEntitled(email);
  if (denied) return denied;

  // Identified, entitled and well-formed: now admitted (and counted) per verified account, so a subscriber's loop cannot write rows without
  // bound. A request refused above costs nothing.
  const g = await guardRequest(req, "scenario_save", { account: { verifiedEmail: email, policy: "scenario_save" }, accountOnly: true });
  if (g.denied) return g.denied;

  // A per-subscriber cap, enforced here before the write (see lib/scenario-limits.ts: a count then an insert, not a transaction).
  const existing = await listScenarios(email);
  if (existing === null) return storeUnavailable();
  if (existing.length >= MAX_SCENARIOS_PER_SUBSCRIBER) {
    return NextResponse.json(
      {
        ok: false,
        error: `You have saved the maximum of ${MAX_SCENARIOS_PER_SUBSCRIBER} scenarios. Delete one you no longer need, then save again.`,
        limit: MAX_SCENARIOS_PER_SUBSCRIBER,
      },
      { status: 409 }
    );
  }

  // Bound every field before it reaches the store. A name is a display string, so
  // it is truncated rather than rejected; a number that is not a number is zero,
  // never NaN, because NaN serialises to null and lands as a null in a NOT NULL
  // column — a 400 from the database instead of a 400 from us.
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const scenario = await createScenario({
    email,
    name: String(b.name ?? "").trim().slice(0, 80) || "Untitled site",
    mw: num(b.mw),
    regionId: String(b.regionId ?? "").slice(0, 64),
    valuePerMwMonth: num(b.valuePerMwMonth),
    monthsSaved: num(b.monthsSaved),
    avoidedEur: Math.round(num(b.avoidedEur)),
  });
  if (!scenario) return storeUnavailable();
  return NextResponse.json({ ok: true, scenario });
}

// DELETE ?id= -> remove one
export async function DELETE(req: Request) {
  const who = await whoIs(req);
  if (who.denied) return who.denied;
  const email = who.email;
  const id = (new URL(req.url).searchParams.get("id") || "").trim();
  if (!id) {
    return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
  }
  if (!subscriptionsConfigured()) return storeUnavailable();
  const denied = await denyIfNotEntitled(email);
  if (denied) return denied;

  // deleteScenario filters on id AND email in one statement, so a subscriber
  // guessing another's uuid deletes nothing. It is reported as a 404 — a miss —
  // rather than as a success, which is what a cross-tenant attempt should look
  // like from the outside: indistinguishable from a row that never existed.
  const removed = await deleteScenario(email, id);
  if (!removed) {
    return NextResponse.json({ ok: false, error: "No such scenario" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
