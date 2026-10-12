import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { enqueueSelected, inventoryUnnotified } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authed(): Promise<boolean> {
  const store = await cookies();
  return verifyAdminCookie(store.get(ADMIN_COOKIE)?.value);
}

// Paid records made BEFORE the outbox existed have no notification obligation, so nothing would ever retry
// their email. GET is a DRY RUN: counts and record ids with an eligibility reason -- never an address, link or
// token -- and it sends nothing. POST { selection: [{ kind, subject_id }] } (max 50) enqueues exactly those
// records, rechecking eligibility and deduplicating; it creates no purchase, account or deliverable and does
// not send either: delivery is the normal sweep (or an explicit retry). Deploying or migrating sends nothing.
export async function GET() {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const inv = await inventoryUnnotified();
  if (!inv.available) {
    return NextResponse.json({ ok: false, error: "The notification outbox is not available (migration 0021 not applied, or the store is unreachable)." }, { status: 503 });
  }
  const byKind: Record<string, { eligible: number; ineligible: number }> = {};
  for (const c of inv.candidates) {
    const k = (byKind[c.kind] ??= { eligible: 0, ineligible: 0 });
    if (c.eligible) k.eligible++; else k.ineligible++;
  }
  return NextResponse.json({ ok: true, dry_run: true, counts: byKind, candidates: inv.candidates });
}

export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { selection?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const sel = body.selection;
  if (!Array.isArray(sel) || sel.length === 0 || sel.length > 50 ||
      !sel.every((x) => x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string" && typeof (x as { subject_id?: unknown }).subject_id === "string")) {
    return NextResponse.json({ ok: false, error: "selection must be 1-50 items of { kind, subject_id }" }, { status: 400 });
  }
  const r = await enqueueSelected(sel as { kind: string; subject_id: string }[]);
  if (!r.available) {
    return NextResponse.json({ ok: false, error: "The notification outbox is not available (migration 0021 not applied, or the store is unreachable)." }, { status: 503 });
  }
  console.log(`[GridForge] admin reconcile: enqueued ${r.enqueued}, already present ${r.alreadyPresent}, rejected ${r.rejected.length}`);
  return NextResponse.json({ ok: true, enqueued: r.enqueued, already_present: r.alreadyPresent, rejected: r.rejected });
}
