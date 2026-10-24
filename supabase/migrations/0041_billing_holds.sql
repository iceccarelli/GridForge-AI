-- 0041_billing_holds.sql: a refunded, disputed or paused subscription payment suspends paid access reversibly; past_due has a start
-- time; every such decision is written to an append-only audit trail.
--
-- Additive and idempotent: every statement is `if not exists` / `drop ... if exists`, no existing column, row, policy or grant changes,
-- nothing is deleted, and RLS on the tables touched is exactly what it was.
--
--   api_accounts.past_due_since
--       When the CURRENT past_due episode began (Stripe event.created of the first failed payment). The API grace window
--       (API_PAST_DUE_GRACE_DAYS in lib/api-access.ts, 7) is counted from here; the daily job revokes the live key when it has elapsed.
--       Cleared when a payment clears. A past_due row that predates this column has none: its grace starts when the job first sees it.
--
--   billing_hold / billing_hold_ref / billing_hold_invoice / billing_hold_at / billing_hold_prev_status   (api_accounts, watches, subscriptions)
--       A suspension that is NOT a cancellation: 'refunded' (a charge for the subscription's invoice was fully refunded), 'disputed'
--       (a chargeback is open) or 'paused' (Stripe pause_collection / status paused). `billing_hold_ref` is the Stripe charge, dispute or
--       subscription id that caused it, `billing_hold_invoice` the invoice whose payment was reversed (so the same invoice paid again never
--       lifts it), `billing_hold_prev_status` what the row was before, so a lift without a new payment (dispute won, billing resumed)
--       puts it back exactly there. A row is never deleted and a cancelled row never gets a hold. Intelligence uses the new status
--       'suspended' (the entitlement check lists only active and past_due, so it is not entitled); `subscriptions.status` has no check.
--
--   billing_audit
--       One row per decision the billing webhook or the daily job took about a customer's access: hold applied, hold lifted, grace
--       started, key revoked at the end of grace, a revocation the engine did not confirm. Append-only (the gf_append_only trigger of 0015
--       stops UPDATE, DELETE and TRUNCATE even for the table owner) and once-only per `dedupe_key`, so a redelivered Stripe event
--       records nothing twice. Holds identifiers only: no email, no card, no free text from Stripe.

alter table public.api_accounts add column if not exists past_due_since timestamptz;
create index if not exists api_accounts_past_due_idx on public.api_accounts (past_due_since) where status = 'past_due';

alter table public.api_accounts add column if not exists billing_hold text;
alter table public.api_accounts add column if not exists billing_hold_ref text;
alter table public.api_accounts add column if not exists billing_hold_invoice text;
alter table public.api_accounts add column if not exists billing_hold_at timestamptz;
alter table public.api_accounts add column if not exists billing_hold_prev_status text;

alter table public.watches add column if not exists billing_hold text;
alter table public.watches add column if not exists billing_hold_ref text;
alter table public.watches add column if not exists billing_hold_invoice text;
alter table public.watches add column if not exists billing_hold_at timestamptz;
alter table public.watches add column if not exists billing_hold_prev_status text;

alter table public.subscriptions add column if not exists billing_hold text;
alter table public.subscriptions add column if not exists billing_hold_ref text;
alter table public.subscriptions add column if not exists billing_hold_invoice text;
alter table public.subscriptions add column if not exists billing_hold_at timestamptz;
alter table public.subscriptions add column if not exists billing_hold_prev_status text;

do $$
declare t text;
begin
  foreach t in array array['api_accounts', 'watches', 'subscriptions'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_billing_hold_check' and conrelid = ('public.' || t)::regclass) then
      execute format('alter table public.%I add constraint %I check (billing_hold is null or billing_hold in (''refunded'', ''disputed'', ''paused''))',
                     t, t || '_billing_hold_check');
    end if;
  end loop;
end
$$;

create index if not exists api_accounts_billing_hold_idx on public.api_accounts (billing_hold) where billing_hold is not null;
create index if not exists watches_billing_hold_idx on public.watches (billing_hold) where billing_hold is not null;
create index if not exists subscriptions_billing_hold_idx on public.subscriptions (billing_hold) where billing_hold is not null;

create table if not exists public.billing_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Opaque, built by the application from the event and the subject; the INSERT is the once-only claim.
  dedupe_key text not null unique check (length(btrim(dedupe_key)) > 0),
  subject_table text not null check (subject_table in ('api_accounts', 'watches', 'subscriptions')),
  subject_id text not null check (length(btrim(subject_id)) > 0),
  action text not null check (length(btrim(action)) > 0),
  -- The Stripe objects the decision rests on (identifiers only).
  stripe_event_id text,
  stripe_object_id text,
  stripe_invoice_id text,
  stripe_subscription_id text,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index if not exists billing_audit_subject_idx on public.billing_audit (subject_table, subject_id, created_at desc);

drop trigger if exists billing_audit_append_only on public.billing_audit;
create trigger billing_audit_append_only
  before update or delete on public.billing_audit
  for each row execute function public.gf_append_only();
drop trigger if exists billing_audit_no_truncate on public.billing_audit;
create trigger billing_audit_no_truncate
  before truncate on public.billing_audit
  for each statement execute function public.gf_append_only();

alter table public.billing_audit enable row level security;
revoke all on public.billing_audit from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.billing_audit from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.billing_audit from service_role;
    grant select, insert on public.billing_audit to service_role;
  end if;
end
$$;
