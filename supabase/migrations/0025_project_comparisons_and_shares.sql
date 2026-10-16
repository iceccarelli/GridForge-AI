-- 0025_project_comparisons_and_shares.sql — a saved Time-to-Power comparison, and the link a buyer opens
--
-- Two additions to the project record (0015), nothing else moves:
--
--   project_comparisons  the engine's answer to a comparison, stored exactly as returned together with the request
--                        that produced it. Append-only: a comparison is evidence of what was decided on, so it is
--                        never edited. Saving the same request against the same engine build twice is a no-op.
--   project_shares       the read-only link that lets someone without the project token (a CFO, a utility contact)
--                        see the decision. Only the SHA-256 of the link's secret is stored, so a database reader
--                        cannot open a buyer page, and the link cannot be re-displayed, only replaced or revoked.
--                        A project has at most one active link; issuing a new one retires the old one in the same
--                        transaction.
--
-- Nothing here prices anything, adds a product or touches an entitlement: the buyer page commissions through the
-- existing checkout, and the purchase attaches through the existing webhook (0016).

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached', 'observation_submitted', 'observation_reviewed',
                        'supplier_actual_submitted', 'supplier_actual_reviewed',
                        'cost_evidence_received', 'cost_evidence_reviewed', 'cost_evidence_retired',
                        'cost_evidence_run',
                        'comparison_saved', 'share_issued', 'share_revoked'));

-- ---------------------------------------------------------------------------
-- A. project_comparisons
-- ---------------------------------------------------------------------------
create table if not exists public.project_comparisons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  -- The body POSTed to /v1/compare: re-running it reproduces the result.
  request jsonb not null,
  -- The engine's answer, verbatim. The site never recomputes or edits a figure in it.
  result jsonb not null check (octet_length(result::text) <= 1048576),
  schema text not null check (length(btrim(schema)) > 0),
  request_digest text not null check (length(btrim(request_digest)) > 0),
  provenance_digest text not null check (length(btrim(provenance_digest)) > 0),
  engine_version text not null check (length(btrim(engine_version)) > 0),
  grade text not null check (grade in ('indicative', 'screening')),
  saved_at timestamptz not null default now(),
  unique (project_id, request_digest, provenance_digest)
);

create index if not exists project_comparisons_project_idx
  on public.project_comparisons (project_id, saved_at desc);

drop trigger if exists project_comparisons_append_only on public.project_comparisons;
create trigger project_comparisons_append_only
  before update or delete on public.project_comparisons
  for each row execute function public.gf_append_only();
-- Row triggers do not fire on TRUNCATE; this closes that door for the evidence table.
drop trigger if exists project_comparisons_no_truncate on public.project_comparisons;
create trigger project_comparisons_no_truncate
  before truncate on public.project_comparisons
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- B. project_shares
-- ---------------------------------------------------------------------------
create table if not exists public.project_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists project_shares_one_active
  on public.project_shares (project_id) where revoked_at is null;

-- A link is created, then at most once revoked. Nothing else about it changes and it is never deleted.
create or replace function public.gf_share_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'project_shares is append-only: DELETE is not permitted' using errcode = '42501';
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked share link stays revoked' using errcode = '42501';
  end if;
  if new.revoked_at is null
     or (to_jsonb(new) - 'revoked_at') <> (to_jsonb(old) - 'revoked_at') then
    raise exception 'a share link can only be revoked' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists project_shares_guard on public.project_shares;
create trigger project_shares_guard
  before update or delete on public.project_shares
  for each row execute function public.gf_share_guard();
drop trigger if exists project_shares_no_truncate on public.project_shares;
create trigger project_shares_no_truncate
  before truncate on public.project_shares
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- C. Atomic writes (record and history event in one transaction, as in 0015)
-- ---------------------------------------------------------------------------

-- Save one comparison. With p_new_project the project is created in the same transaction, so a failure leaves
-- neither a project nor a comparison. Saving an identical comparison again returns {created:false} and writes nothing.
create or replace function public.gf_save_comparison(p jsonb, p_event jsonb,
                                                     p_new_project jsonb default null,
                                                     p_new_event jsonb default null) returns jsonb
language plpgsql as $$
declare pid uuid; r public.project_comparisons;
begin
  if p_new_project is not null then
    pid := (public.gf_create_project(p_new_project, p_new_event)->>'id')::uuid;
  else
    pid := (p->>'project_id')::uuid;
  end if;

  insert into public.project_comparisons (project_id, request, result, schema, request_digest,
                                          provenance_digest, engine_version, grade, saved_at)
  values (pid, p->'request', p->'result', p->>'schema', p->>'request_digest',
          p->>'provenance_digest', p->>'engine_version', p->>'grade',
          coalesce((p->>'saved_at')::timestamptz, now()))
  on conflict (project_id, request_digest, provenance_digest) do nothing
  returning * into r;

  if not found then
    select * into r from public.project_comparisons
     where project_id = pid and request_digest = p->>'request_digest'
       and provenance_digest = p->>'provenance_digest';
    return jsonb_build_object('created', false, 'project_id', pid, 'comparison_id', r.id);
  end if;

  perform public.gf_emit(pid, p_event, jsonb_build_object('comparison_id', r.id));
  return jsonb_build_object('created', true, 'project_id', pid, 'comparison_id', r.id);
end;
$$;

-- Issue the project's buyer link, retiring the previous one in the same transaction. The project row is locked so two
-- concurrent issues serialise instead of one losing to the unique index.
create or replace function public.gf_issue_share(p_project uuid, p_token_hash text, p_event jsonb) returns jsonb
language plpgsql as $$
declare replaced int; r public.project_shares;
begin
  perform 1 from public.projects where id = p_project for update;
  if not found then
    raise exception 'no such project' using errcode = '23503';
  end if;
  update public.project_shares set revoked_at = now() where project_id = p_project and revoked_at is null;
  get diagnostics replaced = row_count;
  insert into public.project_shares (project_id, token_hash) values (p_project, p_token_hash) returning * into r;
  perform public.gf_emit(p_project, p_event,
                         jsonb_build_object('share_id', r.id, 'replaced_previous', replaced > 0));
  return jsonb_build_object('share_id', r.id, 'created_at', r.created_at, 'replaced_previous', replaced > 0);
end;
$$;

create or replace function public.gf_revoke_share(p_project uuid, p_event jsonb) returns jsonb
language plpgsql as $$
declare sid uuid;
begin
  perform 1 from public.projects where id = p_project for update;
  if not found then
    raise exception 'no such project' using errcode = '23503';
  end if;
  update public.project_shares set revoked_at = now()
   where project_id = p_project and revoked_at is null returning id into sid;
  if sid is null then
    return jsonb_build_object('revoked', false);
  end if;
  perform public.gf_emit(p_project, p_event, jsonb_build_object('share_id', sid));
  return jsonb_build_object('revoked', true);
end;
$$;

do $$
declare f text; r text;
begin
  for f in select unnest(array[
      'public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb)',
      'public.gf_issue_share(uuid, text, jsonb)',
      'public.gf_revoke_share(uuid, jsonb)']) loop
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

alter table public.project_comparisons enable row level security;
alter table public.project_shares enable row level security;
-- No policies: service role only.
