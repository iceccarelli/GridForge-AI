-- 0045_one_time_purchase_holds.sql: a refunded or disputed one-time purchase (Density Screen, Procurement Specification) suspends access to
-- what it paid for, reversibly, and is audited.
--
-- Until now only SUBSCRIPTION payments could be reversed in the application (0041): a charge with no subscription behind it fell through
-- "an engagement deposit: nothing of ours to suspend". A released Density Screen stayed readable after a full refund or a lost dispute,
-- its "credits in full" offer stayed on the table, and nothing durable said the payment had been reversed.
--
-- Additive and idempotent: `add column if not exists`, constraints added only when absent, `create or replace` for one function.
-- No row, grant or policy changes. WRITTEN, NOT APPLIED: applying it to a live project is an operator decision; until then the webhook
-- tells the operator (once per charge) that a reversal could not be held, and nothing else changes.
--
--   deliverables.billing_hold / billing_hold_ref / billing_hold_at
--       'refunded' (a charge for the purchase was refunded in full) or 'disputed' (a chargeback is open or was lost). billing_hold_ref is
--       the Stripe charge or dispute that caused it, so a dispute that is WON lifts exactly its own hold and nothing else. A refund is
--       terminal and is never lifted by a dispute event. While a hold stands the buyer's document, bid comparison, quotations and
--       evidence runs are withheld, the engine is not run for an unsubmitted intake, and the purchase is not offered as a credit.
--
--   billing_audit.subject_table
--       Also accepts 'deliverables' and 'engagement_deposits' (a deposit has no entitlement to suspend; the decision is audited and the
--       operator is told, because scoped work is a person's decision, not a status).
--
--   gf_credit_insert_guard()
--       0040's function, unchanged except for one check: a credit cannot come from a purchase that is on hold. `create or replace` keeps
--       the grants 0040 set.

alter table public.deliverables add column if not exists billing_hold text;
alter table public.deliverables add column if not exists billing_hold_ref text;
alter table public.deliverables add column if not exists billing_hold_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deliverables_billing_hold_check' and conrelid = 'public.deliverables'::regclass) then
    alter table public.deliverables add constraint deliverables_billing_hold_check
      check (billing_hold is null or billing_hold in ('refunded', 'disputed'));
  end if;
  -- A hold always names the Stripe object that caused it, and a hold-free row names none.
  if not exists (select 1 from pg_constraint where conname = 'deliverables_billing_hold_ref_check' and conrelid = 'public.deliverables'::regclass) then
    alter table public.deliverables add constraint deliverables_billing_hold_ref_check
      check ((billing_hold is null and billing_hold_ref is null and billing_hold_at is null)
          or (billing_hold is not null and billing_hold_ref is not null and billing_hold_at is not null));
  end if;
end
$$;

create index if not exists deliverables_billing_hold_idx on public.deliverables (billing_hold) where billing_hold is not null;

-- Loosened, never tightened: every existing row still satisfies it.
alter table public.billing_audit drop constraint if exists billing_audit_subject_table_check;
alter table public.billing_audit add constraint billing_audit_subject_table_check
  check (subject_table in ('api_accounts', 'watches', 'subscriptions', 'stripe_disputes', 'deliverables', 'engagement_deposits'));

create or replace function public.gf_credit_insert_guard() returns trigger
language plpgsql as $$
declare
  dep public.engagement_deposits;
  src public.deliverables;
  rule public.engagement_credit_sources;
  already bigint;
begin
  select * into dep from public.engagement_deposits where id = new.deposit_id for update;
  if not found then
    raise exception 'a credit needs an existing deposit' using errcode = '23503';
  end if;
  if dep.status <> 'contacted' then
    raise exception 'a credit is applied only while a deposit is being scoped (this one is %)', dep.status using errcode = '55000';
  end if;
  select * into src from public.deliverables where id = new.source_deliverable_id;
  if not found then
    raise exception 'credit source not found' using errcode = '23503';
  end if;
  if src.stripe_session_id is null then
    raise exception 'a credit must come from a paid engagement' using errcode = '55000';
  end if;
  if src.billing_hold is not null then
    raise exception 'a credit cannot come from an engagement whose payment was % (hold on %)', src.billing_hold, src.id using errcode = '55000';
  end if;
  if lower(btrim(coalesce(src.email, ''))) = '' or lower(btrim(coalesce(src.email, ''))) <> lower(btrim(coalesce(dep.email, ''))) then
    raise exception 'a credit applies only to the buyer who paid it' using errcode = '55000';
  end if;
  select * into rule from public.engagement_credit_sources where deposit_kind = dep.kind and source_kind = src.kind;
  if not found then
    raise exception 'a % does not credit a %', src.kind, dep.kind using errcode = '55000';
  end if;
  if new.amount_cents > coalesce(src.amount_cents, rule.catalogue_cents) then
    raise exception 'a credit cannot exceed what the engagement was paid' using errcode = '55000';
  end if;
  select coalesce(sum(amount_cents), 0) into already from public.engagement_credits where deposit_id = new.deposit_id;
  if dep.agreed_fee_cents is not null and dep.amount_cents + already + new.amount_cents > dep.agreed_fee_cents then
    raise exception 'the deposit and its credits cannot exceed the agreed fee' using errcode = '55000';
  end if;
  return new;
end;
$$;
