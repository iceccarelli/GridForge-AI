import crypto from "node:crypto";

/**
 * Header-only authorization for the scheduled routes (Authorization: Bearer <CRON_SECRET>), constant-time. A secret in the
 * query string ends up in access logs, so ?key= is not accepted. With no CRON_SECRET configured nothing is authorised.
 */
export function cronAuthorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
