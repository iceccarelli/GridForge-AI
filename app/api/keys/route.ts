import { NextResponse } from "next/server";
import { getApiAccount, keyEntitlement, keyLife, mintChecked, signingConfigured } from "@/lib/api-access";
import { recordFunnelEvent } from "@/lib/funnel";
import { accountRef } from "@/lib/payg";

export const runtime = "nodejs";

/**
 * The customer's key, and rotation.
 *
 * Authenticated by the account's portal token — the same pattern as /deliverable
 * and /watch. The token is the credential; there is no password to forget and
 * nothing to reset.
 *
 * GET  returns the account and the state of its key, never the key itself. A key
 *      is shown exactly once, at the moment it is minted. Anything else means
 *      storing a working credential somewhere it can be read back, which is the
 *      thing this design exists to avoid.
 * POST mints one: on first visit, when the current one is near expiry, or on an
 *      explicit rotation. Rotating revokes the previous id — a leaked key that
 *      keeps working until it expires is not rotated, it is duplicated.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") || "";
  const row = token ? await getApiAccount(token) : null;
  if (!row) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  // has_key alone reported a dead credential as a live one. The portal needs to
  // be able to say "this stops working on Thursday" while there is still time to
  // act, which is the difference between a rotation and an outage.
  const life = keyLife(row);
  return NextResponse.json({
    ok: true,
    account: {
      account: row.account,
      plan: row.plan,
      monthly_units: row.monthly_units,
      status: row.status,
      key_id: row.key_id,
      key_expires_at: row.key_expires_at,
      key_scope: row.key_scope ?? null,
      has_key: life.has_key,
      expired: life.expired,
      days_left: life.days_left,
      needs_rotation: life.needs_rotation,
      revoked: (row.revoked_key_ids ?? []).length,
      company: row.company,
      email: row.email,
    },
    signing_configured: signingConfigured(),
  });
}

export async function POST(req: Request) {
  if (!signingConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Key signing is not configured on this deployment. GRIDFORGE_KEY_SECRET must be " +
          "set here and on the engine, to the same value.",
      },
      { status: 503 }
    );
  }
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body means "issue if I have none" */
  }
  const token = typeof body.token === "string" ? body.token : "";
  const rotate = body.rotate === true;

  const row = token ? await getApiAccount(token) : null;
  if (!row) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  if (row.status === "cancelled") {
    return NextResponse.json(
      { ok: false, error: "This subscription has been cancelled. Restart it to issue a key." },
      { status: 402 }
    );
  }
  // Only an ACTIVE subscription mints. A key lasts 35 days, so letting a past_due account mint or rotate
  // hands out a month of access against a payment that has not cleared. Reading status/usage stays open
  // (GET); the key is minted again once the payment clears and the account returns to active.
  if (row.status !== "active") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Your latest payment has not cleared, so a new key cannot be issued yet. " +
          "Update your payment method; you can mint a key as soon as the payment succeeds.",
        status: row.status,
      },
      { status: 402 }
    );
  }
  // Three reasons to mint, and only the first and third were implemented. The
  // second is the one a paying customer hits: the key aged out under them, the
  // engine told them to "reissue from your account page", and this answered "a
  // key is already live for this account". A closed loop with a live
  // subscription on the far side of it.
  const life = keyLife(row);
  // What this plan's key must carry. A bounded plan (free allowance, pay-as-you-go) with no bound on record is refused, never
  // minted as an unbounded key; and a live key of the WRONG scope (the free key after pay-as-you-go was enabled) is replaced.
  const want = keyEntitlement(row);
  if (!want.ok) return NextResponse.json({ ok: false, error: want.error }, { status: 409 });
  const wrongScope = Boolean(row.key_id) && Boolean(row.key_scope) && row.key_scope !== want.scope;
  if (!rotate && !life.needs_rotation && !wrongScope) {
    return NextResponse.json({
      ok: true,
      issued: false,
      key_id: row.key_id,
      expires: row.key_expires_at,
      days_left: life.days_left,
      note:
        "A key is already live for this account. We do not store it, so it cannot be " +
        "shown again — rotate to replace it, which revokes the current one.",
    });
  }

  // Revoke what we replace ONLY when it is already dead, or when rotation was
  // asked for explicitly. A key inside the rotation window is still deployed and
  // still working: killing it the moment we mint its successor would turn a
  // warning into the outage the warning exists to prevent. The two overlap until
  // the old one expires on its own.
  const supersede = rotate || life.expired || wrongScope;
  const out = await mintChecked(row, { rotate: supersede });
  if (!out.ok) {
    // A concurrent mint won the compare-and-set: this key was never recorded, so it is not handed out.
    if (out.reason === "conflict") {
      return NextResponse.json(
        { ok: false, error: "A key was issued for this account at the same moment. Reload to see its state; nothing was changed by this request." },
        { status: 409 }
      );
    }
    if (out.reason === "refused") return NextResponse.json({ ok: false, error: out.message ?? "A key cannot be issued for this account." }, { status: 409 });
    return NextResponse.json({ ok: false, error: "Could not issue a key" }, { status: 500 });
  }
  const minted = out.result;
  await recordFunnelEvent("key_minted", { scope: want.scope, plan: row.plan, account_ref: accountRef(row.account) });
  return NextResponse.json({
    ok: true,
    issued: true,
    key: minted.token,
    expires: minted.expires,
    replaced_expired_key: life.expired,
    // True only when the engine confirmed the previous id is revoked. Never inferred from intent.
    revoked_previous: minted.engine_revoked === true,
    ...(supersede && minted.previous && minted.engine_revoked !== true
      ? {
          revocation_pending: true,
          revocation_note:
            "The new key is live, but the engine has not yet confirmed that the previous one is revoked. " +
            "It is recorded as unconfirmed and a daily job keeps retrying it until the engine confirms; " +
            "until then, treat the old key as still working.",
        }
      : {}),
    ...(!supersede && minted.previous
      ? { previous_key_overlaps_until_expiry: true }
      : {}),
    warning:
      "Copy this now. It is shown once and is not stored anywhere we can read it back.",
  });
}
