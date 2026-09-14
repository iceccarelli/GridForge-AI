import { NextResponse } from "next/server";
import { getApiAccount, mintForAccount, signingConfigured } from "@/lib/api-access";

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
  return NextResponse.json({
    ok: true,
    account: {
      account: row.account,
      plan: row.plan,
      monthly_units: row.monthly_units,
      status: row.status,
      key_id: row.key_id,
      key_expires_at: row.key_expires_at,
      has_key: Boolean(row.key_id),
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
  if (row.key_id && !rotate) {
    return NextResponse.json({
      ok: true,
      issued: false,
      key_id: row.key_id,
      expires: row.key_expires_at,
      note:
        "A key is already live for this account. We do not store it, so it cannot be " +
        "shown again — rotate to replace it, which revokes the current one.",
    });
  }

  const minted = await mintForAccount(row, { rotate });
  if (!minted) {
    return NextResponse.json({ ok: false, error: "Could not issue a key" }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    issued: true,
    key: minted.token,
    expires: minted.expires,
    revoked_previous: rotate && Boolean(row.key_id),
    warning:
      "Copy this now. It is shown once and is not stored anywhere we can read it back.",
  });
}
