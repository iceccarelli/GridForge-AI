// SUPPLEMENTAL mirror of migration 0042's gf_checkout_funnel_summary (the SQL itself is proven against PostgreSQL in
// tests/test_checkout_funnel_migration.py). Install it on a PostgrestFake that has a funnel_events table.
import type { PostgrestFake } from "./postgrest-fake";

const CHECKOUT = ["checkout_attempted", "checkout_session_created", "checkout_failed"];

export function installCheckoutFunnelRpc(db: PostgrestFake): void {
  db.rpcs.set("gf_checkout_funnel_summary", ({ p_since }: { p_since: string }) => {
    const rows = (db.rows("funnel_events") as any[]).filter((e) => CHECKOUT.includes(e.name) && e.created_at >= p_since);
    const counts: Record<string, number> = {};
    const by_kind: Record<string, Record<string, number>> = {};
    const failed_reasons: Record<string, number> = {};
    const failed_by_kind: Record<string, Record<string, number>> = {};
    for (const e of rows) {
      const kind = e.props?.kind ?? "unspecified";
      counts[e.name] = (counts[e.name] ?? 0) + 1;
      const byName = (by_kind[e.name] ??= {});
      byName[kind] = (byName[kind] ?? 0) + 1;
      if (e.name === "checkout_failed") {
        const reason = e.props?.reason ?? "unspecified";
        failed_reasons[reason] = (failed_reasons[reason] ?? 0) + 1;
        const fk = (failed_by_kind[kind] ??= {});
        fk[reason] = (fk[reason] ?? 0) + 1;
      }
    }
    return { counts, by_kind, failed_reasons, failed_by_kind };
  });
}
