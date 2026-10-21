-- 0038_calibration_capture.sql — an observation reaches the calibration ledger only through a reviewer who is not
-- its submitter, against an evidence artifact that is itself verified, as a MEASUREMENT of a known kind.
--
-- Additive and idempotent. Nothing here writes the calibration ledger and no row becomes ledger data by itself: a
-- person runs `gridforge calibrate import` on the admin export (GET /api/admin/calibration-export), and that command
-- re-checks every row against the ledger's own policy. With zero verified rows the export is empty and the ledger
-- stays empty.
--
--  A. TRUNCATE guards. 0017/0018's row triggers do not fire on TRUNCATE, so the four review/record tables could be
--     emptied by one statement. A statement-level trigger closes that door (as 0025 did for project_comparisons).
--  B. Reviews are separate people and verified evidence. A review is refused when the reviewer is the submitter
--     (compared with the stored submitter name and with `submitted_by_ref`, the identity captured at submission),
--     and a VERIFIED review is refused unless the supporting evidence artifact is itself `verified`. The reviewer
--     is self-asserted text until per-person admin identity exists; this narrows what that can do, it does not
--     authenticate anyone.
--  C. Class and kind. A reviewer may assign ONLY E5 to a measured observation (E6/E7 are outputs of computation,
--     not of review). `ledger_eligible` follows only from E5 + measurement_kind in ('metered','bms_trend',
--     'commissioning_record') + a site reference + the engine provenance digest of the prediction + a review-time
--     snapshot of the evidence digest. A vendor quote, an assumed value and a measurement are different things;
--     only the last has a measurement_kind.
--  D. Provenance. `site_ref` (site label only, sha256 of the lower-cased trimmed label, first 12 hex, prefixed
--     'site_' — the same algorithm as gridforge.calibration.schema.site_only_ref) is derived by the database from
--     the project; `engine_provenance_digest` and `report_date` are read from the case revision, which now stores
--     the engine's /v1/version provenance (power_deployment_cases.engine_provenance), written when the revision is
--     written (lib/power-deploy.ts). Revisions written before this migration have none: observations against them
--     keep NULL and are not ledger-eligible. Nothing is back-filled and nothing is invented.
--  E. A read-only view of exactly the eligible rows, for the admin export.
--
-- Site identity is the project's own site_label. Two projects that name one physical site differently are two
-- sites to this database; the independence the ledger requires of sites is only as good as that label.

-- ---------------------------------------------------------------------------
-- A. TRUNCATE guards
-- ---------------------------------------------------------------------------
drop trigger if exists project_observations_no_truncate on public.project_observations;
create trigger project_observations_no_truncate
  before truncate on public.project_observations
  for each statement execute function public.gf_append_only();
drop trigger if exists project_observation_reviews_no_truncate on public.project_observation_reviews;
create trigger project_observation_reviews_no_truncate
  before truncate on public.project_observation_reviews
  for each statement execute function public.gf_append_only();
drop trigger if exists supplier_actuals_no_truncate on public.supplier_actuals;
create trigger supplier_actuals_no_truncate
  before truncate on public.supplier_actuals
  for each statement execute function public.gf_append_only();
drop trigger if exists supplier_actual_reviews_no_truncate on public.supplier_actual_reviews;
create trigger supplier_actual_reviews_no_truncate
  before truncate on public.supplier_actual_reviews
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- D (part). The case revision remembers which engine build produced its answer
-- ---------------------------------------------------------------------------
alter table public.power_deployment_cases add column if not exists engine_provenance jsonb;
comment on column public.power_deployment_cases.engine_provenance is
  'The engine''s /v1/version provenance (digest, report_date, ...) read immediately after the assessment that produced '
  '`result`; `read` is ''bracketed'' when this process had an earlier read of the same build, ''after_only'' otherwise. '
  'NULL for revisions written before 0038, when the engine did not report one, or when the build changed between reads; '
  'never inferred.';

-- Same as 0015's gf_append_case_revision, plus engine_provenance.
create or replace function public.gf_append_case_revision(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.power_deployment_cases; l record; n int := 0;
begin
  insert into public.power_deployment_cases (case_token, revision, email, company,
                                             project_name, request, result, changed_fields, engine_provenance)
  values (p->>'case_token', (p->>'revision')::int, p->>'email', p->>'company',
          p->>'project_name', p->'request', p->'result',
          coalesce(array(select jsonb_array_elements_text(p->'changed_fields')), '{}'),
          case when jsonb_typeof(p->'engine_provenance') = 'object' then p->'engine_provenance' end)
  returning * into r;
  for l in select project_id from public.project_links
           where object_type = 'power_deployment_case' and object_id = r.case_token loop
    perform public.gf_emit(l.project_id, p_event,
        jsonb_build_object('case_token', r.case_token, 'revision', r.revision,
                           'changed_fields', to_jsonb(r.changed_fields)));
    n := n + 1;
  end loop;
  return jsonb_build_object('row', to_jsonb(r), 'events', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- C/D. Columns on observations (all nullable: rows written before this migration stay as they are, ineligible)
-- ---------------------------------------------------------------------------
alter table public.project_observations
  add column if not exists measurement_kind text
    check (measurement_kind in ('metered', 'bms_trend', 'commissioning_record')),
  add column if not exists site_ref text check (site_ref ~ '^site_[0-9a-f]{12}$'),
  add column if not exists engine_provenance_digest text check (engine_provenance_digest ~ '^[0-9a-f]{64}$'),
  add column if not exists report_date date,
  add column if not exists submitted_by_ref text check (submitted_by_ref ~ '^[0-9a-f]{64}$');

-- New rows only (NOT VALID): a MW output is recorded in MW, and values are finite and physical.
alter table public.project_observations drop constraint if exists project_observations_unit_mw;
alter table public.project_observations add constraint project_observations_unit_mw
  check (calibration_key <> 'btm.firm_MW' or unit = 'MW') not valid;
alter table public.project_observations drop constraint if exists project_observations_value_sane;
alter table public.project_observations add constraint project_observations_value_sane
  check (observed_value <> 'NaN'::numeric and predicted_value <> 'NaN'::numeric
         and observed_value < 1e12 and predicted_value < 1e12
         and (calibration_key <> 'btm.firm_MW' or (observed_value > 0 and observed_value <= 10000))) not valid;

alter table public.project_observation_reviews
  add column if not exists evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$');
alter table public.project_observation_reviews drop constraint if exists project_observation_reviews_e5_only;
alter table public.project_observation_reviews add constraint project_observation_reviews_e5_only
  check (evidence_class is null or evidence_class = 'E5') not valid;

alter table public.supplier_actuals
  add column if not exists submitted_by_ref text check (submitted_by_ref ~ '^[0-9a-f]{64}$');
alter table public.supplier_actual_reviews
  add column if not exists evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- Submission: same as 0017 plus kind, site_ref, provenance and submitter reference
-- ---------------------------------------------------------------------------
create or replace function public.gf_submit_observation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_observations; pr public.projects; cs public.power_deployment_cases;
        kind text := p->>'measurement_kind'; site text; dig text; rdate date; label text;
begin
  if p->>'evidence_id' is null then
    raise exception 'an observation needs an attached evidence artifact' using errcode = '23502';
  end if;
  if (p->>'installed_attested')::boolean is not true then
    raise exception 'the installed architecture must be attested' using errcode = '23514';
  end if;
  if kind is not null and kind not in ('metered', 'bms_trend', 'commissioning_record') then
    raise exception 'measurement_kind must be metered, bms_trend or commissioning_record: a quote, an assumption or a simulation is not a measurement'
      using errcode = '23514';
  end if;
  if not exists (
       select 1 from public.project_evidence
       where id = (p->>'evidence_id')::uuid and project_id = (p->>'project_id')::uuid) then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  select * into pr from public.projects where id = (p->>'project_id')::uuid;
  label := lower(regexp_replace(coalesce(pr.site_label, ''), '^\s+|\s+$', '', 'g'));
  site := case when label <> '' then 'site_' || substr(encode(sha256(convert_to(label, 'UTF8')), 'hex'), 1, 12) end;
  select * into cs from public.power_deployment_cases
   where case_token = p->>'case_token' and revision = (p->>'case_revision')::int;
  if found and cs.engine_provenance is not null then
    dig := cs.engine_provenance->>'digest';
    dig := case when dig ~ '^[0-9a-f]{64}$' then dig end;
    rdate := case when cs.engine_provenance->>'report_date' ~ '^\d{4}-\d{2}-\d{2}$'
                  then (cs.engine_provenance->>'report_date')::date end;
  end if;
  insert into public.project_observations (project_id, prediction_ref, case_token, case_revision,
        architecture, calibration_key, unit, predicted_value, predicted_source, observed_value,
        observed_on, method, evidence_id, installed_attested, installed_basis, note,
        submitted_by, submitted_at, measurement_kind, site_ref, engine_provenance_digest, report_date,
        submitted_by_ref)
  values ((p->>'project_id')::uuid, p->>'prediction_ref', p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->>'calibration_key', p->>'unit',
          (p->>'predicted_value')::numeric, p->>'predicted_source', (p->>'observed_value')::numeric,
          (p->>'observed_on')::date, p->>'method', (p->>'evidence_id')::uuid,
          (p->>'installed_attested')::boolean, p->>'installed_basis', p->>'note',
          p->>'submitted_by', coalesce((p->>'submitted_at')::timestamptz, now()),
          kind, site, dig, rdate, p->>'submitted_by_ref')
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('observation_id', r.id, 'prediction_ref', r.prediction_ref,
                         'calibration_key', r.calibration_key, 'installed_attested', r.installed_attested,
                         'evidence_id', r.evidence_id, 'predicted_value', r.predicted_value,
                         'observed_value', r.observed_value, 'delta_pct', r.delta_pct,
                         'measurement_kind', r.measurement_kind));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- Review: not by the submitter, E5 only, verified only against verified evidence
-- ---------------------------------------------------------------------------
create or replace function public.gf_review_observation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare o public.project_observations; r public.project_observation_reviews; ev public.project_evidence;
        who text := lower(btrim(coalesce(p->>'reviewer', '')));
begin
  select * into o from public.project_observations where id = (p->>'observation_id')::uuid;
  if not found then
    raise exception 'no such observation' using errcode = '23503';
  end if;
  if who <> '' and (who = lower(btrim(o.submitted_by)) or who = lower(coalesce(o.submitted_by_ref, ''))) then
    raise exception 'a submission cannot be reviewed by the person who submitted it' using errcode = 'GF001';
  end if;
  select * into ev from public.project_evidence where id = o.evidence_id;
  if p->>'decision' = 'verified' then
    if ev.review_status is distinct from 'verified' then
      raise exception 'the supporting evidence artifact is not verified, so this observation cannot be' using errcode = 'GF002';
    end if;
    if p->>'evidence_class' is distinct from 'E5' then
      raise exception 'a reviewer may assign only E5 to a measured observation (E6 and E7 are computation outputs)' using errcode = 'GF003';
    end if;
  end if;
  insert into public.project_observation_reviews (observation_id, project_id, decision,
        evidence_class, reviewer, reason, reviewed_at, evidence_sha256)
  values (o.id, o.project_id, p->>'decision', p->>'evidence_class', p->>'reviewer', p->>'reason',
          coalesce((p->>'reviewed_at')::timestamptz, now()),
          case when p->>'decision' = 'verified' then ev.sha256 end)
  returning * into r;
  perform public.gf_emit(o.project_id, p_event,
      jsonb_build_object('observation_id', o.id, 'decision', r.decision,
                         'evidence_class', r.evidence_class));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- Supplier actuals: same submitter/evidence rules on review; submitter reference at submission
-- ---------------------------------------------------------------------------
create or replace function public.gf_submit_supplier_actual(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare pk public.procurement_packages; rs public.procurement_responses;
        prev public.supplier_actuals; r public.supplier_actuals; v jsonb;
begin
  select * into pk from public.procurement_packages
   where id = (p->>'package_id')::uuid and project_id = (p->>'project_id')::uuid;
  if not found then
    raise exception 'no such package in this project' using errcode = '23503';
  end if;
  if pk.selected_supplier is null or pk.selected_response_id is null then
    raise exception 'no supplier has been selected for this package' using errcode = '23514';
  end if;
  select * into rs from public.procurement_responses
   where id = pk.selected_response_id and package_id = pk.id;
  if not found then
    raise exception 'the selection does not point at a stored response of this package' using errcode = '23514';
  end if;
  if not exists (select 1 from public.project_evidence
                  where id = (p->>'evidence_id')::uuid and project_id = pk.project_id) then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  if p->>'supersedes_id' is not null then
    select * into prev from public.supplier_actuals
     where id = (p->>'supersedes_id')::uuid and package_id = pk.id;
    if not found then
      raise exception 'no such record to correct on this package' using errcode = '23503';
    end if;
  end if;
  v := coalesce(rs.response->'values', '{}'::jsonb);
  insert into public.supplier_actuals (project_id, package_id, selected_response_id, supplier,
        case_token, case_revision, architecture, quoted_capex_eur, quoted_lead_time_weeks,
        quoted_install_weeks, quoted_snapshot, po_date, dispatch_date, on_site_date,
        install_complete_date, energised_date, actual_cost, actual_cost_currency, cost_scope,
        cost_scope_note, evidence_id, method, submitted_by, submitted_at, supersedes_id, note,
        submitted_by_ref)
  values (pk.project_id, pk.id, rs.id, rs.supplier, pk.case_token, pk.case_revision, pk.architecture,
          case when jsonb_typeof(v->'capex_eur') = 'number' then (v->>'capex_eur')::numeric end,
          case when jsonb_typeof(v->'lead_time_weeks') = 'number' then (v->>'lead_time_weeks')::numeric end,
          case when jsonb_typeof(v->'install_weeks') = 'number' then (v->>'install_weeks')::numeric end,
          v,
          (p->>'po_date')::date, (p->>'dispatch_date')::date, (p->>'on_site_date')::date,
          (p->>'install_complete_date')::date, (p->>'energised_date')::date,
          (p->>'actual_cost')::numeric, p->>'actual_cost_currency', p->>'cost_scope',
          p->>'cost_scope_note', (p->>'evidence_id')::uuid, p->>'method', p->>'submitted_by',
          coalesce((p->>'submitted_at')::timestamptz, now()), prev.id, p->>'note',
          p->>'submitted_by_ref')
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('actual_id', r.id, 'package_id', r.package_id, 'supplier', r.supplier,
                         'selected_response_id', r.selected_response_id,
                         'evidence_id', r.evidence_id, 'supersedes_id', r.supersedes_id));
  return to_jsonb(r);
end;
$$;

create or replace function public.gf_review_supplier_actual(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare a public.supplier_actuals; r public.supplier_actual_reviews; supplied text[]; ev public.project_evidence;
        who text := lower(btrim(coalesce(p->>'reviewer', '')));
begin
  select * into a from public.supplier_actuals where id = (p->>'actual_id')::uuid;
  if not found then
    raise exception 'no such supplier-actual record' using errcode = '23503';
  end if;
  if who <> '' and (who = lower(btrim(a.submitted_by)) or who = lower(coalesce(a.submitted_by_ref, ''))) then
    raise exception 'a submission cannot be reviewed by the person who submitted it' using errcode = 'GF001';
  end if;
  select * into ev from public.project_evidence where id = a.evidence_id;
  if p->>'decision' = 'verified' and ev.review_status is distinct from 'verified' then
    raise exception 'the supporting evidence artifact is not verified, so this record cannot be' using errcode = 'GF002';
  end if;
  supplied := array_remove(array[
      case when a.po_date is not null then 'po_date' end,
      case when a.dispatch_date is not null then 'dispatch_date' end,
      case when a.on_site_date is not null then 'on_site_date' end,
      case when a.install_complete_date is not null then 'install_complete_date' end,
      case when a.energised_date is not null then 'energised_date' end,
      case when a.actual_cost is not null then 'actual_cost' end], null);
  if not (coalesce(array(select jsonb_array_elements_text(coalesce(p->'verified_fields','[]'::jsonb))), '{}')
          <@ supplied) then
    raise exception 'a reviewer can only verify facts the record actually supplies' using errcode = '23514';
  end if;
  insert into public.supplier_actual_reviews (actual_id, project_id, decision, verified_fields,
        reviewer, reason, reviewed_at, evidence_sha256)
  values (a.id, a.project_id, p->>'decision',
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'verified_fields','[]'::jsonb))), '{}'),
          p->>'reviewer', p->>'reason', coalesce((p->>'reviewed_at')::timestamptz, now()),
          case when p->>'decision' = 'verified' then ev.sha256 end)
  returning * into r;
  perform public.gf_emit(a.project_id, p_event,
      jsonb_build_object('actual_id', a.id, 'decision', r.decision,
                         'verified_fields', to_jsonb(r.verified_fields)));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- E. The ledger-eligible rows, and only those. Read by GET /api/admin/calibration-export (service_role).
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
where r.decision = 'verified'
  and r.evidence_class = 'E5'
  and o.measurement_kind in ('metered', 'bms_trend', 'commissioning_record')
  and o.calibration_key = 'btm.firm_MW' and o.unit = 'MW'
  and o.site_ref is not null
  and o.engine_provenance_digest is not null
  and r.evidence_sha256 is not null
  and e.review_status = 'verified' and e.sha256 = r.evidence_sha256
  and lower(btrim(r.reviewer)) <> lower(btrim(o.submitted_by));

-- ---------------------------------------------------------------------------
-- Privileges, per 0020: the gf_* functions are service_role-only; the view is readable by service_role alone.
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
