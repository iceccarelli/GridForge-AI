import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { listNotifications, retryNotification, sweepNotifications } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authed(): Promise<boolean> {
  const store = await cookies();
  return verifyAdminCookie(store.get(ADMIN_COOKIE)?.value);
}

// The customer emails that have not been accepted yet: ids, kinds, states, attempt counts and failure
// categories. Never a recipient, a link or a message body.
export async function GET(req: Request) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const state = new URL(req.url).searchParams.get("state") === "all" ? "all" : "open";
  const r = await listNotifications(state);
  if (!r.available) {
    return NextResponse.json({ ok: false, error: "The notification outbox is not available (migration 0021 not applied, or the store is unreachable)." }, { status: 503 });
  }
  return NextResponse.json({ ok: true, items: r.items });
}

// { id } retries that notification now (an abandoned one is reopened); {} works through whatever is due.
// The message is rebuilt from the stored business record, so nothing sensitive crosses this route.
export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { id?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body = sweep */ }
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !UUID.test(body.id)) {
      return NextResponse.json({ ok: false, error: "id must be a notification id" }, { status: 400 });
    }
    const o = await retryNotification(body.id);
    if (o.state === "unavailable") return NextResponse.json({ ok: false, error: "The notification outbox is not available." }, { status: 503 });
    return NextResponse.json({ ok: true, outcome: o });
  }
  const s = await sweepNotifications();
  if (!s.available) return NextResponse.json({ ok: false, error: "The notification outbox is not available." }, { status: 503 });
  return NextResponse.json({ ok: true, outcomes: s.outcomes });
}
