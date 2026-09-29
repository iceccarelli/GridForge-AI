import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAdminCookie, ADMIN_COOKIE } from "@/lib/admin";
import {
  CAPABILITY_REGISTRY,
  danglingProductReferences,
  danglingIntelligenceReferences,
  productsMissingFromRegistry,
  intelligencePlansMissingFromRegistry,
  priceableButNotOnWeb,
  unmonetized,
} from "@/lib/capability-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET -> the system-integrity audit: what capabilities exist, which are
// priced, which are sellable, which are visible on the site, which have no
// commercial path at all yet. All computed from lib/capability-registry.ts,
// the single cross-layer map every layer's own tests (product parity, MCP
// catalogue parity) keep honest independently. This is what ties those
// per-layer checks together into one operator-facing report, per
// docs/07_DELIVERY_RUNBOOK.md's "system-integrity audit."
export async function GET() {
  const store = await cookies();
  if (!verifyAdminCookie(store.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const byStatus: Record<string, number> = {};
  for (const c of CAPABILITY_REGISTRY) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  return NextResponse.json({
    ok: true,
    audit: {
      total: CAPABILITY_REGISTRY.length,
      by_status: byStatus,
      dangling_product_references: danglingProductReferences(),
      dangling_intelligence_references: danglingIntelligenceReferences(),
      products_missing_from_registry: productsMissingFromRegistry(),
      intelligence_plans_missing_from_registry: intelligencePlansMissingFromRegistry(),
      priceable_but_not_on_web: priceableButNotOnWeb().map((c) => c.capability_id),
      unmonetized: unmonetized().map((c) => c.capability_id),
      capabilities: CAPABILITY_REGISTRY,
    },
  });
}
