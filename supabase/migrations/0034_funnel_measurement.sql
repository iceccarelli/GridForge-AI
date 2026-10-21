-- 0034_funnel_measurement.sql — measure the real adoption funnel, privacy-safe
--
-- funnel_events (0028) is a closed vocabulary of product events: allow-listed names and property keys, no emails, tokens, site inputs,
-- card data or free text. This widens the NAME list (the allow-list in lib/funnel.ts is the first fence; this is the second) and adds
-- the two read functions the admin report uses. They return ONE jsonb value each: Supabase's PostgREST caps a set-returning function
-- at 1000 rows, and a report must never be silently truncated by that.
--
--   gf_funnel_summary(p_since)  counts by event name in the window, the free-account cohort (account reference + time), the account
--                               references that reached each later step (all time, so a step reached after the window still counts
--                               for the cohort that started inside it), and counts by product kind / cancellation reason.
--   gf_usage_activity()         per account: the first time it made a charge that stood, and the UTC weeks (Monday dates) in which
--                               it had net usage. Net of refunds, so a refused-and-refunded request is not "use".
--
-- Additive and idempotent. Service role only (0020 pattern).

alter table public.funnel_events drop constraint if exists funnel_events_name_check;
alter table public.funnel_events add constraint funnel_events_name_check
  check (name in (
    'free_account_created', 'key_minted', 'payg_enabled', 'first_charge', 'payment_failed', 'alert_sent',
    'qualify_started', 'qualify_completed', 'project_created', 'project_saved_result', 'first_engine_use', 'allowance_exhausted',
    'engagement_commissioned', 'subscription_started', 'subscription_cancelled', 'refund_issued', 'dispute_opened'
  ));

create or replace function public.gf_funnel_summary(p_since timestamptz) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(name, n)
      from (select name, count(*) as n from public.funnel_events where created_at >= p_since group by name) c
    ), '{}'::jsonb),
    'cohort', coalesce((
      select jsonb_agg(jsonb_build_object('ref', props->>'account_ref', 'at', created_at))
      from public.funnel_events
      where name = 'free_account_created' and created_at >= p_since and props ? 'account_ref'
    ), '[]'::jsonb),
    'refs', coalesce((
      select jsonb_object_agg(name, refs)
      from (
        select name, jsonb_agg(distinct props->>'account_ref') as refs
        from public.funnel_events
        where name in ('key_minted', 'payg_enabled', 'first_charge', 'first_engine_use', 'allowance_exhausted') and props ? 'account_ref'
        group by name
      ) r
    ), '{}'::jsonb),
    'by_kind', coalesce((
      select jsonb_object_agg(name, kinds)
      from (
        select name, jsonb_object_agg(k, n) as kinds
        from (
          select name, coalesce(props->>'kind', 'unspecified') as k, count(*) as n
          from public.funnel_events
          where created_at >= p_since
            and name in ('subscription_started', 'subscription_cancelled', 'engagement_commissioned', 'payment_failed', 'refund_issued', 'dispute_opened', 'project_saved_result')
          group by name, coalesce(props->>'kind', 'unspecified')
        ) g
        group by name
      ) h
    ), '{}'::jsonb),
    'cancel_reasons', coalesce((
      select jsonb_object_agg(r, n)
      from (
        select props->>'reason' as r, count(*) as n
        from public.funnel_events
        where name = 'subscription_cancelled' and created_at >= p_since and props ? 'reason'
        group by props->>'reason'
      ) q
    ), '{}'::jsonb),
    'evidence_classes', coalesce((
      select jsonb_object_agg(e, n)
      from (
        select props->>'evidence_class' as e, count(*) as n
        from public.funnel_events
        where name = 'qualify_completed' and created_at >= p_since and props ? 'evidence_class'
        group by props->>'evidence_class'
      ) v
    ), '{}'::jsonb)
  )
$$;

create index if not exists usage_events_ref_idx on public.usage_events (ref) where kind = 'refund';

create or replace function public.gf_usage_activity() returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(account, jsonb_build_object('first', first_at, 'weeks', weeks)), '{}'::jsonb)
  from (
    select w.account, f.first_at, jsonb_agg(w.week order by w.week) as weeks
    from (
      select account, to_char(date_trunc('week', effective_at at time zone 'UTC'), 'YYYY-MM-DD') as week
      from public.usage_effective
      group by account, to_char(date_trunc('week', effective_at at time zone 'UTC'), 'YYYY-MM-DD')
      having sum(case when kind = 'charge' then units else -units end) > 0
    ) w
    join (
      select account, min(occurred_at) as first_at from public.usage_events where kind = 'charge' group by account
    ) f on f.account = w.account
    group by w.account, f.first_at
  ) a
$$;

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

-- One jsonb for the month's economics (a set-returning function would be capped at 1000 rows by PostgREST).
create or replace function public.gf_usage_month_summary(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'by_scope', coalesce((
      select jsonb_object_agg(scope, units)
      from (
        select scope, greatest(0, sum(case when kind = 'charge' then units else -units end)) as units
        from public.usage_effective
        where effective_at >= p_from and effective_at < p_to
        group by scope
      ) s
    ), '{}'::jsonb),
    'accounts', (select count(distinct account) from public.usage_effective where effective_at >= p_from and effective_at < p_to)
  )
$$;

do $$
declare f text; r text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'gf_usage_month_summary' loop
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
