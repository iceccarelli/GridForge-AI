-- 0028_payg_ledger.sql — pay-as-you-go metering, a bounded free allowance, and the billing records behind them
--
-- The ENGINE owns the append-only usage ledger (a JSONL file on its volume; see gridforge/api/metering.py). This file is the
-- website's durable copy of it and everything billing needs around it:
--
--   usage_events        the ledger, ingested idempotently (event_id is the engine's id) behind a cursor. Append-only.
--   payg_cursor         the one row that says how far the ledger has been ingested (advanced in the SAME transaction as the insert).
--   usage_settlements   one row per (account, month): what was invoiced, carried forward, or voided. UNIQUE(account, month) is
--                       what makes "settle a month" happen once however often the cron runs.
--   usage_alerts        80% / 100% of the cap, once per account / month / percent.
--   funnel_events       allow-listed product events (no emails, tokens, site inputs); see lib/funnel.ts.
--   founding_reservations  closes the Founding Partner coupon race (one reserved slot per checkout session).
--
-- and on api_accounts: the customer's cap, the saved payment method, the one-per-email free-allowance key, the scope of the live
-- key, and the bookkeeping that makes key revocation retryable until the engine has confirmed it.
--
-- Additive and idempotent. RLS on, no policies: the service role reaches these through the site's own routes (see 0007, 0020).

-- ---------------------------------------------------------------------------
-- A. api_accounts
-- ---------------------------------------------------------------------------
alter table public.api_accounts add column if not exists cap_units integer check (cap_units is null or cap_units > 0);
alter table public.api_accounts add column if not exists stripe_payment_method_id text;
alter table public.api_accounts add column if not exists payg_enabled_at timestamptz;
-- The normalised address a FREE allowance was claimed with. It stays set when the account upgrades to pay-as-you-go, so
-- upgrading does not free the address to claim a second allowance. (Contract: "partial unique index where plan = 'api_free'";
-- this is the stricter form of it, deliberately.)
alter table public.api_accounts add column if not exists free_email_norm text;
-- trial | payg | machine: the scope of the key currently recorded as live (null = none, or recorded before this migration).
alter table public.api_accounts add column if not exists key_scope text check (key_scope is null or key_scope in ('trial', 'payg', 'machine', 'client'));
-- Which revoked ids the ENGINE has confirmed revoked. revoked_key_ids is the intent; this is the acknowledgement.
alter table public.api_accounts add column if not exists revoked_confirmed_ids text[] not null default '{}';
-- Maintained by the trigger below: true while some revoked id has no engine confirmation. The cron pushes those.
alter table public.api_accounts add column if not exists revocation_pending boolean not null default false;
-- Unix time (Stripe event.created) of the newest invoice event applied to a subscription account: a late
-- invoice.payment_failed must not re-mark past_due an account whose later invoice.paid was already applied.
alter table public.api_accounts add column if not exists last_billing_event_ts bigint;

create unique index if not exists api_accounts_free_email_norm_uq
  on public.api_accounts (free_email_norm) where free_email_norm is not null;
create index if not exists api_accounts_revocation_pending_idx
  on public.api_accounts (revocation_pending) where revocation_pending;

-- A revoked id is never forgotten: whatever a writer sends, the stored set is the UNION of old and new, so two writers racing
-- (a mint and a cancellation, say) can never drop an id the engine still has to be told about. Confirmations only accumulate.
create or replace function public.gf_api_accounts_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.revoked_key_ids := coalesce((select array_agg(distinct x) from unnest(coalesce(old.revoked_key_ids, '{}') || coalesce(new.revoked_key_ids, '{}')) x), '{}');
    new.revoked_confirmed_ids := coalesce((select array_agg(distinct x) from unnest(coalesce(old.revoked_confirmed_ids, '{}') || coalesce(new.revoked_confirmed_ids, '{}')) x), '{}');
  end if;
  new.revocation_pending := not (coalesce(new.revoked_key_ids, '{}') <@ coalesce(new.revoked_confirmed_ids, '{}'));
  return new;
end
$$;

drop trigger if exists api_accounts_guard on public.api_accounts;
create trigger api_accounts_guard before insert or update on public.api_accounts
  for each row execute function public.gf_api_accounts_guard();

-- Rows that predate this migration get their flag once.
update public.api_accounts set revoked_key_ids = revoked_key_ids where coalesce(array_length(revoked_key_ids, 1), 0) > 0;

-- ---------------------------------------------------------------------------
-- B. The ledger copy
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  event_id text primary key check (length(btrim(event_id)) > 0),
  seq bigint not null unique,
  account text not null check (length(btrim(account)) > 0),
  key_id text not null default '',
  scope text not null default '',
  endpoint text not null default '',
  units integer not null check (units > 0),
  kind text not null check (kind in ('charge', 'refund')),
  project text not null default '',
  idem text not null default '',
  -- For a refund, the event_id of the charge it reverses.
  ref text not null default '',
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  check (kind = 'refund' or ref = '')
);
create index if not exists usage_events_account_time_idx on public.usage_events (account, occurred_at);

-- A ledger is append-only. A correction is a compensating `refund` event from the engine, never an edit here.
create or replace function public.gf_usage_events_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'usage_events is append-only: % is not permitted', tg_op using errcode = '42501';
end
$$;
drop trigger if exists usage_events_guard on public.usage_events;
create trigger usage_events_guard before update or delete on public.usage_events
  for each row execute function public.gf_usage_events_guard();

create table if not exists public.payg_cursor (
  id integer primary key check (id = 1),
  last_seq bigint not null default 0 check (last_seq >= 0),
  updated_at timestamptz not null default now()
);
insert into public.payg_cursor (id, last_seq) values (1, 0) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- C. Settlements and alerts
-- ---------------------------------------------------------------------------
create table if not exists public.usage_settlements (
  id uuid primary key default gen_random_uuid(),
  account text not null check (length(btrim(account)) > 0),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Units BILLED by this row (net of refunds; for an invoiced row, includes units carried in from earlier months).
  units integer not null check (units >= 0),
  amount_cents integer not null check (amount_cents >= 0),
  -- pending  row exists, Stripe not yet fully done (a retry finishes it; it never creates a second invoice)
  -- carried  below the minimum invoice: rolls into a later month (rolled_into names it once it has)
  -- invoiced finalised on Stripe, collection in progress
  -- paid / failed  from the Stripe webhook (absolute, order-safe; paid is never overwritten by a late failed)
  -- void     nothing to charge (net zero)
  status text not null default 'pending' check (status in ('pending', 'carried', 'invoiced', 'paid', 'failed', 'void')),
  carried_units integer not null default 0 check (carried_units >= 0),
  carried_months text[] not null default '{}',
  rolled_into text,
  stripe_invoice_id text,
  stripe_invoice_item_id text,
  hosted_invoice_url text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account, month)
);
create index if not exists usage_settlements_status_idx on public.usage_settlements (status);
create index if not exists usage_settlements_invoice_idx on public.usage_settlements (stripe_invoice_id);

create table if not exists public.usage_alerts (
  account text not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  percent integer not null check (percent between 1 and 100),
  sent_at timestamptz not null default now(),
  primary key (account, month, percent)
);

-- ---------------------------------------------------------------------------
-- D. Product events (names and property keys are allow-listed in lib/funnel.ts; this is the second fence)
-- ---------------------------------------------------------------------------
create table if not exists public.funnel_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name in ('free_account_created', 'key_minted', 'payg_enabled', 'first_charge', 'payment_failed', 'alert_sent')),
  props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object'),
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists funnel_events_name_time_idx on public.funnel_events (name, created_at);

-- ---------------------------------------------------------------------------
-- E. Founding Partner credit: one reserved slot per checkout session
-- ---------------------------------------------------------------------------
create table if not exists public.founding_reservations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Atomically reserve a slot: paid + live reservations < total. Serialised so N concurrent checkouts cannot all take the last slot.
-- Returns the reservation id, or null when no slot is left.
create or replace function public.gf_founding_reserve(p_paid integer, p_total integer, p_ttl_minutes integer) returns uuid
language plpgsql as $$
declare v_id uuid; v_live integer;
begin
  if p_paid is null or p_total is null or p_paid < 0 or p_total < 0 or p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 2880 then
    raise exception 'founding reservation arguments out of range' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('gf_founding_reserve'));
  delete from public.founding_reservations where expires_at <= now();
  select count(*) into v_live from public.founding_reservations;
  if p_paid + v_live >= p_total then
    return null;
  end if;
  insert into public.founding_reservations (expires_at) values (now() + make_interval(mins => p_ttl_minutes)) returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- F. The ledger, in one transaction with its cursor
-- ---------------------------------------------------------------------------
-- p_events: a JSON array of ledger events (already validated by the caller). Rows are inserted ON CONFLICT DO NOTHING, and the
-- cursor is advanced to p_cursor in the SAME transaction: either the events are durable and the cursor has moved, or neither.
create or replace function public.gf_usage_ingest(p_events jsonb, p_cursor bigint) returns jsonb
language plpgsql as $$
declare v_inserted integer;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a JSON array' using errcode = '22023';
  end if;
  with ins as (
    insert into public.usage_events (event_id, seq, account, key_id, scope, endpoint, units, kind, project, idem, ref, occurred_at)
    select e->>'event_id', (e->>'seq')::bigint, e->>'account', coalesce(e->>'key_id', ''), coalesce(e->>'scope', ''),
           coalesce(e->>'endpoint', ''), (e->>'units')::integer, e->>'kind', coalesce(e->>'project', ''), coalesce(e->>'idem', ''),
           coalesce(e->>'ref', ''), (e->>'occurred_at')::timestamptz
    from jsonb_array_elements(p_events) e
    on conflict (event_id) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;
  insert into public.payg_cursor (id, last_seq, updated_at) values (1, p_cursor, now())
    on conflict (id) do update set last_seq = greatest(public.payg_cursor.last_seq, excluded.last_seq), updated_at = now();
  return jsonb_build_object('inserted', v_inserted, 'cursor', (select last_seq from public.payg_cursor where id = 1));
end
$$;

-- ---------------------------------------------------------------------------
-- G. Net usage. A refund counts in the month (and scope) of the CHARGE it reverses, so a refund landing a millisecond after
--    midnight cannot make one month negative and the next one overbilled.
-- ---------------------------------------------------------------------------
create or replace view public.usage_effective with (security_invoker = true) as
select e.event_id, e.account, e.kind, e.units,
       coalesce(c.scope, e.scope) as scope,
       coalesce(c.occurred_at, e.occurred_at) as effective_at
from public.usage_events e
left join public.usage_events c on e.kind = 'refund' and c.event_id = e.ref and c.kind = 'charge';

create or replace function public.gf_usage_net(p_account text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'charged',     coalesce(sum(units) filter (where kind = 'charge'), 0),
    'refunded',    coalesce(sum(units) filter (where kind = 'refund'), 0),
    'net',         greatest(0, coalesce(sum(case when kind = 'charge' then units else -units end), 0)),
    'billable_net', greatest(0, coalesce(sum(case when kind = 'charge' then units else -units end) filter (where scope = 'payg'), 0))
  )
  from public.usage_effective
  where account = p_account and effective_at >= p_from and effective_at < p_to
$$;

-- Every account with usage in a window (for the 80% / 100% alerts).
create or replace function public.gf_usage_month_totals(p_from timestamptz, p_to timestamptz)
returns table (account text, net_units bigint, billable_units bigint)
language sql stable as $$
  select account,
         greatest(0, sum(case when kind = 'charge' then units else -units end))::bigint,
         greatest(0, coalesce(sum(case when kind = 'charge' then units else -units end) filter (where scope = 'payg'), 0))::bigint
  from public.usage_effective
  where effective_at >= p_from and effective_at < p_to
  group by account
$$;

-- Closed months (before p_before, 'YYYY-MM') that have PAYG-scope usage and no settlement row yet. Only scope 'payg' is ever
-- billable: free-allowance ('trial') and subscription ('machine') events never produce a row here.
create or replace function public.gf_payg_unsettled(p_before text)
returns table (account text, month text, net_units bigint)
language sql stable as $$
  select u.account, u.month, greatest(0, sum(u.delta))::bigint
  from (
    select v.account,
           to_char(v.effective_at at time zone 'UTC', 'YYYY-MM') as month,
           case when v.kind = 'charge' then v.units else -v.units end as delta
    from public.usage_effective v
    where v.scope = 'payg'
  ) u
  join public.api_accounts a on a.account = u.account
  where u.month < p_before
    and not exists (select 1 from public.usage_settlements s where s.account = u.account and s.month = u.month)
  group by u.account, u.month
  order by u.account, u.month
$$;

-- ---------------------------------------------------------------------------
-- H. One free allowance per normalised email, at most p_max new free accounts per UTC calendar month, atomically.
-- ---------------------------------------------------------------------------
create or replace function public.gf_free_account_create(
  p_email_norm text, p_email text, p_company text, p_token text, p_account text, p_units integer, p_max integer
) returns jsonb
language plpgsql as $$
declare v_id uuid; v_month_start timestamptz; v_count integer;
begin
  if p_email_norm is null or length(btrim(p_email_norm)) = 0 or p_max is null or p_max < 0 or p_units is null or p_units < 1 then
    raise exception 'free account arguments out of range' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('gf_free_account_create'));
  select id into v_id from public.api_accounts where free_email_norm = p_email_norm;
  if found then
    return jsonb_build_object('created', false, 'id', v_id);
  end if;
  v_month_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  select count(*) into v_count from public.api_accounts where free_email_norm is not null and created_at >= v_month_start;
  if v_count >= p_max then
    return jsonb_build_object('created', false, 'reason', 'capacity');
  end if;
  insert into public.api_accounts (token, account, email, company, plan, monthly_units, status, free_email_norm)
  values (p_token, p_account, p_email, p_company, 'api_free', p_units, 'active', p_email_norm)
  returning id into v_id;
  return jsonb_build_object('created', true, 'id', v_id);
end
$$;

-- ---------------------------------------------------------------------------
-- I. The access email for a free allowance and the usage alerts are obligations in the existing durable outbox (0021).
-- ---------------------------------------------------------------------------
alter table public.customer_notifications drop constraint if exists customer_notifications_kind_check;
alter table public.customer_notifications add constraint customer_notifications_kind_check
  check (kind in ('intake_link', 'api_access_link', 'watch_link', 'key_rotation', 'subscription_welcome', 'team_invitation', 'usage_alert'));

-- ---------------------------------------------------------------------------
-- J. Service role only, at the table and the function layer (see 0020).
-- ---------------------------------------------------------------------------
alter table public.usage_events enable row level security;
alter table public.payg_cursor enable row level security;
alter table public.usage_settlements enable row level security;
alter table public.usage_alerts enable row level security;
alter table public.funnel_events enable row level security;
alter table public.founding_reservations enable row level security;
-- No policies: the service role reaches these through the site's own routes.
revoke all on public.usage_events from public;
revoke all on public.payg_cursor from public;
revoke all on public.usage_settlements from public;
revoke all on public.usage_alerts from public;
revoke all on public.funnel_events from public;
revoke all on public.founding_reservations from public;
revoke all on public.usage_effective from public;

do $$
declare r text; t text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array['usage_events', 'payg_cursor', 'usage_settlements', 'usage_alerts', 'funnel_events', 'founding_reservations', 'usage_effective'] loop
        execute format('revoke all on public.%I from %I', t, r);
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach t in array array['usage_events', 'payg_cursor', 'usage_settlements', 'usage_alerts', 'funnel_events', 'founding_reservations', 'usage_effective'] loop
      execute format('grant all on public.%I to service_role', t);
    end loop;
  end if;
end
$$;

-- 0020's loop, applied again: every gf_* function (including the ones above) is executable by service_role only.
do $$
declare f text; r text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'gf\_%' loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;
