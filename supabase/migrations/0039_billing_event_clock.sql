-- 0039_billing_event_clock.sql: one ordering clock for every billing entitlement, a fair revocation sweep, and once-only operator notices
--
-- Additive and idempotent: every statement is `if not exists`, no existing column, policy or grant changes, and RLS on the tables
-- touched is exactly what it was (the new table is created with RLS on and no policies, the service role only).
--
--   watches.last_billing_event_ts / subscriptions.last_billing_event_ts
--       Stripe event.created (unix seconds) of the newest invoice event applied to this row. api_accounts has had this since 0028;
--       Hall Watch and Intelligence did not, so an invoice.payment_failed delivered AFTER the invoice.paid that cleared it
--       left a watch paused and an Intelligence subscription past_due until the next successful invoice. Stripe does not deliver
--       events in order, so the webhook now applies the same rule to all three: an event older than the newest one applied is stale.
--
--   api_accounts.last_revocation_attempt_at
--       Stamped by the daily revocation sweep on every account it examines. The sweep reads the accounts whose revocation has
--       not yet been confirmed OLDEST-ATTEMPTED FIRST (never attempted first), so a handful of rows the engine keeps refusing, or
--       that are deliberately held back, can no longer starve the rest of a bounded batch.
--
--   operator_notices
--       A once-only ledger for mail to the operator ("this subscription's price no longer matches the catalogue", "this
--       settlement could not be invoiced today", "a dispute was opened"). The key is an opaque digest built by the application;
--       a second notice with the same key inserts nothing, which is how a redelivered Stripe event or a re-run cron does not mail
--       twice. Holds no customer data: only the digest and a timestamp.

alter table public.watches add column if not exists last_billing_event_ts bigint;
alter table public.subscriptions add column if not exists last_billing_event_ts bigint;

alter table public.api_accounts add column if not exists last_revocation_attempt_at timestamptz;
create index if not exists api_accounts_revocation_sweep_idx
  on public.api_accounts (last_revocation_attempt_at asc nulls first) where revocation_pending;

create table if not exists public.operator_notices (
  dedupe_key text primary key check (length(btrim(dedupe_key)) > 0),
  created_at timestamptz not null default now()
);

alter table public.operator_notices enable row level security;
revoke all on public.operator_notices from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.operator_notices from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.operator_notices to service_role;
  end if;
end
$$;
