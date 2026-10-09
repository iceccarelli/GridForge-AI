-- 0019_engagement_deposits.sql — a paid deposit is a durable, owned hand-off, not a log line
--
-- The Envelope Study (EUR 9,000) and Portfolio Screen (EUR 15,000) deposits open no deliverable,
-- watch or account: a person scopes the work. Until now the webhook recorded the payment by
-- PATCHing `deposit_paid`, `deposit_amount_cents` and `stripe_session_id` onto the newest lead with
-- the buyer's email. No migration ever created those columns, and a buyer who never filled in a lead
-- form has no lead at all, so the write failed or matched nothing and was swallowed: the payment
-- existed only in Stripe and (if Resend happened to be configured) one email.
--
-- This table is the record. One row per Stripe checkout session (unique), written by the webhook
-- BEFORE it answers 200, so a failed write makes Stripe redeliver. After that the row moves forward
-- one step at a time, each step needing the thing that proves it:
--
--   paid -> contacted (a named owner) -> scoped (the scope note) -> delivered (a delivery reference)
--
-- Identity columns never change and a step is never skipped or reversed. Nothing here promises a
-- date: the response time is the operator's to state, not the system's to invent.

create table if not exists public.engagement_deposits (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text not null unique check (length(btrim(stripe_session_id)) > 0),
  -- The Stripe metadata kind exactly as the webhook saw it (an unexpected kind is still a payment).
  kind text not null check (length(btrim(kind)) > 0),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'eur',
  -- Stripe supplies it for every checkout here; if it ever did not, the payment is still recorded.
  email text,
  company text,
  -- As named at checkout (a claim, not a foreign key): the project link itself is the project's
  -- own paid_product_attached event, written by the same webhook.
  project_id text,
  paid_at timestamptz not null default now(),
  status text not null default 'paid' check (status in ('paid', 'contacted', 'scoped', 'delivered')),
  owner text,
  contacted_at timestamptz,
  scope_note text,
  scoped_at timestamptz,
  delivery_ref text,
  delivered_at timestamptz,
  check (status = 'paid' or (owner is not null and contacted_at is not null)),
  check (status in ('paid', 'contacted') or (scope_note is not null and scoped_at is not null)),
  check (status <> 'delivered' or (delivery_ref is not null and delivered_at is not null))
);

create index if not exists engagement_deposits_open_idx
  on public.engagement_deposits (paid_at) where status <> 'delivered';

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
  return new;
end;
$$;

drop trigger if exists engagement_deposits_guard on public.engagement_deposits;
create trigger engagement_deposits_guard
  before update or delete on public.engagement_deposits
  for each row execute function public.gf_deposit_guard();

alter table public.engagement_deposits enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.engagement_deposits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.engagement_deposits from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.engagement_deposits to service_role;
  end if;
end
$$;
