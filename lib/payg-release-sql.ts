// The statement an operator runs to release a pay-as-you-go account from a refund or dispute hold (lib/payg-refunds.ts). It is one string
// with {placeholders} so that the operator's mail and the tests (tests/site/payg-settlement-reversal.test.ts, and the real-PostgreSQL
// test tests/test_billing_pause_reversals_migration.py, which reads this file) run exactly the SQL the mail shows: the columns it leaves out
// (dedupe_key) are filled by the table's own defaults.
export const RELEASE_SQL =
  "insert into payg_settlement_reversals (settlement_id, account, month, kind, stripe_object_id, amount_cents, state, note) values ('{settlement_id}', '{account}', '{month}', 'release', '{ref}', 0, 'operator_release', 'why');";

export function releaseSql(s: { id: string; account: string; month: string }, ref: string): string {
  return RELEASE_SQL.replace("{settlement_id}", s.id).replace("{account}", s.account).replace("{month}", s.month).replace("{ref}", ref);
}
