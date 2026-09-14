import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { getByToken, updateByToken } from "@/lib/deliverables";

export const runtime = "nodejs";

// Release a generated deliverable to the client. Auth-gated, and deliberately a
// separate human act from generating it: an engineering opinion gets a name
// against it before a client reads it.
export async function PATCH(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const action = body.action === "unrelease" ? "unrelease" : "release";
  if (!token) return NextResponse.json({ ok: false, error: "token required" }, { status: 422 });

  const row = await getByToken(token);
  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  if (action === "release") {
    if (!row.document_html) {
      return NextResponse.json(
        { ok: false, error: "Nothing generated yet — there is no document to release." },
        { status: 409 }
      );
    }
    await updateByToken(token, { status: "released", released_at: new Date().toISOString() });
    return NextResponse.json({ ok: true, status: "released" });
  }

  await updateByToken(token, { status: "draft", released_at: null });
  return NextResponse.json({ ok: true, status: "draft" });
}
