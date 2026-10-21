/**
 * gf_scope_deposit of 0030_delivery_handoff.sql, restated against the in-memory fake.
 *
 * SUPPLEMENTAL, not verification: this MIRRORS the SQL (one transaction, credits and the scoping step together, a source
 * credited once, same buyer, never above what was paid) so route tests can run without a database. That the REAL function
 * and its triggers behave this way is proven against PostgreSQL in tests/test_delivery_handoff_migration.py.
 */
import { PgError, type PostgrestFake } from "./postgrest-fake";

export function installDepositRpcs(db: PostgrestFake): void {
  db.createTable("engagement_credits");
  db.createTable("deliverables");
  db.uniqueKeys.set("engagement_credits", [["source_deliverable_id"]]);
  db.rpcs.set("gf_scope_deposit", ({ p }) => {
    const dep = db.rows("engagement_deposits").find((d) => d.id === p.id);
    if (!dep) throw new PgError("P0002", "deposit not found", 404);
    if (dep.status !== "contacted") throw new PgError("55000", `only a contacted deposit can be scoped (this one is ${dep.status})`, 400);
    let total = 0;
    for (const c of p.credits ?? []) {
      const src = db.rows("deliverables").find((d) => d.id === c.source_deliverable_id);
      if (!src) throw new PgError("P0002", "credit source not found", 404);
      if (!src.stripe_session_id) throw new PgError("55000", "a credit must come from a paid engagement", 400);
      if (!src.email || String(src.email).toLowerCase() !== String(dep.email ?? "").toLowerCase()) {
        throw new PgError("55000", "a credit applies only to the buyer who paid it", 400);
      }
      if (!(c.amount_cents > 0) || (src.amount_cents != null && c.amount_cents > (src.amount_cents as number))) {
        throw new PgError("55000", "a credit cannot exceed what the engagement was paid", 400);
      }
      db.insertRow("engagement_credits", { source_deliverable_id: src.id, deposit_id: dep.id, amount_cents: c.amount_cents, applied_by: p.applied_by });
      total += c.amount_cents;
    }
    if ((dep.amount_cents as number) + total > p.agreed_fee_cents) throw new PgError("55000", "the deposit and its credits cannot exceed the agreed fee", 400);
    Object.assign(dep, {
      status: "scoped", scope_note: p.scope_note, scoped_at: new Date().toISOString(),
      agreed_fee_cents: p.agreed_fee_cents, credit_applied_cents: total, delivery_due_on: p.delivery_due_on,
    });
    return { ...dep };
  });
}
