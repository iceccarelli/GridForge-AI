import { NextResponse } from "next/server";
import { meteredReadiness } from "@/lib/api-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether free developer keys and pay-as-you-go are open on this deployment: a yes/no, so a form can say so before anyone types
 * into it. The reason (which part of the engine falls short) goes to the log, never to the visitor. The answer comes from
 * lib/api-readiness.ts, which asks the engine itself and caches the result per process, so this route adds one engine round trip
 * per five minutes at most however often it is called, and spends no units.
 */
export async function GET() {
  const r = await meteredReadiness();
  return NextResponse.json({ ok: true, open: r.ready }, { headers: { "Cache-Control": "no-store" } });
}
