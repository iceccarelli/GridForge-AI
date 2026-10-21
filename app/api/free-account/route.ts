import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { normaliseFreeEmail } from "@/lib/payg";
import { createFreeAccount } from "@/lib/payg-accounts";
import { guardRequest } from "@/lib/rate-limit";
import { meteredUnavailable } from "@/lib/api-readiness";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2 * 1024;

/**
 * POST { email, company? } -> the free developer allowance, no card.
 *
 * The answer is the SAME whether the address is new or already has an account, so this route cannot be used to learn who has one.
 * The site-wide monthly ceiling is NOT applied here (it counts VERIFIED accounts, at the first key mint from the emailed link), so
 * this answer can neither be used up by addresses nobody owns nor reveal which addresses already have an account. No key is
 * returned: the key is minted from the emailed portal link, which is the email verification.
 */
export async function POST(req: Request) {
  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { email?: unknown; company?: unknown };
  if (!normaliseFreeEmail(body.email)) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }
  // Admitted after validation, before anything is written or any email is queued.
  const g = await guardRequest(req, "free_account");
  if (g.denied) return g.denied;
  // A free allowance is a promise the engine must be able to keep (a recorded, capped key): not made against an engine that cannot.
  const closed = await meteredUnavailable();
  if (closed) return closed;

  const r = await createFreeAccount(body.email, body.company);
  if (!r.ok) {
    console.error(`[GridForge] free account request failed: ${r.reason}`);
    return NextResponse.json({ ok: false, error: "We could not set this up just now. Nothing was created; try again shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (r.delivery === "retry") {
    return NextResponse.json({ ok: false, error: "We could not queue the email just now. Try again shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { ok: true, message: "If this address can receive a free allowance, a link to create your key is on its way. The link is the email verification; no card is needed." },
    { headers: { "Cache-Control": "no-store" } }
  );
}
