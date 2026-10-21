-- 0033_payg_hardening.sql — second-pass review fixes to 0028 (ledger quarantine, overlap keys, verified free-allowance ceiling)
--
-- Additive where it can be; two 0028 functions change signature and are dropped and recreated (PostgREST would otherwise see an
-- ambiguous overload). Idempotent.
--
--   usage_quarantine          a ledger event the site cannot read is set aside (with its reason) instead of stalling the whole
--                             ingest. The cursor moves past it IN THE SAME TRANSACTION as the good events, and a month that has an
--                             un-acknowledged quarantined event is never settled: the operator looks, then acknowledges.
--   gf_usage_ingest           now takes the quarantine list as well.
--   api_accounts.overlap_key_ids   {key id: last valid day} for keys deliberately left live alongside a newer one: the daily
--                             revocation sweep does not kill them before that day.
--   api_accounts.free_verified_at  set when the emailed link is first used to mint a key: the monthly ceiling counts THESE
--                             (verified) accounts, not unverified sign-ups, and is checked atomically at that moment.
--   gf_free_account_create    no longer enforces a ceiling (an unverified address must not be able to use up the allowance, nor
--                             reveal whether it is full); gf_free_account_verify does, at first mint.

create table if not exists public.usage_quarantine (
  seq bigint primary key,
  reason text not null check (length(btrim(reason)) > 0),
  -- The raw event, truncated by the caller; operator-visible only (service role).
  raw text not null default '',
  -- Month ('YYYY-MM') the event claims to belong to, when its timestamp could be read; null = unknown, which blocks every month.
  month text check (month is null or month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  account text,
  created_at timestamptz not null default now(),
  acked_at timestamptz,
  acked_note text
);
create index if not exists usage_quarantine_open_idx on public.usage_quarantine (month) where acked_at is null;

alter table public.api_accounts add column if not exists overlap_key_ids jsonb not null default '{}'::jsonb check (jsonb_typeof(overlap_key_ids) = 'object');
alter table public.api_accounts add column if not exists free_verified_at timestamptz;
create index if not exists api_accounts_free_verified_idx on public.api_accounts (free_verified_at) where free_verified_at is not null;

-- Accounts that already hold a key were verified by holding it.
update public.api_accounts set free_verified_at = coalesce(key_issued_at::timestamptz, created_at)
  where free_email_norm is not null and free_verified_at is null and (key_id is not null or coalesce(array_length(revoked_key_ids, 1), 0) > 0);

drop function if exists public.gf_usage_ingest(jsonb, bigint);
create or replace function public.gf_usage_ingest(p_events jsonb, p_cursor bigint, p_quarantine jsonb default '[]'::jsonb) returns jsonb
language plpgsql as $$
declare v_inserted integer; v_quarantined integer;
begin
  if p_events is null or jsonb_typeof(p_events) <> 'array' or p_quarantine is null or jsonb_typeof(p_quarantine) <> 'array' then
    raise exception 'p_events and p_quarantine must be JSON arrays' using errcode = '22023';
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
  with q as (
    insert into public.usage_quarantine (seq, reason, raw, month, account)
    select (e->>'seq')::bigint, e->>'reason', coalesce(e->>'raw', ''), nullif(e->>'month', ''), nullif(e->>'account', '')
    from jsonb_array_elements(p_quarantine) e
    on conflict (seq) do nothing
    returning 1
  )
  select count(*) into v_quarantined from q;
  insert into public.payg_cursor (id, last_seq, updated_at) values (1, p_cursor, now())
    on conflict (id) do update set last_seq = greatest(public.payg_cursor.last_seq, excluded.last_seq), updated_at = now();
  return jsonb_build_object('inserted', v_inserted, 'quarantined', v_quarantined, 'cursor', (select last_seq from public.payg_cursor where id = 1));
end
$$;

drop function if exists public.gf_free_account_create(text, text, text, text, text, integer, integer);
create or replace function public.gf_free_account_create(
  p_email_norm text, p_email text, p_company text, p_token text, p_account text, p_units integer
) returns jsonb
language plpgsql as $$
declare v_id uuid;
begin
  if p_email_norm is null or length(btrim(p_email_norm)) = 0 or p_units is null or p_units < 1 then
    raise exception 'free account arguments out of range' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('gf_free_account_create'));
  select id into v_id from public.api_accounts where free_email_norm = p_email_norm;
  if found then
    return jsonb_build_object('created', false, 'id', v_id);
  end if;
  -- A colliding account id or token raises unique_violation to the caller, which retries with fresh random values.
  insert into public.api_accounts (token, account, email, company, plan, monthly_units, status, free_email_norm)
  values (p_token, p_account, p_email, p_company, 'api_free', p_units, 'active', p_email_norm)
  returning id into v_id;
  return jsonb_build_object('created', true, 'id', v_id);
end
$$;

-- At most p_max VERIFIED free accounts per UTC calendar month, atomically. Verified = the owner opened the emailed link and is
-- minting a key. Idempotent for an account already verified.
create or replace function public.gf_free_account_verify(p_token text, p_max integer) returns jsonb
language plpgsql as $$
declare v_id uuid; v_verified timestamptz; v_month_start timestamptz; v_count integer;
begin
  if p_token is null or p_max is null or p_max < 0 then
    raise exception 'free account verification arguments out of range' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('gf_free_account_verify'));
  select id, free_verified_at into v_id, v_verified from public.api_accounts where token = p_token and plan = 'api_free';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if v_verified is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  v_month_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  select count(*) into v_count from public.api_accounts where free_verified_at >= v_month_start;
  if v_count >= p_max then
    return jsonb_build_object('ok', false, 'reason', 'capacity');
  end if;
  update public.api_accounts set free_verified_at = now() where id = v_id;
  return jsonb_build_object('ok', true, 'already', false);
end
$$;

alter table public.usage_quarantine enable row level security;
revoke all on public.usage_quarantine from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.usage_quarantine from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.usage_quarantine to service_role;
  end if;
end
$$;

-- 0020's loop, applied again (the recreated functions are service_role-only).
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
