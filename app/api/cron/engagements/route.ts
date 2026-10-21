import { NextResponse } from "next/server";
import { cronAuthorised } from "@/lib/cron-auth";
import { recoverStaleGenerating, type DeliverableRecord } from "@/lib/deliverables";
import { notifyOperator } from "@/lib/mail";
import { PRODUCT_BY_KIND } from "@/lib/products";
import { rest } from "@/lib/pgrest";
import { sweepNotices } from "@/lib/watch-notices";
import { sendDailyDigest } from "@/lib/attention";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The sweep for paid work that is not moving by itself. Every 30 minutes (vercel.json).
//
//   1. A `generating` engagement whose request has died. Generation runs inside one request (maxDuration 120 s); if the
//      platform kills it, the row stays `generating`. The customer is refused for ever ("already being processed") and
//      no recovery action applied. This moves such a row to `engine_unavailable`, where the customer can resubmit and the
//      operator can Regenerate or Reopen, and tells the operator ONCE: only the invocation that actually moves a row sends.
//   3. The daily digest of everything that needs a person (lib/attention.ts sendDailyDigest): one email a day, idempotent per day.
//   2. A Hall Watch change note whose email has not gone out: the retry of the durable obligation (lib/watch-notices.ts).
//
// It reads and moves state only. It generates nothing, releases nothing and emails no buyer about an engagement.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const stuck = await rest<Pick<DeliverableRecord, "id" | "token" | "kind" | "status" | "intake" | "created_at" | "email">[]>(
    "GET",
    "deliverables?status=eq.generating&select=id,token,kind,status,email,intake,created_at&limit=200"
  );
  // A read that failed says nothing about whether anything is stuck; report it, do not report "none".
  const recovered: { id: string; kind: string }[] = [];
  let errors = 0;
  if (!stuck.ok) errors += 1;
  else {
    for (const row of stuck.data ?? []) {
      const r = await recoverStaleGenerating(row);
      if (r === "recovered") recovered.push({ id: row.id, kind: row.kind });
      else if (r === "error") errors += 1;
    }
  }
  if (recovered.length) {
    await notifyOperator(
      `${recovered.length} paid engagement(s) were stuck generating — moved to engine_unavailable`,
      `Their generation request ended without storing a result: ${recovered
        .map((r) => `${PRODUCT_BY_KIND[r.kind]?.name ?? r.kind} (${r.id})`)
        .join(", ")}.\n\nThe buyer's numbers are saved. Use Regenerate at ${SITE_URL}/admin/pipeline, or the buyer can resubmit their intake. Nothing was released.`
    );
  }

  const notices = await sweepNotices();
  // The operator's list is pull-only otherwise: once a day (the first run at or after the digest hour) it is pushed.
  const digest = await sendDailyDigest();
  return NextResponse.json({
    ok: stuck.ok && errors === 0,
    stale_generating_recovered: recovered.length,
    read_error: !stuck.ok,
    errors,
    watch_notices: notices.available ? notices.outcomes : "table_unavailable",
    digest,
  });
}
