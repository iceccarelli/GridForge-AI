-- 0046_freeze_the_forecast.sql: a forecast cannot be rewritten after the outcome is known, and an outcome is only ever judged against a
-- forecast that was made BEFORE it.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Nothing in the application needs it to be applied
-- before it is: the observation route already compares the revision's creation time with the observation date (lib/project-observations.ts)
-- and the ledger export reads a view whose definition 0038 gave it. Until this is applied the database itself still enforces neither.
--
-- Why. 0014 says a revision is "never mutated", and lib/power-deploy.ts honours that, but nothing in the database did: a service-role
-- caller could rewrite a revision's request, result or engine provenance (or back-date its created_at) after the measurement was in, and
-- the observation pipeline never compared the revision's creation time with the date of the outcome, so a revision created AFTER the
-- outcome still reached the calibration ledger view. Calibration is only worth anything if the prediction was fixed before reality
-- answered it.
--
-- REPLAY ORDER. 0046, 0047 and 0048 each REPLACE calibration_ledger_rows; the definition that governs is the LAST one applied (0048's, which
-- holds every gate). Re-running an older migration of this family (or 0038) after a later one silently replaces the view, and for 0038 also
-- gf_submit_observation, with an OLDER and weaker definition. Migrations are applied once, in order (scripts/apply-migration.py gate 2 refuses
-- anything else). tests/test_calibration_final_gate.py reads the FINAL view and function from a database built by the whole chain and fails if
-- any gate is missing, so a reorder or a later redefinition that drops one fails CI.
--
-- What changed (a read of every writer first: lib/, app/, scripts/, gridforge/ and the tests contain NO update or delete of
-- power_deployment_cases, only an insert (lib/power-deploy.ts insertRevisionRow, gf_append_case_revision) and selects, so nothing legitimate
-- is blocked):
--   A. case_digest: sha256 of the canonical request + result, computed by the DATABASE when the revision is inserted (a caller cannot
--      supply it) and immutable afterwards. The canonical form is the jsonb text of {"request": ..., "result": ...}: jsonb sorts keys and
--      fixes spacing, so the same content has one digest whatever order a client sent its keys in. pgcrypto is not needed: sha256(bytea)
--      is built in (as 0038 and 0040 already use). Revisions written before this migration keep NULL: a digest taken now would only
--      prove the content has not changed since this migration, not since it was written, so nothing is back-filled and nothing is invented.
--      CONSEQUENCE, stated plainly: an observation against a revision written before 0046 (case_digest NULL) is refused when submitted and is
--      NOT exportable, because nothing can show its forecast was not rewritten.
--   B. A row guard. INSERT: created_at is ALWAYS set to the database clock (clock_timestamp()); a value the caller sent is discarded, there is no
--      tolerance window. UPDATE: only the contact fields (email, company, project_name) may change; every other column, request, result,
--      engine_provenance, created_at, case_token, revision, changed_fields, case_digest and id, is frozen. DELETE is refused. The restore check
--      (scripts/verify-backup-restore.py) loads a SCRATCH database under session_replication_role = replica, which skips these triggers. So
--      does a superuser or table-owner connection that disables triggers: this is a guard against the application role and against mistakes,
--      not against the database owner.
--   C. A TRUNCATE guard (gf_append_only, the pattern of 0025/0038/0040).
--   D. An observation can only be inserted against a forecast that predates the outcome AND that it actually reports on:
--        * the stored revision it names must exist, have a creation time and a case_digest (GF004);
--        * observed_on cannot be after today (UTC, database clock): an outcome in the future is not an outcome (GF004);
--        * the forecast must have been created before the START (00:00 UTC) of observed_on. A forecast made on the day of the measurement
--          does not predate it: the measurement covers the whole date and cannot be placed after the forecast (GF004);
--        * predicted_value must equal the number the stored revision's own result holds for that architecture (the first element of
--          result.architectures whose label matches, key available_MW, as lib/project-observations.ts reads it). Without this the revision
--          could be frozen and still be cited with any prediction (GF004).
--      A stored observation is never rewritten by this (observations stay append-only, 0017).
--   E. calibration_ledger_rows applies the forecast rules again, for rows that were stored before the rules existed: the revision must exist,
--      have a creation time before the start of observed_on, carry a case_digest that still equals the digest of its stored request and result
--      (a revision edited with triggers off drops out), and its result must still hold the observation's predicted_value. Every column and the
--      privileges of the view are unchanged. (case_digest is NOT added to the view's columns: `gridforge calibrate import` reads the view by
--      column, and this migration does not change that contract.)
--
-- Additive and idempotent: `add column if not exists`, `create or replace`, `drop trigger if exists` then `create trigger`. No row is
-- rewritten or deleted and no table is rebuilt (adding a nullable column is a catalogue change). RLS stays on with no policies.

-- ---------------------------------------------------------------------------
-- A. The digest column
-- ---------------------------------------------------------------------------
alter table public.power_deployment_cases add column if not exists case_digest text;
alter table public.power_deployment_cases drop constraint if exists power_deployment_cases_case_digest_check;
alter table public.power_deployment_cases add constraint power_deployment_cases_case_digest_check
  check (case_digest is null or case_digest ~ '^[0-9a-f]{64}$');
comment on column public.power_deployment_cases.case_digest is
  'sha256 (hex) of the jsonb text of {"request": request, "result": result}, set by the database at insert and immutable. NULL for revisions '
  'written before migration 0046: never back-filled, because a digest taken later would not prove the content is what was first written.';

-- ---------------------------------------------------------------------------
-- B. The row guard
-- ---------------------------------------------------------------------------
create or replace function public.gf_case_revision_guard() returns trigger
language plpgsql as $$
declare
  contact text[] := array['email', 'company', 'project_name'];
begin
  if tg_op = 'INSERT' then
    -- Whatever the caller sent is discarded: a forecast revision cannot be back-dated or future-dated.
    new.created_at := clock_timestamp();
    new.case_digest := encode(sha256(convert_to(jsonb_build_object('request', new.request, 'result', new.result)::text, 'UTF8')), 'hex');
    return new;
  elsif tg_op = 'DELETE' then
    raise exception 'power_deployment_cases revisions are immutable: DELETE is not permitted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - contact) is distinct from (to_jsonb(old) - contact) then
    raise exception 'power_deployment_cases revisions are immutable: only email, company and project_name may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists power_deployment_cases_guard on public.power_deployment_cases;
create trigger power_deployment_cases_guard
  before insert or update or delete on public.power_deployment_cases
  for each row execute function public.gf_case_revision_guard();

-- ---------------------------------------------------------------------------
-- C. Truncate
-- ---------------------------------------------------------------------------
drop trigger if exists power_deployment_cases_no_truncate on public.power_deployment_cases;
create trigger power_deployment_cases_no_truncate
  before truncate on public.power_deployment_cases
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- D. An observation is judged only against a forecast that predates it
-- ---------------------------------------------------------------------------
-- The number a stored result holds for one architecture: the FIRST element of result.architectures with that label, its available_MW, if it
-- is a JSON number. This is the engine's own prediction that lib/project-observations.ts reads (archs.find(label) then available_MW).
create or replace function public.gf_forecast_predicted_mw(p_result jsonb, p_label text) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(a.elem->'available_MW') = 'number' then (a.elem->>'available_MW')::numeric end
    from jsonb_array_elements(case when jsonb_typeof(p_result->'architectures') = 'array' then p_result->'architectures' else '[]'::jsonb end)
         with ordinality as a(elem, ord)
   where a.elem->>'label' = p_label
   order by a.ord
   limit 1
$$;

create or replace function public.gf_observation_forecast_predates() returns trigger
language plpgsql as $$
declare c public.power_deployment_cases; predicted numeric;
begin
  select * into c from public.power_deployment_cases
   where case_token = new.case_token and revision = new.case_revision;
  if not found then
    raise exception 'the forecast must predate the outcome, and no stored revision % of that case exists to show it did', new.case_revision
      using errcode = 'GF004';
  end if;
  if c.created_at is null then
    raise exception 'the forecast must predate the outcome, and revision % of that case has no recorded creation time', new.case_revision
      using errcode = 'GF004';
  end if;
  if c.case_digest is null then
    raise exception 'revision % of that case predates the forecast freeze (it has no case_digest), so nothing shows its forecast was not rewritten', new.case_revision
      using errcode = 'GF004';
  end if;
  if new.observed_on > (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'the outcome cannot be dated in the future: observed_on % is after today (UTC)', new.observed_on
      using errcode = 'GF004';
  end if;
  if c.created_at >= (new.observed_on::timestamp at time zone 'UTC') then
    raise exception 'the forecast must predate the outcome: revision % was created at %, not before the start of the observed date %',
      new.case_revision, to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), new.observed_on
      using errcode = 'GF004';
  end if;
  predicted := public.gf_forecast_predicted_mw(c.result, new.architecture);
  if predicted is null or predicted is distinct from new.predicted_value then
    raise exception 'the predicted value must be the number the stored forecast holds for that architecture (revision %, %): % is not it',
      new.case_revision, new.architecture, new.predicted_value
      using errcode = 'GF004';
  end if;
  return new;
end;
$$;

drop trigger if exists project_observations_forecast_predates on public.project_observations;
create trigger project_observations_forecast_predates
  before insert on public.project_observations
  for each row execute function public.gf_observation_forecast_predates();

-- ---------------------------------------------------------------------------
-- E. The ledger view applies the same rule to rows stored before it existed (0038's definition plus the forecast join)
-- ---------------------------------------------------------------------------
create or replace view public.calibration_ledger_rows with (security_invoker = true) as
select o.id,
       o.calibration_key as key,
       o.observed_value,
       o.predicted_value,
       o.unit,
       o.site_ref,
       o.measurement_kind,
       r.evidence_sha256,
       o.engine_provenance_digest,
       o.report_date,
       o.observed_on,
       o.method,
       r.evidence_class,
       r.reviewer as reviewed_by,
       r.reviewed_at
from public.project_observations o
join public.project_observation_reviews r on r.observation_id = o.id
join public.project_evidence e on e.id = o.evidence_id
join public.power_deployment_cases c on c.case_token = o.case_token and c.revision = o.case_revision
where r.decision = 'verified'
  and r.evidence_class = 'E5'
  and o.measurement_kind in ('metered', 'bms_trend', 'commissioning_record')
  and o.calibration_key = 'btm.firm_MW' and o.unit = 'MW'
  and o.site_ref is not null
  and o.engine_provenance_digest is not null
  and r.evidence_sha256 is not null
  and e.review_status = 'verified' and e.sha256 = r.evidence_sha256
  and lower(btrim(r.reviewer)) <> lower(btrim(o.submitted_by))
  and c.created_at is not null
  and c.created_at < (o.observed_on::timestamp at time zone 'UTC')
  and c.case_digest is not null
  and c.case_digest = encode(sha256(convert_to(jsonb_build_object('request', c.request, 'result', c.result)::text, 'UTF8')), 'hex')
  and o.predicted_value = public.gf_forecast_predicted_mw(c.result, o.architecture);

-- ---------------------------------------------------------------------------
-- Privileges, per 0020/0038: the gf_* functions are service_role-only; the view is readable by service_role alone.
-- ---------------------------------------------------------------------------
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
  revoke all on public.calibration_ledger_rows from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.calibration_ledger_rows from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.calibration_ledger_rows to service_role;
  end if;
end
$$;
