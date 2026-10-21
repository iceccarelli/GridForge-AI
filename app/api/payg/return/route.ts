import { NextResponse } from "next/server";
import { siteUrl } from "@/lib/site";
import { clearedReturnCookie, readReturnCookie } from "@/lib/payg-return";

export const runtime = "nodejs";

/**
 * GET ?payg=success|cancelled -> where Stripe Checkout sends the customer back to, with NO token in the URL.
 * The portal token comes from the short-lived HttpOnly cookie the starting route set (lib/payg-return.ts); with it, a redirect to the
 * portal page; without it (a different browser, an expired window) a plain page that says to open the emailed link.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("payg");
  const outcome = q === "success" || q === "cancelled" ? q : "cancelled";
  const token = readReturnCookie(req);
  if (token) {
    const res = NextResponse.redirect(siteUrl(`/api-access/${token}?payg=${outcome}`), 303);
    res.headers.append("Set-Cookie", clearedReturnCookie());
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  const said = outcome === "success" ? "Your card was received. It can take a few seconds to show on your account." : "Nothing was changed.";
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>GridForge</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Back from checkout</h1><p>${said}</p><p>To see your account, open the link in the email we sent you when you created it. It is the only way in, and it always works.</p></body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clearedReturnCookie() } }
  );
}
