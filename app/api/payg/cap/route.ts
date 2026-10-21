import { NextResponse } from "next/server";
import { signingConfigured, mintChecked, inspectKey } from "@/lib/api-access";
import { recordFunnelEvent } from "@/lib/funnel";
import { readBoundedJson } from "@/lib/http-body";
import { PAYG, accountRef, parseCapEur, paygCapUnits } from "@/lib/payg";
import { accountByToken } from "@/lib/payg-accounts";
import { guardRequest } from "@/lib/rate-limit";
import { meteredUnavailable } from "@/lib/api-readiness";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;

/**
 * POST { token, cap_eur } -> a NEW key, once (same shape as /api/keys when it mints).
 *
 * The cap lives in the signed key, which the engine verifies offline, so changing it means minting a new key and revoking the
 * previous id: there is no way to edit a cap in place and no way to leave the old, differently-capped key working. The cap is
 * validated here, against the catalogue's bounds, whatever the page sent. The account row and the key are written in ONE
 * compare-and-set write, so a concurrent mint cannot leave the row saying one cap while a live key carries another.
 */
export async function POST(req: Request) {
  if (!signingConfigured()) {
    return NextResponse.json({ ok: false, error: "Key signing is not configured on this deployment." }, { status: 503 });
  }
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
  // A cap change mints and rotates a payg key: only against an engine that is proven to honour it.
  const closed = await meteredUnavailable();
  if (closed) return closed;

  const acct = token ? await accountByToken(token) : null;
  if (acct === "error") return NextResponse.json({ ok: false, error: "This is unavailable just now. Nothing was changed." }, { status: 503 });
  if (!acct) return NextResponse.json({ ok: false, error: "Unknown account" }, { status: 404 });
  if (acct.plan !== "api_payg") {
    return NextResponse.json({ ok: false, error: "A cap can only be set once pay-as-you-go is enabled.", fix: "enable_payg" }, { status: 409 });
  }
  if (acct.status !== "active") {
    return NextResponse.json(
      { ok: false, error: acct.status === "cancelled" ? "This account has been cancelled." : "A payment on this account has not cleared, so the cap cannot be changed yet.", status: acct.status },
      { status: 402 }
    );
  }

  const units = paygCapUnits(cap);
  const out = await mintChecked(acct, {
    rotate: true,
    entitlement: { scope: "payg", quota: units },
    extra: { cap_units: units, monthly_units: units },
  });
  if (!out.ok) {
    if (out.reason === "conflict") {
      return NextResponse.json({ ok: false, error: "Another key change happened at the same moment. Nothing was changed; reload and try again." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: out.message ?? "Could not change the cap. Nothing was changed." }, { status: out.reason === "refused" ? 409 : 500 });
  }
  const m = out.result;
  await recordFunnelEvent("key_minted", { scope: "payg", plan: "api_payg", account_ref: accountRef(acct.account), reason: "cap_change" }, { dedupeKey: `key_minted:${inspectKey(m.token)?.k ?? ""}` });
  return NextResponse.json({
    ok: true,
    issued: true,
    key: m.token,
    expires: m.expires,
    cap_eur: (units * PAYG.unitPriceCents) / 100,
    cap_units: units,
    replaced_expired_key: false,
    revoked_previous: m.engine_revoked === true,
    ...(m.previous && m.engine_revoked !== true
      ? {
          revocation_pending: true,
          revocation_note:
            "The new key is live, but the engine has not yet confirmed that the previous one is revoked. It is recorded as unconfirmed and a daily job keeps retrying it; until the engine confirms, treat the old key as still working.",
        }
      : {}),
    ...(m.rotation_deferred
      ? {
          // The engine could not be shown to accept THIS key, so the one it replaces was NOT revoked: handing over a new key and killing the old
          // one in the same breath could leave the customer with nothing that works.
          rotation_deferred: true,
          new_key_unverified: true,
          rotation_note:
            "The new key could not be checked against the engine just now (it was unreachable, or did not accept the key), so your PREVIOUS key was not revoked and stays valid " +
            "until the engine has verified the new one. Keep using the previous key until you have confirmed the new one works, for example by calling GET /v1/version with it; " +
            "a daily job revokes the previous key as soon as the engine verifies keys again.",
        }
      : {}),
    warning: "Copy this now. It is shown once and is not stored anywhere we can read it back.",
  });
}
