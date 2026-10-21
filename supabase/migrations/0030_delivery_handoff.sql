-- 0030_delivery_handoff.sql — a deposit states a delivery date and a fee, credits are a ledger, a change note's email is retried
--
-- (0028 and 0029 are reserved for the billing work; this is the next free number, additive and idempotent.)
--
-- 1. DEPOSITS (0019). The hand-off recorded who contacted the buyer and what scope was agreed, and said "no date is
--    promised anywhere". That left a paid deposit able to sit "scoped" for ever with nothing to be overdue against, and the
--    "credits in full" promises on the Density Screen existing only as text. Scoping now also records
--
--      agreed_fee_cents      the fixed fee agreed with the buyer for the scope agreed (EUR cents)
--      credit_applied_cents  what earlier payments credited against that fee (sum of the ledger rows below)
--      delivery_due_on       the delivery date a named person committed to when the scope was agreed
--
--    all three set ONCE, at the contacted -> scoped step, and never changed afterwards (a changed date is a new
--    commitment to the buyer and belongs in the delivery reference, not in a rewrite of the first). Credits plus the deposit
--    can never exceed the agreed fee: a credit reduces what is owed, it never creates a refund.
--
-- 2. CREDIT LEDGER. engagement_credits records, append-only, that one paid Density Screen (source_deliverable_id, UNIQUE)
--    was credited against one deposit. UNIQUE is the whole point: "remembering it twice gives the money away twice".
--    gf_scope_deposit writes the ledger rows and the scoping step in ONE transaction, so a credit is never applied to a
--    deposit that did not reach "scoped" and a deposit never reaches "scoped" holding a credit that was not recorded.
--
-- 3. WATCH CHANGE NOTICES. A Hall Watch change note is stored on the watch page; its email is a courtesy pointer. The email
--    used to be one best-effort send with the failure logged. watch_note_notices is the durable obligation to send it
--    (one row per stored note, UNIQUE), retried with a bounded backoff by the engagements sweep and, when attempts are
--    exhausted, listed for an operator. It stores no recipient, no token and no body: the message is rebuilt from the watch
--    row at send time, exactly as customer_notifications (0021) does.

-- ------------------------------------------------------------------------------------------------ 1. deposits

alter table public.engagement_deposits
  add column if not exists agreed_fee_cents int check (agreed_fee_cents is null or agreed_fee_cents > 0),
  -- nullable on purpose: a restore of an export taken before this column existed (jsonb_populate_recordset gives a missing key as
  -- NULL, not as the default) must still load; code reads NULL as 0.
  add column if not exists credit_applied_cents int default 0 check (credit_applied_cents >= 0),
  add column if not exists delivery_due_on date;

create or replace function public.gf_deposit_guard() returns trigger
language plpgsql as $$
declare steps text[] := array['paid', 'contacted', 'scoped', 'delivered'];
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_deposits is append-only: a payment record is never deleted' using errcode = '55000';
  end if;
  if new.stripe_session_id is distinct from old.stripe_session_id or new.kind is distinct from old.kind
     or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
     or new.email is distinct from old.email or new.company is distinct from old.company
     or new.project_id is distinct from old.project_id or new.paid_at is distinct from old.paid_at then
    raise exception 'the payment facts of a deposit never change' using errcode = '55000';
  end if;
  if array_position(steps, new.status) is distinct from array_position(steps, old.status) + 1 then
    raise exception 'a deposit moves forward one step at a time (% -> %)', old.status, new.status
      using errcode = '55000';
  end if;
  -- Earlier steps stay exactly as they were recorded.
  if (old.owner is not null and new.owner is distinct from old.owner)
     or (old.contacted_at is not null and new.contacted_at is distinct from old.contacted_at)
     or (old.scope_note is not null and new.scope_note is distinct from old.scope_note)
     or (old.scoped_at is not null and new.scoped_at is distinct from old.scoped_at) then
    raise exception 'recorded steps are not rewritten' using errcode = '55000';
  end if;
  -- The fee, the credit and the delivery date are committed at scoping, once.
  if old.status = 'contacted' and new.status = 'scoped' then
    if new.agreed_fee_cents is null or new.delivery_due_on is null then
      raise exception 'scoping a deposit records the agreed fee and the delivery date' using errcode = '55000';
    end if;
    if new.amount_cents + new.credit_applied_cents > new.agreed_fee_cents then
      raise exception 'the deposit and its credits cannot exceed the agreed fee' using errcode = '55000';
    end if;
  elsif new.agreed_fee_cents is distinct from old.agreed_fee_cents
     or new.credit_applied_cents is distinct from old.credit_applied_cents
     or new.delivery_due_on is distinct from old.delivery_due_on then
    raise exception 'the agreed fee, credit and delivery date are recorded at scoping and never rewritten'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------------------------------------ 2. credit ledger

create table if not exists public.engagement_credits (
  id uuid primary key default gen_random_uuid(),
  -- One paid Density Screen is credited once, ever.
  source_deliverable_id uuid not null unique references public.deliverables (id),
  deposit_id uuid not null references public.engagement_deposits (id),
  amount_cents int not null check (amount_cents > 0),
  applied_by text not null check (length(btrim(applied_by)) > 0),
  applied_at timestamptz not null default now()
);

create index if not exists engagement_credits_deposit_idx on public.engagement_credits (deposit_id);

create or replace function public.gf_credit_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'engagement_credits is append-only: a credit that was applied is never changed or removed'
    using errcode = '55000';
end;
$$;

drop trigger if exists engagement_credits_guard on public.engagement_credits;
create trigger engagement_credits_guard
  before update or delete on public.engagement_credits
  for each row execute function public.gf_credit_guard();

alter table public.engagement_credits enable row level security;

/**
 * The scoping step, with its credits, in one transaction.
 *
 *   p = { id, scope_note, agreed_fee_cents, delivery_due_on, applied_by,
 *         credits: [ { source_deliverable_id, amount_cents } ... ] }
 *
 * Each credit's source must be a paid engagement (it carries a Stripe session) of the SAME buyer (case-insensitive email)
 * and the credit may not exceed what that engagement was paid. A source already credited anywhere raises 23505.
 */
create or replace function public.gf_scope_deposit(p jsonb) returns jsonb
language plpgsql as $$
declare
  dep public.engagement_deposits;
  c jsonb;
  src public.deliverables;
  total int := 0;
  amt int;
  out public.engagement_deposits;
begin
  select * into dep from public.engagement_deposits where id = (p->>'id')::uuid for update;
  if not found then
    raise exception 'deposit not found' using errcode = 'P0002';
  end if;
  if dep.status <> 'contacted' then
    raise exception 'only a contacted deposit can be scoped (this one is %)', dep.status using errcode = '55000';
  end if;
  for c in select * from jsonb_array_elements(coalesce(p->'credits', '[]'::jsonb)) loop
    select * into src from public.deliverables where id = (c->>'source_deliverable_id')::uuid;
    if not found then
      raise exception 'credit source not found' using errcode = 'P0002';
    end if;
    if src.stripe_session_id is null then
      raise exception 'a credit must come from a paid engagement' using errcode = '55000';
    end if;
    if lower(coalesce(src.email, '')) is distinct from lower(coalesce(dep.email, '')) or coalesce(src.email, '') = '' then
      raise exception 'a credit applies only to the buyer who paid it' using errcode = '55000';
    end if;
    amt := (c->>'amount_cents')::int;
    if amt is null or amt <= 0 or (src.amount_cents is not null and amt > src.amount_cents) then
      raise exception 'a credit cannot exceed what the engagement was paid' using errcode = '55000';
    end if;
    insert into public.engagement_credits (source_deliverable_id, deposit_id, amount_cents, applied_by)
      values (src.id, dep.id, amt, p->>'applied_by');
    total := total + amt;
  end loop;
  update public.engagement_deposits set
      status = 'scoped',
      scope_note = p->>'scope_note',
      scoped_at = now(),
      agreed_fee_cents = (p->>'agreed_fee_cents')::int,
      credit_applied_cents = total,
      delivery_due_on = (p->>'delivery_due_on')::date
    where id = dep.id
    returning * into out;
  return to_jsonb(out);
end;
$$;

-- ------------------------------------------------------------------------------------------------ 3. watch change notices

create table if not exists public.watch_note_notices (
  id uuid primary key default gen_random_uuid(),
  watch_note_id uuid not null unique references public.watch_notes (id) on delete cascade,
  watch_id uuid not null references public.watches (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'abandoned')),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  -- A category (no_recipient, rejected, timeout, ...), never a provider body.
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'sent') = (sent_at is not null))
);

create index if not exists watch_note_notices_due_idx on public.watch_note_notices (status, next_attempt_at);

alter table public.watch_note_notices enable row level security;

-- ------------------------------------------------------------------------------------------------ privileges

do $$
declare r text;
begin
  for r in select unnest(array['anon', 'authenticated']) loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.engagement_credits from %I', r);
      execute format('revoke all on public.watch_note_notices from %I', r);
      execute format('revoke all on function public.gf_scope_deposit(jsonb) from %I', r);
      execute format('revoke all on function public.gf_deposit_guard() from %I', r);
      execute format('revoke all on function public.gf_credit_guard() from %I', r);
    end if;
  end loop;
  revoke all on function public.gf_scope_deposit(jsonb) from public;
  revoke all on function public.gf_deposit_guard() from public;
  revoke all on function public.gf_credit_guard() from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.engagement_credits to service_role;
    grant select, insert, update on public.watch_note_notices to service_role;
    grant execute on function public.gf_scope_deposit(jsonb) to service_role;
    grant execute on function public.gf_deposit_guard() to service_role;
    grant execute on function public.gf_credit_guard() to service_role;
  end if;
end
$$;
