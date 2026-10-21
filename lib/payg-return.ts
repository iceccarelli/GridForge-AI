// Server-only: how a customer gets back to their portal after Stripe Checkout WITHOUT the portal token in a URL Stripe stores.
//
// The portal token is the account's only credential. Putting it in success_url / cancel_url left it in Stripe's records of the
// session. Instead the routes that start a Checkout (enable, card) answer with a short-lived HttpOnly cookie carrying the token,
// scoped to /api/payg, and Stripe is sent back to a token-free URL (/api/payg/return) which reads that cookie and redirects to the
// portal. With no cookie (another browser, an expired window) the customer is told to open their emailed link, which always works.

export const RETURN_COOKIE = "gf_payg_return";
export const RETURN_PATH = "/api/payg/return";
export const RETURN_MAX_AGE_SECONDS = 3600;

const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
export const isPortalToken = (v: unknown): v is string => typeof v === "string" && TOKEN.test(v);

/** The Set-Cookie value: HttpOnly (page scripts cannot read it), SameSite=Lax (sent on the top-level redirect back from Stripe), Secure in production. */
export function returnCookie(token: string): string {
  return `${RETURN_COOKIE}=${token}; Path=/api/payg; HttpOnly; SameSite=Lax; Max-Age=${RETURN_MAX_AGE_SECONDS}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearedReturnCookie(): string {
  return `${RETURN_COOKIE}=; Path=/api/payg; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function readReturnCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === RETURN_COOKIE) {
      const value = v.join("=");
      return isPortalToken(value) ? value : null;
    }
  }
  return null;
}

// ---- the Billing Portal's way back: the same idea, for an API/PAYG portal token or a Hall Watch token --------------------------------

export const BILLING_RETURN_COOKIE = "gf_billing_return";
export const BILLING_RETURN_PATH = "/api/billing/return";
export type BillingSubject = "api" | "watch";

/** `api:TOKEN` or `watch:TOKEN`: which page to go back to, and the token that opens it. HttpOnly, SameSite=Lax, scoped to /api/billing. */
export function billingReturnCookie(subject: BillingSubject, token: string): string {
  return `${BILLING_RETURN_COOKIE}=${subject}:${token}; Path=/api/billing; HttpOnly; SameSite=Lax; Max-Age=${RETURN_MAX_AGE_SECONDS}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearedBillingReturnCookie(): string {
  return `${BILLING_RETURN_COOKIE}=; Path=/api/billing; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function readBillingReturn(req: Request): { subject: BillingSubject; token: string } | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== BILLING_RETURN_COOKIE) continue;
    const m = /^(api|watch):(.+)$/.exec(v.join("="));
    return m && isPortalToken(m[2]) ? { subject: m[1] as BillingSubject, token: m[2] } : null;
  }
  return null;
}
