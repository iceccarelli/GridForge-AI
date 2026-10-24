-- 0043_billing_pause_and_settlement_reversals.sql: a pause takes effect when the PAID period ends, not at once; a refund or dispute of a
-- pay-as-you-go settlement invoice is recorded as an event of its own.
--
-- Additive and idempotent: every statement is `if not exists` / `drop ... if exists`, nothing is deleted or rewritten, and the RLS and
-- privileges of every table touched are exactly what they were (the new table is created with RLS on and no policies, service role
-- append-only, per 0020 / 0040 / 0041).
--
--   api_accounts / watches / subscriptions . billing_pause_from, billing_pause_resumes_at, billing_pause_event_ts
--       Stripe's pause_collection stops FUTURE invoices only, so a customer who pauses mid-period has already paid for access up to the
--       end of that period. billing_pause_from is the instant a scheduled pause starts to hold access (the end of the paid period, from
--       the subscription's current_period_end or the latest paid invoice's period); the daily job (/api/cron/payg), the Hall Watch cron
--       and the access checks turn it into the same reversible `billing_hold = 'paused'` of 0041 once it is due. NULL = nothing scheduled.
--       billing_pause_resumes_at is Stripe's pause_collection.resumes_at, kept for the record. billing_pause_event_ts is the Stripe
--       event.created (unix seconds) of the newest pause / resume decision applied to the row: the clock that orders duplicate and
--       out-of-order pause and resume events. It is a clock of its own because last_billing_event_ts orders PAYMENT events, and a resume
--       must not make an older (but not yet delivered) invoice.paid look stale.
--
--   billing_audit.subject_table
--       Also accepts 'stripe_disputes' (the subject of a dispute Stripe says does not exist, which belongs to no account).
--
--   payg_settlement_reversals
--       One row per refund, dispute state or operator release of a pay-as-you-go monthly settlement invoice. APPEND-ONLY (gf_append_only
--       stops UPDATE, DELETE and TRUNCATE even for the table owner): a refund is a new event linked to the settlement, never an edit of
--       the settlement row and never of the usage ledger (usage_events). The consumed engine usage stays consumed; nothing here
--       re-grants a unit or credits a future invoice. 'refund': amount_cents is the CUMULATIVE amount Stripe reports refunded on the
--       charge (it only grows; the largest is current), state partial|full. 'dispute': amount_cents is the disputed amount and state is
--       Stripe's dispute status at the time (keyed per dispute and state, never per delivery). 'release': an operator decision to
--       restore access after a refund or dispute hold (insert one row naming the hold's own charge or dispute id in stripe_object_id; the
--       daily job lifts exactly that hold, once, and audits it; a later, different hold is not touched by it).
--       Holds identifiers and amounts only: no email, no card, no free text from Stripe.

alter table public.api_accounts add column if not exists billing_pause_from timestamptz;
alter table public.api_accounts add column if not exists billing_pause_resumes_at timestamptz;
alter table public.api_accounts add column if not exists billing_pause_event_ts bigint;

alter table public.watches add column if not exists billing_pause_from timestamptz;
alter table public.watches add column if not exists billing_pause_resumes_at timestamptz;
alter table public.watches add column if not exists billing_pause_event_ts bigint;

alter table public.subscriptions add column if not exists billing_pause_from timestamptz;
alter table public.subscriptions add column if not exists billing_pause_resumes_at timestamptz;
alter table public.subscriptions add column if not exists billing_pause_event_ts bigint;

create index if not exists api_accounts_pause_due_idx on public.api_accounts (billing_pause_from) where billing_pause_from is not null;
create index if not exists watches_pause_due_idx on public.watches (billing_pause_from) where billing_pause_from is not null;
create index if not exists subscriptions_pause_due_idx on public.subscriptions (billing_pause_from) where billing_pause_from is not null;

-- ---------------------------------------------------------------------------------------------------------------------
-- billing_audit: a dispute can be the subject (loosened, never tightened: every existing row still satisfies it)
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.billing_audit drop constraint if exists billing_audit_subject_table_check;
alter table public.billing_audit add constraint billing_audit_subject_table_check
  check (subject_table in ('api_accounts', 'watches', 'subscriptions', 'stripe_disputes'));

-- ---------------------------------------------------------------------------------------------------------------------
-- payg_settlement_reversals
-- ---------------------------------------------------------------------------------------------------------------------
-- (id, account, month) is already unique through the primary key and UNIQUE (account, month); the composite unique index lets a
-- reversal name its settlement by all three, so a row cannot point at one settlement by id and another by account and month.
create unique index if not exists usage_settlements_id_account_month_uq on public.usage_settlements (id, account, month);

create table if not exists public.payg_settlement_reversals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Once-only per event of the reversal (refund: charge + cumulative amount; dispute: dispute + status). The INSERT is the claim.
  dedupe_key text not null unique default ('release:' || gen_random_uuid()::text) check (length(btrim(dedupe_key)) > 0),
  settlement_id uuid not null,
  account text not null check (length(btrim(account)) > 0),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text not null check (kind in ('refund', 'dispute', 'release')),
  stripe_object_id text,
  stripe_invoice_id text,
  stripe_event_id text,
  amount_cents integer not null check (amount_cents >= 0),
  state text not null check (length(btrim(state)) > 0),
  note text check (note is null or length(note) <= 500),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  foreign key (settlement_id, account, month) references public.usage_settlements (id, account, month),
  check (kind <> 'refund' or (stripe_object_id is not null and state in ('partial', 'full'))),
  check (kind <> 'dispute' or stripe_object_id is not null),
  check (kind <> 'release' or stripe_object_id is not null)
);
create index if not exists payg_settlement_reversals_settlement_idx on public.payg_settlement_reversals (settlement_id, created_at desc);
create index if not exists payg_settlement_reversals_account_idx on public.payg_settlement_reversals (account, created_at desc);

drop trigger if exists payg_settlement_reversals_append_only on public.payg_settlement_reversals;
create trigger payg_settlement_reversals_append_only
  before update or delete on public.payg_settlement_reversals
  for each row execute function public.gf_append_only();
drop trigger if exists payg_settlement_reversals_no_truncate on public.payg_settlement_reversals;
create trigger payg_settlement_reversals_no_truncate
  before truncate on public.payg_settlement_reversals
  for each statement execute function public.gf_append_only();

alter table public.payg_settlement_reversals enable row level security;
revoke all on public.payg_settlement_reversals from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.payg_settlement_reversals from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.payg_settlement_reversals from service_role;
    grant select, insert on public.payg_settlement_reversals to service_role;
  end if;
end
$$;
