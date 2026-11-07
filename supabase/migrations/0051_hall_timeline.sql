-- 0051_hall_timeline.sql: one read-only timeline per hall.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Requires 0049, 0050, 0015, 0017 and 0018. Nothing in
-- the application needs the view until a member opens a hall's timeline; the route answers 503 until then.
--
-- What happened at a hall is spread over four append-only records: the figures recorded about it (0050), the history log of each attached
-- project (project_events, 0015), the delivery dates a supplier reported against a selected quote (supplier_actuals, 0018) and the
-- observations submitted against a prediction (project_observations, 0017). This is the UNION of them, nothing more: it computes nothing,
-- ranks nothing and writes nothing.
--
-- Every row says what it is (`kind`) and what stands behind it (`origin`, `evidence_class`, and `basis` in words), because a timeline that
-- mixes a model's assumption, a supplier's promise and a meter reading in one column would present them as the same kind of fact:
--   input_recorded   the figure's own origin and class. Several rows per field when it was corrected; the replaced one has superseded = true.
--   project_event    origin 'recorded', no class: a log entry of an attached project is not a measurement.
--   supplier_date    origin 'vendor': a date the SUPPLIER reported, "unreviewed" unless a reviewer vouched for that very date (a review lists
--                    the fields it covers: a date it does not list stays unreviewed). A replaced record (a correction exists) is left out.
--   observation      origin 'observed'; the evidence class is shown only when a reviewer verified it, otherwise the row says "unreviewed".
--
-- NO SECRETS. The view has no column that can carry a project link token, a package token, a storage location, a file digest or a log's
-- free-form payload (project_events.payload is not selected: it can hold case tokens). Summaries are built from fixed words, typed
-- numbers and dates, event names and the names people typed for their own project, supplier and file. tests/test_hall_timeline_migration.py
-- plants a token in every table and fails if one reaches the answer.
--
-- A view in `public` runs with its owner's rights unless told otherwise, which would let it step around the tables' row-level security; it is
-- `security_invoker`, readable only by the service role (like cost_evidence_state, 0022), and the function below is the way in: it checks the
-- actor's membership of the hall's organisation INSIDE the database.

create or replace view public.hall_timeline with (security_invoker = true) as
-- the figures recorded about the hall
select i.hall_id,
       i.created_at as occurred_at,
       'input_recorded'::text as kind,
       i.field_path as subject,
       case when i.origin = 'missing'
            then i.field_path || ': recorded as missing (as of ' || i.as_of || ')'
            else i.field_path || ' = ' || (i.value #>> '{}') || coalesce(' ' || i.unit, '') || ' (as of ' || i.as_of || ')' end as summary,
       i.origin,
       i.evidence_class,
       ('declared by ' || i.recorded_by
        || case when i.source_kind is null then '; no file cited'
                else '; cites ' || coalesce(i.source_filename, 'a file') || ' (' || coalesce(i.source_review_status, 'no review status') || ')' end)::text as basis,
       i.recorded_by as actor,
       null::uuid as project_id,
       i.superseded,
       'hall_inputs'::text as source_table,
       i.id as source_id
  from public.hall_inputs_labelled i

union all

-- the history log of each project attached to the hall
select p.hall_id,
       e.occurred_at,
       'project_event'::text,
       e.event_type::text,
       ('Project "' || p.project_name || '": ' || e.event_type)::text,
       'recorded'::text,
       null::text,
       'log entry of an attached project; not a measurement'::text,
       e.actor::text,
       p.id,
       false,
       'project_events'::text,
       e.id
  from public.project_events e
  join public.projects p on p.id = e.project_id
 where p.hall_id is not null

union all

-- the dates a supplier reported, one row per date given; a record that has been replaced by a correction is left out
select p.hall_id,
       (d.day::timestamp at time zone 'UTC'),
       'supplier_date'::text,
       d.field,
       (a.supplier || ': ' || replace(d.field, '_', ' '))::text,
       'vendor'::text,
       null::text,
       ('supplier-reported date; '
        || case when r.decision = 'verified' and d.field = any (r.verified_fields) then 'verified by a reviewer'
                when r.decision = 'rejected' then 'the record was rejected by a reviewer'
                when r.decision = 'verified' then 'unreviewed (the review does not cover this date)'
                else 'unreviewed' end)::text,
       a.submitted_by::text,
       p.id,
       false,
       'supplier_actuals'::text,
       a.id
  from public.supplier_actuals a
  join public.projects p on p.id = a.project_id and p.hall_id is not null
  left join public.supplier_actual_reviews r on r.actual_id = a.id
 cross join lateral (values ('po_date', a.po_date), ('dispatch_date', a.dispatch_date), ('on_site_date', a.on_site_date),
                            ('install_complete_date', a.install_complete_date), ('energised_date', a.energised_date)) as d (field, day)
 where d.day is not null
   and not exists (select 1 from public.supplier_actuals s where s.supersedes_id = a.id)

union all

-- observations submitted against a prediction
select p.hall_id,
       (o.observed_on::timestamp at time zone 'UTC'),
       'observation'::text,
       o.calibration_key::text,
       ('Observed ' || o.observed_value || ' ' || o.unit || ' against ' || o.predicted_value || ' predicted (' || o.calibration_key || ')')::text,
       'observed'::text,
       case when r.decision = 'verified' then r.evidence_class end,
       ('observation submitted for the project; '
        || case when r.id is null then 'unreviewed'
                when r.decision = 'verified' then 'reviewed: verified as ' || r.evidence_class
                else 'reviewed: rejected' end)::text,
       o.submitted_by::text,
       p.id,
       false,
       'project_observations'::text,
       o.id
  from public.project_observations o
  join public.projects p on p.id = o.project_id and p.hall_id is not null
  left join public.project_observation_reviews r on r.observation_id = o.id;

-- The way in: any member of the hall's organisation, newest first, bounded. p_before pages backwards (events strictly older than it).
create or replace function public.gf_hall_timeline(p_actor text, p_hall uuid, p_limit int default 200, p_before timestamptz default null) returns jsonb
language plpgsql stable as $$
declare
  h public.halls;
  s public.sites;
  g text;
  lim int := least(greatest(coalesce(p_limit, 200), 1), 500);
  rows jsonb;
  n int;
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'viewer');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'hall_id' order by x.occurred_at desc, x.source_id desc), '[]'::jsonb), count(*)
    into rows, n
    from (select t.* from public.hall_timeline t
           where t.hall_id = h.id and (p_before is null or t.occurred_at < p_before)
           order by t.occurred_at desc, t.source_id desc
           limit lim + 1) x;

  return jsonb_build_object(
    'ok', true,
    'hall', jsonb_build_object('id', h.id, 'label', h.label, 'site_name', s.name, 'org_id', s.org_id, 'data_origin', s.data_origin),
    'truncated', n > lim,
    'events', case when n > lim then (select coalesce(jsonb_agg(e order by ord), '[]'::jsonb)
                                        from jsonb_array_elements(rows) with ordinality as t(e, ord) where ord <= lim)
                   else rows end);
end
$$;

-- Service role only, at the view and the function layer (0020, 0022, 0027).
do $$
declare r text;
begin
  revoke all on public.hall_timeline from public;
  revoke all on function public.gf_hall_timeline(text, uuid, int, timestamptz) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.hall_timeline from %I', r);
      execute format('revoke all on function public.gf_hall_timeline(text, uuid, int, timestamptz) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.hall_timeline from service_role;
    grant select on public.hall_timeline to service_role;
    grant execute on function public.gf_hall_timeline(text, uuid, int, timestamptz) to service_role;
  end if;
end
$$;
