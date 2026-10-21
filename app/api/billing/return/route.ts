import { NextResponse } from "next/server";
import { siteUrl } from "@/lib/site";
import { clearedBillingReturnCookie, readBillingReturn } from "@/lib/payg-return";

export const runtime = "nodejs";

/**
 * GET -> where Stripe's Billing Portal sends the customer back to, with NO token in the URL. The token comes from the short-lived HttpOnly
 * cookie /api/billing/portal set: with it, a redirect to the account's own page; without it (another browser, an expired window) a plain
 * page saying to open the emailed link.
 */
export async function GET(req: Request) {
  const back = readBillingReturn(req);
  if (back) {
    const path = back.subject === "watch" ? `/watch/${back.token}` : `/api-access/${back.token}`;
    const res = NextResponse.redirect(siteUrl(`${path}?billing=returned`), 303);
    res.headers.append("Set-Cookie", clearedBillingReturnCookie());
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>GridForge</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Back from billing</h1><p>Any change you made is saved with Stripe and reaches your account within a minute.</p>` +
      `<p>To see your account, open the link in the email we sent you. It is the only way in, and it always works.</p></body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clearedBillingReturnCookie() } }
  );
}
