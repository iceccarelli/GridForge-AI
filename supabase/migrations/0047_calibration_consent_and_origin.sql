-- 0047_calibration_consent_and_origin.sql: an observation reaches the shared calibration ledger only if the project's owner agreed to it
-- and the data is real.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Until it is applied the admin route that records a
-- permission answers 503 ("not available"); the observation route still sends a data origin, which 0038's gf_submit_observation ignores
-- (it reads only the keys it knows), so submissions keep working and are simply unclassified; and the export view keeps its 0046 definition,
-- so nothing stops working and nothing newly exports.
--
-- Why. calibration_ledger_rows (0038) feeds GET /api/admin/calibration-export, and `gridforge calibrate import` imports every row the
-- export returns with published=True, unconditionally. Nothing recorded whether the owner of a project had agreed to its measurements
-- being shared into a ledger that is published, and nothing said whether an observation came from a real deployment or from a demo, a
-- test or a generator. The importer trusts the view, so the VIEW is the single gate; this migration puts both conditions in it.
--
--   A. calibration_permissions: an append-only log of consent. One row per decision: kind 'granted' or 'revoked'; a revocation is a NEW
--      row, nothing is ever updated or deleted or truncated. scope_type is 'project' for now (scope_id is the project's id). Each row
--      names the e-mail address of the person who gave or withdrew the permission, the SHA-256 of the signed document that evidences it
--      (a revocation names its own document), when it was recorded and a note. The latest row (highest seq: a clock can repeat inside one
--      transaction, a sequence cannot) is the standing decision. A revocation needs a standing grant to revoke. The address is the
--      customer's, typed by an administrator who recorded a document the administrator holds: it is a record, not an authentication.
--   B. gf_record_calibration_permission(p, p_event): the only supported writer; service_role only (0020's pattern). The history event
--      carries the document digest and the kind, never the e-mail address.
--   C. project_observations.data_origin: 'production', 'test', 'synthetic' or 'unclassified' (NOT NULL, default 'unclassified'). A row
--      that nobody classified is never treated as production. Observations are append-only, so the origin is set once, at submission,
--      by the server (lib/project-observations.ts: production only on a production deployment); a caller's request body is never read
--      for it. Rows stored before this migration are 'unclassified' and are therefore not exported: nothing is back-filled and nothing
--      is invented. Adding a NOT NULL column with a constant default is a catalogue change in PostgreSQL 11+, not a table rewrite.
--   D. calibration_ledger_rows: every 0046 condition, plus data_origin = 'production' and a project whose LATEST permission row is a
--      grant. Every column, the column order and the privileges are unchanged.
--
-- Additive and idempotent. RLS on, no policies (service role only), like every table that holds a customer's material.

-- ---------------------------------------------------------------------------
-- The history gains one event type: the list as it stands (whatever earlier migrations made it) plus this one, so replaying or reordering
-- migrations never drops a type that rows already use
-- ---------------------------------------------------------------------------
do $$
declare cur text; have text[]; want text[] := array['calibration_permission_recorded'];
        base text[] := array['project_created', 'btm_case_attached', 'btm_case_revised', 'rfq_generated', 'supplier_response_received',
          'comparison_completed', 'supplier_selected', 'evidence_attached', 'paid_product_attached', 'observation_submitted',
          'observation_reviewed', 'supplier_actual_submitted', 'supplier_actual_reviewed', 'cost_evidence_received', 'cost_evidence_reviewed',
          'cost_evidence_retired', 'cost_evidence_run', 'comparison_saved', 'share_issued', 'share_revoked'];
begin
  select pg_get_constraintdef(c.oid) into cur from pg_constraint c
   where c.conrelid = 'public.project_events'::regclass and c.conname = 'project_events_event_type_check';
  select coalesce(array_agg(distinct m[1]), '{}') into have from regexp_matches(coalesce(cur, ''), '''([a-z_]+)''', 'g') as m;
  alter table public.project_events drop constraint if exists project_events_event_type_check;
  execute 'alter table public.project_events add constraint project_events_event_type_check check (event_type in ('
    || (select string_agg(quote_literal(x), ', ' order by x) from (select distinct unnest(base || have || want) as x) u) || '))';
end
$$;


-- ---------------------------------------------------------------------------
-- A. The consent log
-- ---------------------------------------------------------------------------
create table if not exists public.calibration_permissions (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  scope_type text not null check (scope_type in ('project')),
  scope_id uuid not null,
  kind text not null check (kind in ('granted', 'revoked')),
  granted_by_email text not null
    check (length(granted_by_email) between 3 and 254 and granted_by_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  granted_at timestamptz not null default now(),
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  note text check (note is null or length(note) <= 1000)
);

create index if not exists calibration_permissions_scope_idx
  on public.calibration_permissions (scope_type, scope_id, seq desc);

create or replace function public.gf_calibration_permission_guard() returns trigger
language plpgsql as $$
declare latest text;
begin
  if new.scope_type = 'project' and not exists (select 1 from public.projects where id = new.scope_id) then
    raise exception 'no such project' using errcode = '23503';
  end if;
  if new.kind = 'revoked' then
    select p.kind into latest from public.calibration_permissions p
     where p.scope_type = new.scope_type and p.scope_id = new.scope_id
     order by p.seq desc limit 1;
    if latest is distinct from 'granted' then
      raise exception 'there is nothing to revoke: no standing permission exists for this scope' using errcode = 'GF006';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists calibration_permissions_guard on public.calibration_permissions;
create trigger calibration_permissions_guard
  before insert on public.calibration_permissions
  for each row execute function public.gf_calibration_permission_guard();

drop trigger if exists calibration_permissions_append_only on public.calibration_permissions;
create trigger calibration_permissions_append_only
  before update or delete on public.calibration_permissions
  for each row execute function public.gf_append_only();
drop trigger if exists calibration_permissions_no_truncate on public.calibration_permissions;
create trigger calibration_permissions_no_truncate
  before truncate on public.calibration_permissions
  for each statement execute function public.gf_append_only();

alter table public.calibration_permissions enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- B. The writer
-- ---------------------------------------------------------------------------
create or replace function public.gf_record_calibration_permission(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.calibration_permissions;
begin
  insert into public.calibration_permissions (scope_type, scope_id, kind, granted_by_email, document_sha256, note)
  values (p->>'scope_type', (p->>'scope_id')::uuid, p->>'kind', lower(btrim(p->>'granted_by_email')),
          p->>'document_sha256', nullif(btrim(coalesce(p->>'note', '')), ''))
  returning * into r;
  perform public.gf_emit(r.scope_id, p_event,
      jsonb_build_object('permission_id', r.id, 'kind', r.kind, 'document_sha256', r.document_sha256));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- C. Data origin
-- ---------------------------------------------------------------------------
alter table public.project_observations
  add column if not exists data_origin text not null default 'unclassified'
    check (data_origin in ('production', 'test', 'synthetic', 'unclassified'));
comment on column public.project_observations.data_origin is
  'Where the data came from, set once at submission by the server: production (a real deployment), test, synthetic, or unclassified '
  '(not stated; the default). Only production reaches calibration_ledger_rows. Rows written before migration 0047 are unclassified.';

-- Same as 0038's gf_submit_observation, plus data_origin (absent means unclassified, never production).
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
        submitted_by_ref, data_origin)
  values ((p->>'project_id')::uuid, p->>'prediction_ref', p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->>'calibration_key', p->>'unit',
          (p->>'predicted_value')::numeric, p->>'predicted_source', (p->>'observed_value')::numeric,
          (p->>'observed_on')::date, p->>'method', (p->>'evidence_id')::uuid,
          (p->>'installed_attested')::boolean, p->>'installed_basis', p->>'note',
          p->>'submitted_by', coalesce((p->>'submitted_at')::timestamptz, now()),
          kind, site, dig, rdate, p->>'submitted_by_ref',
          coalesce(p->>'data_origin', 'unclassified'))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('observation_id', r.id, 'prediction_ref', r.prediction_ref,
                         'calibration_key', r.calibration_key, 'installed_attested', r.installed_attested,
                         'evidence_id', r.evidence_id, 'predicted_value', r.predicted_value,
                         'observed_value', r.observed_value, 'delta_pct', r.delta_pct,
                         'measurement_kind', r.measurement_kind, 'data_origin', r.data_origin));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- D. The ledger-eligible rows: 0046's conditions, plus production origin and a standing permission
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
  and o.data_origin = 'production'
  and exists (
    select 1 from public.calibration_permissions cp
    where cp.scope_type = 'project' and cp.scope_id = o.project_id and cp.kind = 'granted'
      and cp.seq = (select max(c2.seq) from public.calibration_permissions c2
                    where c2.scope_type = 'project' and c2.scope_id = o.project_id));

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
  revoke all on public.calibration_permissions from public;
  revoke all on public.calibration_ledger_rows from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.calibration_permissions from %I', r);
      execute format('revoke all on public.calibration_ledger_rows from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.calibration_permissions to service_role;
    grant select on public.calibration_ledger_rows to service_role;
  end if;
end
$$;
