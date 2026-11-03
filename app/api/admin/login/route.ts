import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  checkPassword,
  adminToken,
  adminConfigured,
  adminSessionReady,
  requestKey,
  throttleLogin,
  ADMIN_COOKIE,
  ADMIN_SESSION_SECONDS,
  refuseCrossSiteWrite,
} from "@/lib/admin";

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
  const wait = await throttleLogin(requestKey(req));
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const password =
    typeof (body as { password?: unknown })?.password === "string"
      ? (body as { password: string }).password
      : "";

  if (!checkPassword(password)) {
    return NextResponse.json({ ok: false, error: "Incorrect password." }, { status: 401 });
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

// DELETE -> log out.
export async function DELETE(req: Request) {
  const xs = refuseCrossSiteWrite(req);
  if (xs) return xs;
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  return NextResponse.json({ ok: true });
}
