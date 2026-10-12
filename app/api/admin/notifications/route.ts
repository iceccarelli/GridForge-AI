import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { actOnNotification, listNotifications, summarise, sweepNotifications } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authed(): Promise<boolean> {
  const store = await cookies();
  return verifyAdminCookie(store.get(ADMIN_COOKIE)?.value);
}

const unavailable = () =>
  NextResponse.json({ ok: false, error: "The notification outbox is not available (migration 0021 not applied, or the store is unreachable)." }, { status: 503 });

// Notifications that are not finished: ids, kinds, states, attempt counts, reopen counts and failure
// CATEGORIES. Never a recipient, a link, a token, a message body or a dedupe key.
export async function GET(req: Request) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const state = new URL(req.url).searchParams.get("state") === "all" ? "all" : "open";
  const r = await listNotifications(state);
  if (!r.available) return unavailable();
  return NextResponse.json({ ok: true, items: r.items });
}

// { id, action? } acts on one notification: "retry" (default) sends again now (an abandoned or ambiguous one is
// reopened and counted), "confirm_sent" records that an operator verified the customer received it.
// {} works through whatever is due. The message is rebuilt from the stored business record, so nothing
// sensitive crosses this route. Every action is logged by notification id and outcome only.
export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { id?: unknown; action?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body = sweep */ }
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !UUID.test(body.id)) {
      return NextResponse.json({ ok: false, error: "id must be a notification id" }, { status: 400 });
    }
    const action = body.action === undefined ? "retry" : body.action;
    if (action !== "retry" && action !== "confirm_sent") {
      return NextResponse.json({ ok: false, error: "action must be retry or confirm_sent" }, { status: 400 });
    }
    const nid: string = body.id;
    const o = await actOnNotification(nid, action);
    console.log(`[GridForge] admin notification action ${action} on ${nid}: ${o.state}`);
    if (o.state === "unavailable") return unavailable();
    return NextResponse.json({ ok: true, outcome: o });
  }
  const s = await sweepNotifications();
  if (!s.available) return unavailable();
  console.log(`[GridForge] admin notification sweep: ${JSON.stringify(summarise(s.outcomes, true))}`);
  return NextResponse.json({ ok: true, summary: summarise(s.outcomes, true), outcomes: s.outcomes });
}
