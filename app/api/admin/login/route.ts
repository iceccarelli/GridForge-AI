import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { checkPassword, adminToken, adminConfigured, ADMIN_COOKIE } from "@/lib/admin";

export const runtime = "nodejs";

// POST { password } -> sets the admin session cookie on success.
export async function POST(req: Request) {
  if (!adminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Admin is not configured. Set ADMIN_PASSWORD." },
      { status: 503 }
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
    maxAge: 60 * 60 * 8, // 8 hours
  });
  return NextResponse.json({ ok: true });
}

// DELETE -> log out.
export async function DELETE() {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  return NextResponse.json({ ok: true });
}
