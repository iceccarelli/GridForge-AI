-- 0042_checkout_funnel.sql — measure where checkouts fail, without confusing a created session with a payment
--
-- Three new funnel events (lib/funnel.ts is the writer; app/api/checkout/route.ts the only place they are recorded):
--
--   checkout_attempted        a VALID catalogue request passed every gate the site controls and was handed to Stripe.
--   checkout_session_created  Stripe returned a hosted-page URL. This is NOT a payment: nothing is charged by it and the buyer may never
--                             open the page. The only payment evidence stays the webhook's engagement_commissioned / subscription_started.
--   checkout_failed           a valid request that was refused, or that Stripe could not turn into a session, with ONE fixed reason.
--
-- Unlike every other funnel event (0036: the database does not look inside props), these three are fenced by the database as well:
-- funnel_events_checkout_props_check allows exactly the keys `kind` (always) and `reason` (checkout_failed only), `kind` from the closed
-- product list, `reason` from the closed failure list. A third key, an email, a token, a Stripe id, a company name or any other value is
-- refused by the table, whoever writes it. The lists below are the lists in lib/funnel.ts (CHECKOUT_KINDS, CHECKOUT_FAILURE_REASONS);
-- tests/site/checkout-funnel.test.ts parses this file so the two cannot drift. A product added to lib/products.ts needs its kind added here
-- (until it is, its events are refused by the table and simply not recorded: recording is best-effort and never changes a checkout).
--
-- gf_checkout_funnel_summary(p_since) is the one read the admin report uses for them: ONE jsonb (PostgREST caps a set-returning function at
-- 1000 rows). It is separate from gf_funnel_summary so that the report still works, with the checkout section marked unavailable, on a
-- database where this migration has not been applied yet.
--
-- Additive and idempotent. No row is rewritten or deleted (the new constraint is added NOT VALID, then validated: no existing row can have
-- these names). RLS and privileges on funnel_events are exactly what 0028/0020/0040 set: not touched. Service role only for the function.

alter table public.funnel_events drop constraint if exists funnel_events_name_check;
alter table public.funnel_events add constraint funnel_events_name_check
  check (name in (
    'free_account_created', 'key_minted', 'payg_enabled', 'first_charge', 'payment_failed', 'alert_sent',
    'qualify_started', 'qualify_completed', 'project_created', 'project_saved_result', 'first_engine_use', 'allowance_exhausted',
    'engagement_commissioned', 'subscription_started', 'subscription_cancelled', 'refund_issued', 'dispute_opened',
    'checkout_attempted', 'checkout_session_created', 'checkout_failed'
  ));

alter table public.funnel_events drop constraint if exists funnel_events_checkout_props_check;
alter table public.funnel_events add constraint funnel_events_checkout_props_check
  check (
    name not in ('checkout_attempted', 'checkout_session_created', 'checkout_failed')
    or coalesce(
      case when jsonb_typeof(props) = 'object' then
        (props - 'kind' - 'reason') = '{}'::jsonb
        and jsonb_typeof(props->'kind') = 'string'
        and props->>'kind' in (
          'density_screen', 'envelope_study_deposit', 'hall_watch', 'portfolio_screen_deposit', 'procurement_spec',
          'api_triage', 'api_scale', 'api_platform', 'engagement_deposit'
        )
        and case when name = 'checkout_failed' then
              jsonb_typeof(props->'reason') = 'string'
              and props->>'reason' in (
                'payments_not_configured', 'project_reference_rejected', 'store_unavailable', 'api_plan_not_ready',
                'founding_slots_unreadable', 'founding_reservation_failed', 'stripe_coupon_failed', 'stripe_session_failed'
              )
            else not (props ? 'reason')
            end
      else false end,
      false)
  ) not valid;
alter table public.funnel_events validate constraint funnel_events_checkout_props_check;

comment on table public.funnel_events is
  'Product events. DB fence: name is one of a fixed list (check) and props is a JSON object. NOT fenced in the database: property keys and values, except for the three checkout events (checkout_attempted, checkout_session_created, checkout_failed), whose props funnel_events_checkout_props_check restricts to a closed kind and a closed reason. Everything else is constrained only by lib/funnel.ts (the only writer). dedupe_key holds an opaque keyed digest, never a readable key. A checkout_session_created event is NOT a payment.';
comment on column public.funnel_events.props is
  'JSON object. Keys and values are validated by lib/funnel.ts before insert, not by a database constraint (the three checkout events are additionally fenced by funnel_events_checkout_props_check).';

create or replace function public.gf_checkout_funnel_summary(p_since timestamptz) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(name, n)
      from (
        select name, count(*) as n from public.funnel_events
        where created_at >= p_since and name in ('checkout_attempted', 'checkout_session_created', 'checkout_failed')
        group by name
      ) c
    ), '{}'::jsonb),
    'by_kind', coalesce((
      select jsonb_object_agg(name, kinds)
      from (
        select name, jsonb_object_agg(k, n) as kinds
        from (
          select name, coalesce(props->>'kind', 'unspecified') as k, count(*) as n
          from public.funnel_events
          where created_at >= p_since and name in ('checkout_attempted', 'checkout_session_created', 'checkout_failed')
          group by name, coalesce(props->>'kind', 'unspecified')
        ) g
        group by name
      ) h
    ), '{}'::jsonb),
    'failed_reasons', coalesce((
      select jsonb_object_agg(r, n)
      from (
        select coalesce(props->>'reason', 'unspecified') as r, count(*) as n
        from public.funnel_events
        where name = 'checkout_failed' and created_at >= p_since
        group by coalesce(props->>'reason', 'unspecified')
      ) q
    ), '{}'::jsonb),
    'failed_by_kind', coalesce((
      select jsonb_object_agg(k, reasons)
      from (
        select k, jsonb_object_agg(r, n) as reasons
        from (
          select coalesce(props->>'kind', 'unspecified') as k, coalesce(props->>'reason', 'unspecified') as r, count(*) as n
          from public.funnel_events
          where name = 'checkout_failed' and created_at >= p_since
          group by coalesce(props->>'kind', 'unspecified'), coalesce(props->>'reason', 'unspecified')
        ) z
        group by k
      ) y
    ), '{}'::jsonb)
  )
$$;

do $$
declare f text; r text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'gf_checkout_funnel_summary' loop
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
