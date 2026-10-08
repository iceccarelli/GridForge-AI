-- 0017_project_observations.sql — the first typed path from a prediction to observed reality
--
--   prediction (a stored engine result) -> observation submitted -> human review -> (a person)
--   adds it to the calibration ledger
--
-- Nothing here writes to the calibration ledger and nothing here moves an evidence class:
--   * The PREDICTED value is read by the server from the stored engine result of an exact
--     (case_token, revision, architecture); a caller supplies the observation, never the prediction.
--   * An observation is an immutable SUBMISSION. Whether it is trustworthy is a separate,
--     immutable, human REVIEW that assigns the evidence class. A submission has none.
--   * The ledger (gridforge/calibration) stays a file a person appends to through the existing
--     `gridforge calibrate add`, which itself refuses anything below E5. Observation count there
--     is unchanged by this migration.
--
-- Only `btm.firm_MW` is reconcilable: it is the engine's own contingency result. An architecture's
-- capex and lead time are echoes of what the customer declared, so they are not model predictions.

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached', 'observation_submitted', 'observation_reviewed'));

create table if not exists public.project_observations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  -- Exactly what was predicted: 'power_deployment_case:<case_token>:r<revision>:<architecture>'.
  prediction_ref text not null,
  case_token text not null,
  case_revision int not null,
  architecture text not null,
  calibration_key text not null check (calibration_key in ('btm.firm_MW')),
  unit text not null,
  -- Read from the engine result at that revision (revisions are immutable); never user-supplied.
  predicted_value numeric not null check (predicted_value > 0),
  predicted_source text not null,
  observed_value numeric not null check (observed_value >= 0),
  observed_on date not null,
  -- How it was measured: required, because an observation nobody can trace is not evidence.
  method text not null check (length(btrim(method)) > 0),
  -- The artifact the measurement came from. Required to VERIFY (checked in gf_review_observation).
  evidence_id uuid references public.project_evidence (id),
  note text,
  submitted_by text not null check (length(btrim(submitted_by)) > 0),
  submitted_at timestamptz not null default now(),
  delta_value numeric generated always as (observed_value - predicted_value) stored,
  delta_pct numeric generated always as ((observed_value / predicted_value - 1) * 100) stored,
  check (prediction_ref = 'power_deployment_case:' || case_token || ':r' || case_revision
                          || ':' || architecture),
  -- One observation of one prediction per day: counted twice, it would understate the spread.
  unique (project_id, prediction_ref, calibration_key, observed_on)
);

create index if not exists project_observations_project_idx
  on public.project_observations (project_id, submitted_at);

create table if not exists public.project_observation_reviews (
  id uuid primary key default gen_random_uuid(),
  -- One review per observation, ever: a decision is not flipped, a new observation is submitted.
  observation_id uuid not null unique references public.project_observations (id),
  project_id uuid not null references public.projects (id),
  decision text not null check (decision in ('verified', 'rejected')),
  -- Assigned by the reviewer, never inferred. Null exactly when rejected.
  evidence_class text check (evidence_class in ('E0','E1','E2','E3','E4','E5','E6','E7')),
  reviewer text not null check (length(btrim(reviewer)) > 0),
  reason text,
  reviewed_at timestamptz not null default now(),
  check ((decision = 'verified') = (evidence_class is not null))
);

drop trigger if exists project_observations_append_only on public.project_observations;
create trigger project_observations_append_only
  before update or delete on public.project_observations
  for each row execute function public.gf_append_only();

drop trigger if exists project_observation_reviews_append_only on public.project_observation_reviews;
create trigger project_observation_reviews_append_only
  before update or delete on public.project_observation_reviews
  for each row execute function public.gf_append_only();

alter table public.project_observations enable row level security;
alter table public.project_observation_reviews enable row level security;

-- A submission and its history event, one transaction. The evidence, if given, must be this
-- project's own.
create or replace function public.gf_submit_observation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_observations;
begin
  if p->>'evidence_id' is not null and not exists (
       select 1 from public.project_evidence
       where id = (p->>'evidence_id')::uuid and project_id = (p->>'project_id')::uuid) then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  insert into public.project_observations (project_id, prediction_ref, case_token, case_revision,
        architecture, calibration_key, unit, predicted_value, predicted_source, observed_value,
        observed_on, method, evidence_id, note, submitted_by, submitted_at)
  values ((p->>'project_id')::uuid, p->>'prediction_ref', p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->>'calibration_key', p->>'unit',
          (p->>'predicted_value')::numeric, p->>'predicted_source', (p->>'observed_value')::numeric,
          (p->>'observed_on')::date, p->>'method', (p->>'evidence_id')::uuid, p->>'note',
          p->>'submitted_by', coalesce((p->>'submitted_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('observation_id', r.id, 'prediction_ref', r.prediction_ref,
                         'calibration_key', r.calibration_key, 'predicted_value', r.predicted_value,
                         'observed_value', r.observed_value, 'delta_pct', r.delta_pct));
  return to_jsonb(r);
end;
$$;

-- A human decision on a submission, and its history event, one transaction. Verifying requires
-- an evidence artifact: a measured value with no source file cannot be verified.
create or replace function public.gf_review_observation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare o public.project_observations; r public.project_observation_reviews;
begin
  select * into o from public.project_observations where id = (p->>'observation_id')::uuid;
  if not found then
    raise exception 'no such observation' using errcode = '23503';
  end if;
  if p->>'decision' = 'verified' and o.evidence_id is null then
    raise exception 'an observation with no evidence artifact cannot be verified'
      using errcode = '23514';
  end if;
  insert into public.project_observation_reviews (observation_id, project_id, decision,
        evidence_class, reviewer, reason, reviewed_at)
  values (o.id, o.project_id, p->>'decision', p->>'evidence_class', p->>'reviewer', p->>'reason',
          coalesce((p->>'reviewed_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(o.project_id, p_event,
      jsonb_build_object('observation_id', o.id, 'decision', r.decision,
                         'evidence_class', r.evidence_class));
  return to_jsonb(r);
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.gf_submit_observation(jsonb, jsonb) from public;
    grant execute on function public.gf_submit_observation(jsonb, jsonb) to service_role;
    revoke all on function public.gf_review_observation(jsonb, jsonb) from public;
    grant execute on function public.gf_review_observation(jsonb, jsonb) to service_role;
  end if;
end
$$;
