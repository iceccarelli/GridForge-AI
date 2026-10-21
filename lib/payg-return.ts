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
