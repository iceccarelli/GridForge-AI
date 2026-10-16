-- 0024_project_comparisons.sql — a Time-to-Power scenario comparison saved to its Verified Power Record
--
-- POST /v1/compare (gridforge/api/compare_payload.py) answers a question about one hall; until now the answer lived
-- only in the browser tab that asked it. This lets a customer keep one on their project: the exact request the engine
-- was given, the exact answer it returned, and the engine's own provenance, as ONE immutable record beside the
-- project's other evidence, with its `comparison_saved` event written in the same transaction (gf_emit, as every other
-- project write).
--
-- What this is NOT: a second engine, a recomputation, a price, a product or a document. The row is the engine's
-- answer verbatim. Reading a saved comparison reads the row; nothing re-solves. The same shape as
-- procurement_comparisons above it: append-only by trigger, service-role only, RLS on with no policies.
--
-- Idempotency is the database's, not the application's:
--   * (project_id, idempotency_key)   one save per key. A retry with the same key and the same answer returns the
--                                     existing row and writes nothing; the same key with a DIFFERENT answer is refused.
--   * (project_id, result_digest)     the same answer saved twice under different keys is one record, not two.
--   A changed input or a changed engine gives a different result_digest and therefore a NEW record; the earlier one is
--   never touched. There is no update path at all.
--
-- Forward-only and additive: no existing row, column or function changes.

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached', 'observation_submitted', 'observation_reviewed',
                        'supplier_actual_submitted', 'supplier_actual_reviewed',
                        'cost_evidence_received', 'cost_evidence_reviewed', 'cost_evidence_retired',
                        'cost_evidence_run', 'comparison_saved'));

create table if not exists public.project_comparisons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  -- The response schema the row was written against. A reader that does not know the version must not guess at it.
  schema text not null check (schema ~ '^gridforge/ttp-compare/[0-9]+$'),
  -- The body POST /v1/compare was given (intake, objective, scenarios, baseline): what reproduces the answer.
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  -- The engine's own digest of that question (compare_payload.request_digest).
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  -- The engine's answer, verbatim, provenance block included.
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  -- sha256 of the canonical answer WITHOUT its provenance block (the provenance carries the report date, which is not
  -- part of what was answered). Identical inputs on an identical engine give an identical digest.
  result_digest text not null check (result_digest ~ '^[0-9a-f]{64}$'),
  -- gridforge/provenance/1: engine version, code / cost-library / calibration digests, and their digest.
  engine_provenance jsonb not null check (jsonb_typeof(engine_provenance) = 'object'),
  provenance_digest text not null check (provenance_digest ~ '^[0-9a-f]{64}$'),
  objective text not null check (objective in ('max_compute', 'min_cost', 'fastest')),
  baseline text not null,
  grade text not null check (grade in ('indicative', 'screening')),
  scenario_ids jsonb not null check (jsonb_typeof(scenario_ids) = 'array' and jsonb_array_length(scenario_ids) >= 2),
  -- The customer's own short label, if they gave one. Never derived.
  label text check (label is null or length(label) between 1 and 120),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  actor text not null,
  created_at timestamptz not null default now(),
  constraint project_comparisons_one_per_key unique (project_id, idempotency_key),
  constraint project_comparisons_one_per_answer unique (project_id, result_digest)
);

create index if not exists project_comparisons_project_idx
  on public.project_comparisons (project_id, created_at desc);

alter table public.project_comparisons enable row level security;

drop trigger if exists project_comparisons_append_only on public.project_comparisons;
create trigger project_comparisons_append_only
  before update or delete on public.project_comparisons
  for each row execute function public.gf_append_only();

-- The one write path. Returns
--   {created:true,  comparison:{...}}                      a new record and its event, together;
--   {created:false, reason:'idempotent_replay', ...}       the same key with the same answer: nothing written;
--   {created:false, reason:'already_saved', ...}           the same answer under another key: nothing written;
-- and raises unique_violation (23505, constraint project_comparisons_idempotency_conflict) when the key was already
-- used for a DIFFERENT answer, so a retry can never bind an earlier operation to new data.
create or replace function public.gf_save_comparison(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_comparisons; existing public.project_comparisons; proj uuid := (p->>'project_id')::uuid;
begin
  if coalesce(p->>'idempotency_key', '') = '' then
    raise exception 'a saved comparison needs an idempotency_key' using errcode = '23514';
  end if;
  insert into public.project_comparisons (project_id, schema, request, request_digest, result, result_digest,
        engine_provenance, provenance_digest, objective, baseline, grade, scenario_ids, label, idempotency_key,
        actor, created_at)
  values (proj, p->>'schema', p->'request', p->>'request_digest', p->'result', p->>'result_digest',
          p->'engine_provenance', p->>'provenance_digest', p->>'objective', p->>'baseline', p->>'grade',
          p->'scenario_ids', nullif(p->>'label', ''), p->>'idempotency_key', p->>'actor',
          coalesce((p->>'created_at')::timestamptz, now()))
  on conflict do nothing
  returning * into r;
  if found then
    perform public.gf_emit(proj, p_event, jsonb_build_object(
      'comparison_id', r.id, 'request_digest', r.request_digest, 'result_digest', r.result_digest,
      'provenance_digest', r.provenance_digest, 'objective', r.objective, 'grade', r.grade,
      'scenario_ids', r.scenario_ids));
    return jsonb_build_object('created', true, 'comparison', to_jsonb(r));
  end if;
  -- Nothing was inserted: one of the two unique constraints already holds a row. Which one decides the answer.
  select * into existing from public.project_comparisons
   where project_id = proj and idempotency_key = p->>'idempotency_key';
  if found then
    if existing.result_digest = p->>'result_digest' and existing.request_digest = p->>'request_digest' then
      return jsonb_build_object('created', false, 'reason', 'idempotent_replay', 'comparison', to_jsonb(existing));
    end if;
    raise exception 'idempotency key already used for a different comparison on this project'
      using errcode = '23505', constraint = 'project_comparisons_idempotency_conflict';
  end if;
  select * into existing from public.project_comparisons
   where project_id = proj and result_digest = p->>'result_digest';
  return jsonb_build_object('created', false, 'reason', 'already_saved', 'comparison', to_jsonb(existing));
end;
$$;

do $$
begin
  revoke all on function public.gf_save_comparison(jsonb, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_save_comparison(jsonb, jsonb) to service_role;
  end if;
end
$$;
