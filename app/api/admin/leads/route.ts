import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  verifyAdminCookie,
  updateLeadStatus,
  LEAD_STATUSES,
  ADMIN_COOKIE,
  type LeadStatus,
} from "@/lib/admin";

export const runtime = "nodejs";

// PATCH { id, status } -> update a lead's pipeline status. Auth-gated.
export async function PATCH(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const id = typeof (body as { id?: unknown })?.id === "string" ? (body as { id: string }).id : "";
  const status =
    typeof (body as { status?: unknown })?.status === "string"
      ? ((body as { status: string }).status as LeadStatus)
      : ("" as LeadStatus);

  if (!id || !LEAD_STATUSES.includes(status)) {
    return NextResponse.json({ ok: false, error: "Bad input" }, { status: 422 });
  }

  const ok = await updateLeadStatus(id, status);
  return NextResponse.json({ ok }, { status: ok ? 200 : 502 });
}
