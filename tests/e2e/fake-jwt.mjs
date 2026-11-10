// A stand-in access token for the local stand-ins (tests/e2e/postgrest-stub.mjs plays GoTrue). A real Supabase access token is a JWT, and the site
// now refuses locally, without asking Supabase, any bearer that is not three base64url segments with a JSON payload whose `exp` is in the future
// (lib/portal.ts couldBeAccessToken). So the stand-in tokens have that SHAPE; the stand-in reads the email and confirmation out of the payload. The signature
// is a placeholder: the stand-in is the only verifier, as Supabase is the only verifier in production.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A JWT-shaped bearer for `email`; `confirmed: false` is a session whose address Supabase has not confirmed. */
export function jwtFor(email, confirmed = true, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ email, confirmed, exp: expSeconds })}.${Buffer.from("stand-in-signature").toString("base64url")}`;
}

/** What the stand-in learns from a bearer: { email, confirmed } or null when it is not one of ours. */
export function readJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof p.email === "string" ? { email: p.email, confirmed: p.confirmed !== false } : null;
  } catch {
    return null;
  }
}
