import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminCookie } from "@/lib/admin";
import { openDeposits } from "@/lib/deposits";
import { balanceDueCents, depositTerms } from "@/lib/engagement-state";
import { fail } from "@/lib/project-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The operator's work list for the deposits that open no object: oldest payment first,
// delivered ones hidden unless ?state=all. Each row carries what the buyer was told it reserves, opens and credits
// (`terms`) and, once scoped, the balance on the agreed fee. Overdue and uncontacted ones are in GET /api/admin/deliverables.
export async function GET(req: Request) {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const r = await openDeposits(new URL(req.url).searchParams.get("state") === "all");
  if (!r.ok) return fail(r);
  return NextResponse.json({
    ok: true,
    items: r.items.map((d) => ({
      ...d,
      terms: depositTerms(d.kind),
      balance_due_cents:
        typeof d.agreed_fee_cents === "number" ? balanceDueCents(d.agreed_fee_cents, d.amount_cents, d.credit_applied_cents ?? 0) : null,
    })),
  });
}
