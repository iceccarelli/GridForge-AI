-- 0023_cost_evidence_artifacts.sql — a hash is not an artifact: a cost-evidence run now owns its exact bytes
--
-- 0022 recorded `document_sha256` for a run but never kept the document, and keyed idempotency on
-- (engagement, intake digest, digest of the evidence the engine REPORTED USING). That is not a fingerprint of the
-- effective inputs: an engine or cost-library revision, or an accepted line the engine ignored, could not make a
-- distinct run, and a retry was answered with freshly generated content under an old record's hash.
--
-- This migration is forward-only and additive. Every 0022 run row is kept exactly as it was:
--   * `evidence_ids` keeps meaning "evidence the engine actually USED". The accepted snapshot is new columns.
--   * A historical run has `run_fingerprint IS NULL`: it is a LEGACY run, it has no artifact, and it stays that way.
--     No artifact reference, fingerprint or document is fabricated for it.
--   * A run recorded from now on (`run_fingerprint IS NOT NULL`) must carry the complete identity and the complete
--     artifact metadata, or the database refuses the row.
--   * One authoritative run per (engagement, run fingerprint) is a UNIQUE constraint, not an application check. The
--     recording function reports the existing row when the identity is already recorded and never replaces it.
--   * The bytes live in a PRIVATE storage bucket; the row holds the reference, SHA-256, byte length and media type.
--     Run rows stay append-only (the 0022 trigger is untouched). Nothing is public; RLS stays service-role only.

alter table public.cost_evidence_runs
  add column if not exists identity_version text,
  add column if not exists run_fingerprint text,
  -- The cleaned intake the engine was given, and the digest the fingerprint used.
  add column if not exists intake_snapshot jsonb,
  -- Every accepted line handed to the engine (including any it then ignored), and its digest.
  add column if not exists accepted_snapshot jsonb,
  add column if not exists accepted_snapshot_digest text,
  add column if not exists accepted_evidence_ids uuid[],
  -- What produced the document: engine build + cost library + calibration digests, and the digest of those.
  add column if not exists engine_provenance jsonb,
  add column if not exists engine_fingerprint text,
  -- The request options that shape the output (endpoint, format ...).
  add column if not exists request_options jsonb,
  -- The date printed on the document. Recorded, but NOT part of the identity.
  add column if not exists report_date date,
  add column if not exists artifact_storage_ref text,
  add column if not exists artifact_sha256 text,
  add column if not exists artifact_bytes bigint,
  add column if not exists artifact_media_type text;

-- A CHECK passes when its expression is NULL, so every comparison below is wrapped: a missing value must FAIL the check.
alter table public.cost_evidence_runs
  add constraint cost_evidence_runs_identity_shape check (
    run_fingerprint is null or (
      coalesce(run_fingerprint ~ '^[0-9a-f]{64}$', false)
      and identity_version is not null
      and coalesce(jsonb_typeof(intake_snapshot) = 'object', false)      -- a JSON null is not SQL NULL: require the type
      and coalesce(jsonb_typeof(accepted_snapshot) = 'array', false)
      and coalesce(accepted_snapshot_digest ~ '^[0-9a-f]{64}$', false)
      and coalesce(cardinality(accepted_evidence_ids) > 0, false)
      and coalesce(evidence_ids <@ accepted_evidence_ids, false)   -- used is a subset of accepted, and can be a strict one
      and coalesce(jsonb_typeof(engine_provenance) = 'object', false)
      and coalesce(engine_fingerprint ~ '^[0-9a-f]{64}$', false)
      and coalesce(jsonb_typeof(request_options) = 'object', false)
      and report_date is not null
      and coalesce(length(artifact_storage_ref) > 0, false)
      and coalesce(artifact_sha256 ~ '^[0-9a-f]{64}$', false)
      and coalesce(artifact_sha256 = document_sha256, false)
      and coalesce(artifact_bytes > 0, false)
      and coalesce(length(artifact_media_type) > 0, false)
    )
  ),
  -- A legacy run has no artifact and no new identity columns at all: nothing half-filled passes as either kind.
  add constraint cost_evidence_runs_legacy_has_no_artifact check (
    run_fingerprint is not null or (
      identity_version is null and intake_snapshot is null and accepted_snapshot is null
      and accepted_snapshot_digest is null and accepted_evidence_ids is null and engine_provenance is null
      and engine_fingerprint is null and request_options is null and report_date is null
      and artifact_storage_ref is null and artifact_sha256 is null and artifact_bytes is null
      and artifact_media_type is null
    )
  );

-- The 0022 uniqueness (engagement, intake, USED-evidence digest) cannot stay: a changed engine or an extra accepted line
-- the engine ignored must be able to create a genuinely distinct run. Dropping the constraint rewrites no row; every
-- historical run keeps its (deliverable, intake, evidence) values and stays unique among themselves.
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.cost_evidence_runs'::regclass and con.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
             where a.attrelid = con.conrelid and a.attnum = any (con.conkey))
           = array['deliverable_id', 'evidence_digest', 'intake_digest']
  loop
    execute format('alter table public.cost_evidence_runs drop constraint %I', c);
  end loop;
end
$$;

create unique index if not exists cost_evidence_runs_fingerprint_uq
  on public.cost_evidence_runs (deliverable_id, run_fingerprint) where run_fingerprint is not null;
create unique index if not exists cost_evidence_runs_artifact_ref_uq
  on public.cost_evidence_runs (artifact_storage_ref) where artifact_storage_ref is not null;
-- Legacy rows stay one-per-(engagement, intake, used evidence), as 0022 promised.
create unique index if not exists cost_evidence_runs_legacy_uq
  on public.cost_evidence_runs (deliverable_id, intake_digest, evidence_digest) where run_fingerprint is null;
create index if not exists cost_evidence_runs_history_idx
  on public.cost_evidence_runs (deliverable_id, created_at desc, id);

-- Record a run, once per identity. The row is the authority: when the identity already exists the EXISTING row is
-- returned untouched (created = false), whatever this call's candidate artifact was, and no second project event is
-- written. Two concurrent callers serialise on the unique index; the loser sees the winner's committed row.
create or replace function public.gf_record_cost_evidence_run(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.cost_evidence_runs; proj uuid;
begin
  if coalesce(p->>'run_fingerprint', '') = '' then
    raise exception 'a run must carry its run_fingerprint and artifact metadata' using errcode = '23514';
  end if;
  select pl.project_id into proj from public.project_links pl
   where pl.object_type = 'deliverable' and pl.object_id = (p->>'deliverable_id');
  insert into public.cost_evidence_runs (
        deliverable_id, project_id, intake_digest, evidence_digest, evidence_ids, effect, ignored, document_sha256,
        identity_version, run_fingerprint, intake_snapshot, accepted_snapshot, accepted_snapshot_digest,
        accepted_evidence_ids, engine_provenance, engine_fingerprint, request_options, report_date,
        artifact_storage_ref, artifact_sha256, artifact_bytes, artifact_media_type)
  values ((p->>'deliverable_id')::uuid, proj, p->>'intake_digest', p->>'evidence_digest',
          (select array_agg(x::uuid) from jsonb_array_elements_text(p->'evidence_ids') x),
          p->'effect', coalesce(p->'ignored', '[]'::jsonb), p->>'document_sha256',
          p->>'identity_version', p->>'run_fingerprint', p->'intake_snapshot', p->'accepted_snapshot',
          p->>'accepted_snapshot_digest',
          (select array_agg(x::uuid) from jsonb_array_elements_text(p->'accepted_evidence_ids') x),
          p->'engine_provenance', p->>'engine_fingerprint', p->'request_options', (p->>'report_date')::date,
          p->>'artifact_storage_ref', p->>'artifact_sha256', (p->>'artifact_bytes')::bigint, p->>'artifact_media_type')
  on conflict (deliverable_id, run_fingerprint) where run_fingerprint is not null do nothing
  returning * into r;
  if found then
    if proj is not null then
      perform public.gf_emit(proj, p_event, jsonb_build_object('run_id', r.id, 'evidence_ids', to_jsonb(r.evidence_ids),
             'accepted_evidence_ids', to_jsonb(r.accepted_evidence_ids), 'run_fingerprint', r.run_fingerprint,
             'artifact_sha256', r.artifact_sha256));
    end if;
    return jsonb_build_object('created', true, 'run', to_jsonb(r));
  end if;
  select * into r from public.cost_evidence_runs
   where deliverable_id = (p->>'deliverable_id')::uuid and run_fingerprint = p->>'run_fingerprint';
  return jsonb_build_object('created', false, 'run', to_jsonb(r));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.gf_record_cost_evidence_run(jsonb, jsonb) from public;
    grant execute on function public.gf_record_cost_evidence_run(jsonb, jsonb) to service_role;
  end if;
end
$$;

-- The administrator's review screen must show why and by whom evidence was retired. 0022's view carried the retirement
-- KIND and the superseding line but not the reason or the person. Columns are only APPENDED, so every existing column
-- keeps its name, type and position (and the view's grants are kept by CREATE OR REPLACE).
create or replace view public.cost_evidence_state with (security_invoker = true) as
select e.*,
       r.decision, r.basis as reviewed_basis, r.comparability as reviewed_comparability, r.includes_keys,
       r.region as reviewed_region, r.reviewer, r.reviewed_at, r.reason as review_reason,
       t.kind as retired_kind, t.superseded_by, t.retired_at,
       case when t.evidence_id is not null then t.kind
            when r.decision = 'accepted' then 'accepted'
            when r.decision = 'rejected' then 'rejected'
            when e.validation_status = 'validated' then 'validated'
            else 'invalid' end as state,
       t.reason as retirement_reason, t.retired_by
from public.cost_evidence e
left join public.cost_evidence_reviews r on r.evidence_id = e.id
left join public.cost_evidence_retirements t on t.evidence_id = e.id;

-- Generated artifacts hold a customer's engineering result and their supplier quotations: one PRIVATE bucket, never
-- public, read only through the site's token-checked route with the service role. Skipped where Supabase Storage is
-- not installed (a plain Postgres used for migration checks), exactly as 0015 does for project evidence.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('cost-evidence-artifacts', 'cost-evidence-artifacts', false)
    on conflict (id) do nothing;
  end if;
end
$$;
