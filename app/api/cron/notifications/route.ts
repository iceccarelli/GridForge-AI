import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { summarise, sweepNotifications } from "@/lib/notifications";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;                                    // no secret configured = nothing is authorised
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Retries the customer emails that were not accepted the first time, within their bounded schedule.
// Header-only authorization with CRON_SECRET (Vercel sends it as `Authorization: Bearer $CRON_SECRET` when the
// variable is set). It fails CLOSED: with no CRON_SECRET this route answers 401 to everyone, so a scheduled
// recovery does not exist until the variable does -- the schedule in vercel.json alone proves nothing.
// Harmless before migration 0021: it reports the outbox as unavailable and does nothing.
// Counters are distinct on purpose: "accepted" is provider-accepted AND durably recorded, never "delivered".
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const s = await sweepNotifications();
  return NextResponse.json({ ok: true, ...summarise(s.outcomes, s.available) });
}
