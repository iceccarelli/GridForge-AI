import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/http-body";
import { identify } from "@/lib/portal";
import { guardRequest } from "@/lib/rate-limit";
import { subscriptionsConfigured } from "@/lib/subscribers";
import { redeemInvitation, type RedeemAction } from "@/lib/team";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;
const ACTIONS: ReadonlySet<string> = new Set(["preview", "accept", "decline"]);

// POST { token, action: "preview" | "accept" | "decline" } -> the invitee's side.
//
// Two things must both be true: the caller holds the secret from the emailed link, AND the address Supabase has verified for
// their session is the address that was invited. The invited address is never read from the request; the database compares the
// token's invitation against the verified identity and answers a mismatch like an unknown secret.
export async function POST(req: Request) {
  const who = await identify(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  if (!who.verified) {
    return NextResponse.json({ ok: false, error: "Confirm your email address by signing in with the emailed link, then try again." }, { status: 403 });
  }

  const read = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  const body = (read.value && typeof read.value === "object" && !Array.isArray(read.value) ? read.value : {}) as { token?: unknown; action?: unknown };
  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });

  if (!subscriptionsConfigured()) {
    return NextResponse.json({ ok: false, error: "Team membership is unavailable just now." }, { status: 503 });
  }
  const g = await guardRequest(req, "team_redeem");
  if (g.denied) return g.denied;

  const r = await redeemInvitation(action as RedeemAction, who.email, body.token);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, reason: r.reason }, { status: r.status });
  return NextResponse.json({ ok: true, action, ownerEmail: r.ownerEmail, plan: r.plan, expiresAt: r.expiresAt });
}
