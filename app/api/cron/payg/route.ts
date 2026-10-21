import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { runPaygCron } from "@/lib/payg-cron";
import { paygStripe } from "@/lib/payg-stripe";
import { engineLedgerFetcher } from "@/lib/payg-usage";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // no secret configured = nothing is authorised
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Daily: retry key revocations, ingest the engine ledger, send usage alerts, settle closed months.
// Header-only authorization with CRON_SECRET, failing CLOSED like /api/cron/notifications. Idempotent end to end: a second run (a
// retry, an overlap, a manual call) ingests nothing twice, alerts nothing twice and invoices no month twice (lib/payg-settle.ts).
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const report = await runPaygCron({ fetcher: engineLedgerFetcher(), stripe: paygStripe() });
  return NextResponse.json({ ok: true, ...report });
}
