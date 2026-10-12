import { NextResponse } from "next/server";
import { sweepNotifications } from "@/lib/notifications";

export const runtime = "nodejs";
export const maxDuration = 120;

// Retries the customer emails that were not accepted the first time, within their bounded schedule.
// Same authorization as the other crons (CRON_SECRET). Harmless before migration 0021 is applied:
// it reports the outbox as unavailable and does nothing.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secret || given !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const s = await sweepNotifications();
  const count = (state: string) => s.outcomes.filter((o) => o.state === state).length;
  return NextResponse.json({ ok: true, available: s.available, attempted: s.outcomes.length, accepted: count("accepted"), pending: count("pending"), abandoned: count("abandoned") });
}
