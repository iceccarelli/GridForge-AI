import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  checkPassword,
  adminToken,
  adminConfigured,
  adminSessionReady,
  requestKey,
  requestCoarseKey,
  throttleLogin,
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  refuseCrossSiteWrite,
  revokeAdminSession,
  adminRevocationStoreReadable,
} from "@/lib/admin";
import { ADMIN_LOGIN_MAX_BODY_BYTES, readBoundedJson } from "@/lib/http-body";

export const runtime = "nodejs";

// POST { password } -> sets the admin session cookie on success.
export async function POST(req: Request) {
  const xs = refuseCrossSiteWrite(req);
  if (xs) return xs;
  if (!adminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Admin is not configured. Set ADMIN_PASSWORD." },
      { status: 503 }
    );
  }
  // Production refuses to sign sessions without a distinct strong ADMIN_SESSION_SECRET (lib/admin.ts); say so rather
  // than letting the operator think the password is wrong. The reason is in the server log, never in the response.
  if (!adminSessionReady()) {
    return NextResponse.json(
      { ok: false, error: "Admin sessions are disabled: ADMIN_SESSION_SECRET is missing or too weak. Set a separate random value of 32+ characters." },
      { status: 503 }
    );
  }
  // Before reading the body, and before comparing anything: a guess must cost
  // something. This gate fronts the whole lead pipeline and the release button. The count is the shared Postgres
  // counter, so it holds across every instance; if it cannot be read the login is refused, not waved through.
  const wait = await throttleLogin(requestKey(req), undefined, requestCoarseKey(req));
  if (wait === "unavailable") {
    return NextResponse.json(
      { ok: false, error: "Login is temporarily unavailable. Try again shortly." },
      { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }
    );
  }
  if (wait > 0) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(wait) } }
    );
  }

  // Bounded, and AFTER the throttle above: this route is open to anyone, so a body is read only to the cap (a password is a few dozen bytes), and
  // an oversized attempt has already cost an attempt. 413 over the cap; malformed JSON keeps its 400.
  const read = await readBoundedJson(req, ADMIN_LOGIN_MAX_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ ok: false, error: read.status === 413 ? read.error : "Invalid payload" }, { status: read.status });
  }
  const body: unknown = read.value;
  const password =
    typeof (body as { password?: unknown })?.password === "string"
      ? (body as { password: string }).password
      : "";

  if (!checkPassword(password)) {
    return NextResponse.json({ ok: false, error: "Incorrect password." }, { status: 401 });
  }

  // Sessions are checked against a server-side denylist (migration 0055) and production refuses every session while it cannot be read. Say so
  // here instead of issuing a cookie that the very next request would reject.
  if (!(await adminRevocationStoreReadable())) {
    console.error("[GridForge] admin: login refused: the session revocation store is not readable (migration 0055 applied? Supabase reachable?)");
    return NextResponse.json(
      { ok: false, error: "Admin sessions are unavailable: the session revocation store cannot be read (apply migration 0055, or check the database connection). Nothing was signed in." },
      { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }
    );
  }

  const token = adminToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Admin not configured." }, { status: 503 });
  }

  const store = await cookies();
  store.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_SECONDS,
  });
  return NextResponse.json({ ok: true });
}

// DELETE -> log out: the session is revoked on the SERVER (its nonce goes on the denylist, migration 0055) as well as forgotten by the browser, so a
// copy of the cookie stops working. If the denylist cannot be written the browser still forgets the cookie, and the answer says `revoked: false`:
// the session then stays valid until it expires (4 hours at most) or ADMIN_SESSION_SECRET is rotated.
export async function DELETE(req: Request) {
  const xs = refuseCrossSiteWrite(req);
  if (xs) return xs;
  const store = await cookies();
  const outcome = await revokeAdminSession(store.get(ADMIN_COOKIE)?.value);
  store.delete(ADMIN_COOKIE);
  if (outcome === "failed") console.error("[GridForge] admin: logout: the session could not be revoked on the server; it stays valid until it expires");
  return NextResponse.json({ ok: true, revoked: outcome === "revoked" });
}
