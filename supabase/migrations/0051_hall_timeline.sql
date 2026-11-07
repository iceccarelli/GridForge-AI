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
--   project_event    origin 'recorded', no class: a log entry of an attached project is not a measurement. The log of a project is shown only while
--                    it is attached; after a detachment it stops. (The attach and detach lines of the log are not repeated: they are their own rows.)
--   project_attached / project_detached   origin 'recorded': the fact that a project was put in, or taken out of, this hall, and by whom. Kept forever.
--   supplier_date    origin 'vendor': a date the SUPPLIER reported, "unreviewed" unless a reviewer vouched for that very date (a review lists
--                    the fields it covers: a date it does not list stays unreviewed). A replaced record (a correction exists) is left out.
--   observation      origin 'submitted' (NOT 'observed': on a hall input that word means a figure seen and backed by a file; here someone submitted an
--                    observation against a prediction); the evidence class is shown only when a reviewer verified it, otherwise the row says "unreviewed".
--
-- NO SECRETS. The view has no column that can carry a project link token, a package token, a storage location, a file digest or a log's
-- free-form payload (project_events.payload is not selected: it can hold case tokens). Summaries are built from fixed words, typed
-- numbers and dates, event names and the names people typed for their own project, supplier and file. tests/test_hall_timeline_migration.py
-- plants a token in every table and fails if one reaches the answer.
--
-- ORDER AND PAGING. Every row has the total key (occurred_at, source_table, source_id, subject); the answer is ordered by it, newest first, and a page ends
-- with an opaque cursor the database built from that key (the time at full microsecond precision, as text). The caller passes it back VERBATIM; the next
-- page is everything strictly before it by row comparison on the same key, so rows with equal timestamps (the same transaction, the same instant) are never
-- skipped and never repeated.
--
-- OPERATOR NOTES: `set lock_timeout = '5s';` first (see 0049); the view and the function are new and take no lock on a busy table.
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
   and e.event_type not in ('project_attached_to_hall', 'project_detached_from_hall')

union all

-- the fact that a project was put in this hall, and that it was taken out (the hall's own history; kept after a detachment)
select a.hall_id,
       a.attached_at,
       'project_attached'::text,
       'attached'::text,
       ('Project "' || p.project_name || '" attached to this hall')::text,
       'recorded'::text,
       null::text,
       'recorded attachment; the project''s link token was the credential'::text,
       a.attached_by::text,
       p.id,
       false,
       'hall_project_attachments'::text,
       a.id
  from public.hall_project_attachments a
  join public.projects p on p.id = a.project_id

union all

select d.hall_id,
       d.detached_at,
       'project_detached'::text,
       'detached'::text,
       ('Project "' || p.project_name || '" detached from this hall')::text,
       'recorded'::text,
       null::text,
       'recorded detachment by an owner of the organisation'::text,
       d.detached_by::text,
       p.id,
       false,
       'hall_project_detachments'::text,
       d.id
  from public.hall_project_detachments d
  join public.projects p on p.id = d.project_id

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
       'submitted'::text,
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

-- The way in: any member of the hall's organisation, newest first, bounded. p_cursor is the `next_cursor` of the previous page, passed back as is.
create or replace function public.gf_hall_timeline(p_actor text, p_hall uuid, p_limit int default 200, p_cursor text default null) returns jsonb
language plpgsql stable as $$
declare
  h public.halls;
  s public.sites;
  g text;
  lim int := least(greatest(coalesce(p_limit, 200), 1), 500);
  has_c boolean := p_cursor is not null;
  c jsonb;
  c_ts timestamptz;
  c_tbl text;
  c_id uuid;
  c_sub text;
  rows jsonb;
  n int;
  nxt text;
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'viewer');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  if has_c then
    begin
      c := p_cursor::jsonb;
      c_ts := (c->>'occurred_at')::timestamptz;
      c_tbl := c->>'source_table';
      c_id := (c->>'source_id')::uuid;
      c_sub := c->>'subject';
    exception when others then
      return jsonb_build_object('ok', false, 'reason', 'invalid_cursor');
    end;
    if c_ts is null or c_tbl is null or c_id is null or c_sub is null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_cursor');
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'hall_id' - 'rn' order by x.rn) filter (where x.rn <= lim), '[]'::jsonb),
         coalesce(max(x.rn), 0),
         (array_agg(jsonb_build_object('occurred_at', to_char(x.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'source_table', x.source_table,
                                       'source_id', x.source_id, 'subject', x.subject)::text order by x.rn) filter (where x.rn = lim))[1]
    into rows, n, nxt
    from (select t.*, row_number() over (order by t.occurred_at desc, t.source_table desc, t.source_id desc, t.subject desc) as rn
            from public.hall_timeline t
           where t.hall_id = h.id
             and (not has_c or (t.occurred_at, t.source_table, t.source_id, t.subject) < (c_ts, c_tbl, c_id, c_sub))) x
   where x.rn <= lim + 1;

  return jsonb_build_object(
    'ok', true,
    'hall', jsonb_build_object('id', h.id, 'label', h.label, 'site_name', s.name, 'org_id', s.org_id, 'data_origin', s.data_origin),
    'truncated', n > lim,
    'next_cursor', case when n > lim then nxt end,
    'events', rows);
end
$$;

-- Service role only, at the view and the function layer (0020, 0022, 0027).
do $$
declare r text;
begin
  revoke all on public.hall_timeline from public;
  revoke all on function public.gf_hall_timeline(text, uuid, int, text) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.hall_timeline from %I', r);
      execute format('revoke all on function public.gf_hall_timeline(text, uuid, int, text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on public.hall_timeline from service_role;
    grant select on public.hall_timeline to service_role;
    grant execute on function public.gf_hall_timeline(text, uuid, int, text) to service_role;
  end if;
end
$$;
