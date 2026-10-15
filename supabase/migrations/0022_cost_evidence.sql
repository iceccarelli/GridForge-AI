-- 0022_cost_evidence.sql — a supplier's quotation becomes cost evidence only by a named person's decision
--
--   Procurement Specification (a deliverable) -> supplier responses -> engine-validated quote LINES (received)
--     -> human review (accepted | rejected) -> retired later (superseded | withdrawn)
--     -> a new engine run that uses the ACCEPTED lines, recorded without touching any earlier run
--
-- What this migration refuses to do, and where:
--   * Receipt is not trust. A line is stored with the engine's validation result (validated | invalid) and nothing
--     else; it carries no authority. Only a review row with decision 'accepted' makes it usable, and only a
--     VALIDATED line can be accepted (checked here, not just in the application).
--   * Submissions, reviews, retirements and run records are append-only. A decision is not flipped: a rejected line
--     stays rejected, and a better quotation is submitted and accepted, which RETIRES the older accepted line for the
--     same cost key in the same transaction. The advisory lock makes two concurrent acceptances for one key serialise,
--     so exactly one accepted line per (engagement, cost key) is ever current.
--   * The same response submitted twice is the same line (unique on the content digest): a retry creates nothing.
--   * Nothing here writes to the cost library or changes a price. The accepted lines are read at run time and applied
--     to ONE request by the engine's overlay. Quotations are confidential: RLS is on and no policy grants anyone but
--     the service role.

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached', 'observation_submitted', 'observation_reviewed',
                        'supplier_actual_submitted', 'supplier_actual_reviewed',
                        'cost_evidence_received', 'cost_evidence_reviewed', 'cost_evidence_retired',
                        'cost_evidence_run'));

create table if not exists public.cost_evidence (
  id uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references public.deliverables (id),
  -- The project the engagement is attached to, when it is (null otherwise). Resolved here, never supplied.
  project_id uuid references public.projects (id),
  -- One line of one response, once: sha256 over (cost key, response content digest, supplier).
  line_digest text not null check (line_digest ~ '^[0-9a-f]{64}$'),
  cost_key text not null check (cost_key ~ '^[A-Za-z0-9_]+\.[A-Za-z0-9_.]+$'),
  unit text not null,
  value numeric,
  submitted_value numeric,
  currency text not null default '',
  supplier text not null check (length(btrim(supplier)) > 0),
  received_on date,
  valid_until date,
  reference text,
  scope text not null check (length(btrim(scope)) > 0),
  -- What a lump quote covers, in the unit the engine prices the line in.
  quoted_quantity numeric check (quoted_quantity is null or quoted_quantity > 0),
  quoted_quantity_unit text,
  -- What the response answered: project / hall / constraint / sized_for_racks.
  specification jsonb not null,
  response_digest text not null check (response_digest ~ '^[0-9a-f]{64}$'),
  validation_status text not null check (validation_status in ('validated', 'invalid')),
  problems jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  comparability text not null check (comparability in ('exact', 'limited')),
  -- A test fixture or demonstration is never a real quotation, and every deliverable that uses one says so.
  synthetic boolean not null default false,
  submitted_at timestamptz not null default now(),
  unique (deliverable_id, line_digest),
  check ((quoted_quantity is null) = (quoted_quantity_unit is null)),
  check (validation_status = 'invalid' or jsonb_array_length(problems) = 0),
  -- An invalid line is kept so the reviewer sees what was wrong with it, and may be missing the very thing that made it
  -- invalid (no price, another currency, an unreadable date). A validated line may be missing none of them.
  check (validation_status = 'invalid' or (value is not null and value > 0 and currency = 'EUR' and received_on is not null))
);

create index if not exists cost_evidence_deliverable_idx on public.cost_evidence (deliverable_id, cost_key);

create table if not exists public.cost_evidence_reviews (
  id uuid primary key default gen_random_uuid(),
  -- One decision per line, ever.
  evidence_id uuid not null unique references public.cost_evidence (id),
  decision text not null check (decision in ('accepted', 'rejected')),
  -- The reviewer's judgement of what KIND of quotation it is. Never inferred from the fact of receipt.
  basis text check (basis in ('budgetary_quote', 'firm_quote', 'contracted')),
  comparability text check (comparability in ('exact', 'limited')),
  -- Other cost keys whose scope this quotation already covers (e.g. a CDU quote that includes commissioning).
  includes_keys text[] not null default '{}',
  region text,
  reviewer text not null check (length(btrim(reviewer)) > 0),
  reason text,
  reviewed_at timestamptz not null default now(),
  check ((decision = 'accepted') = (basis is not null)),
  check ((decision = 'accepted') = (comparability is not null))
);

create table if not exists public.cost_evidence_retirements (
  evidence_id uuid primary key references public.cost_evidence (id),
  kind text not null check (kind in ('superseded', 'withdrawn')),
  superseded_by uuid references public.cost_evidence (id),
  reason text,
  retired_by text not null check (length(btrim(retired_by)) > 0),
  retired_at timestamptz not null default now(),
  check ((kind = 'superseded') = (superseded_by is not null)),
  check (superseded_by is null or superseded_by <> evidence_id)
);

-- A run that used accepted evidence. Idempotent on (engagement, intake, evidence set): the same inputs are the same run.
create table if not exists public.cost_evidence_runs (
  id uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references public.deliverables (id),
  project_id uuid references public.projects (id),
  intake_digest text not null check (intake_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_ids uuid[] not null,
  effect jsonb not null,
  ignored jsonb not null default '[]'::jsonb,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (deliverable_id, intake_digest, evidence_digest)
);

drop trigger if exists cost_evidence_append_only on public.cost_evidence;
create trigger cost_evidence_append_only before update or delete on public.cost_evidence
  for each row execute function public.gf_append_only();
drop trigger if exists cost_evidence_reviews_append_only on public.cost_evidence_reviews;
create trigger cost_evidence_reviews_append_only before update or delete on public.cost_evidence_reviews
  for each row execute function public.gf_append_only();
drop trigger if exists cost_evidence_retirements_append_only on public.cost_evidence_retirements;
create trigger cost_evidence_retirements_append_only before update or delete on public.cost_evidence_retirements
  for each row execute function public.gf_append_only();
drop trigger if exists cost_evidence_runs_append_only on public.cost_evidence_runs;
create trigger cost_evidence_runs_append_only before update or delete on public.cost_evidence_runs
  for each row execute function public.gf_append_only();

alter table public.cost_evidence enable row level security;
alter table public.cost_evidence_reviews enable row level security;
alter table public.cost_evidence_retirements enable row level security;
alter table public.cost_evidence_runs enable row level security;

-- The lifecycle in one place. invalid -> (never usable); validated -> awaiting a decision; accepted -> usable;
-- rejected / superseded / withdrawn -> kept for the record, never applied.
create or replace view public.cost_evidence_state with (security_invoker = true) as
select e.*,
       r.decision, r.basis as reviewed_basis, r.comparability as reviewed_comparability, r.includes_keys,
       r.region as reviewed_region, r.reviewer, r.reviewed_at, r.reason as review_reason,
       t.kind as retired_kind, t.superseded_by, t.retired_at,
       case when t.evidence_id is not null then t.kind
            when r.decision = 'accepted' then 'accepted'
            when r.decision = 'rejected' then 'rejected'
            when e.validation_status = 'validated' then 'validated'
            else 'invalid' end as state
from public.cost_evidence e
left join public.cost_evidence_reviews r on r.evidence_id = e.id
left join public.cost_evidence_retirements t on t.evidence_id = e.id;

-- A line, and its history event if the engagement belongs to a project. The same line twice creates nothing.
create or replace function public.gf_submit_cost_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.cost_evidence; proj uuid; existing public.cost_evidence;
begin
  select pl.project_id into proj from public.project_links pl
   where pl.object_type = 'deliverable' and pl.object_id = (p->>'deliverable_id');
  insert into public.cost_evidence (deliverable_id, project_id, line_digest, cost_key, unit, value, submitted_value,
        currency, supplier, received_on, valid_until, reference, scope, quoted_quantity, quoted_quantity_unit,
        specification, response_digest, validation_status, problems, limitations, comparability, synthetic)
  values ((p->>'deliverable_id')::uuid, proj, p->>'line_digest', p->>'cost_key', p->>'unit', nullif(p->>'value', '')::numeric,
          nullif(p->>'submitted_value', '')::numeric, coalesce(p->>'currency', ''), p->>'supplier', nullif(p->>'received_on', '')::date,
          nullif(p->>'valid_until', '')::date, p->>'reference', p->>'scope',
          nullif(p->>'quoted_quantity', '')::numeric, nullif(p->>'quoted_quantity_unit', ''),
          coalesce(p->'specification', '{}'::jsonb), p->>'response_digest', p->>'validation_status',
          coalesce(p->'problems', '[]'::jsonb), coalesce(p->'limitations', '[]'::jsonb), p->>'comparability',
          coalesce((p->>'synthetic')::boolean, false))
  returning * into r;
  if proj is not null then
    perform public.gf_emit(proj, p_event, jsonb_build_object('evidence_id', r.id, 'cost_key', r.cost_key,
                           'validation_status', r.validation_status, 'synthetic', r.synthetic));
  end if;
  return jsonb_build_object('created', true, 'id', r.id);
exception when unique_violation then
  select * into existing from public.cost_evidence
   where deliverable_id = (p->>'deliverable_id')::uuid and line_digest = p->>'line_digest';
  if not found then raise; end if;
  return jsonb_build_object('created', false, 'id', existing.id);
end;
$$;

-- A decision. Acceptance retires the previous accepted line for the same engagement and cost key in the SAME
-- transaction; the advisory lock makes concurrent acceptances for that key take turns.
create or replace function public.gf_review_cost_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare e public.cost_evidence; rev public.cost_evidence_reviews; prev uuid; retired uuid[] := '{}';
begin
  select * into e from public.cost_evidence where id = (p->>'evidence_id')::uuid;
  if not found then raise exception 'no such evidence' using errcode = '23503'; end if;
  perform pg_advisory_xact_lock(hashtextextended(e.deliverable_id::text || ':' || e.cost_key, 0));
  if exists (select 1 from public.cost_evidence_reviews where evidence_id = e.id) then
    raise exception 'this evidence has already been reviewed' using errcode = '23505';
  end if;
  if p->>'decision' = 'accepted' then
    if e.validation_status <> 'validated' then
      raise exception 'only a validated quotation line can be accepted' using errcode = '23514';
    end if;
    if e.valid_until is not null and e.valid_until < current_date then
      raise exception 'this quotation has expired and cannot be accepted' using errcode = '23514';
    end if;
    for prev in
      select s.id from public.cost_evidence_state s
       where s.deliverable_id = e.deliverable_id and s.cost_key = e.cost_key and s.state = 'accepted' and s.id <> e.id
    loop
      insert into public.cost_evidence_retirements (evidence_id, kind, superseded_by, reason, retired_by)
      values (prev, 'superseded', e.id, 'replaced by a newer accepted quotation', p->>'reviewer');
      retired := retired || prev;
    end loop;
  end if;
  insert into public.cost_evidence_reviews (evidence_id, decision, basis, comparability, includes_keys, region,
                                            reviewer, reason)
  values (e.id, p->>'decision', nullif(p->>'basis', ''), nullif(p->>'comparability', ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'includes_keys', '[]'::jsonb)) x),
                   '{}'), nullif(p->>'region', ''), p->>'reviewer', nullif(p->>'reason', ''))
  returning * into rev;
  if e.project_id is not null then
    perform public.gf_emit(e.project_id, p_event, jsonb_build_object('evidence_id', e.id, 'cost_key', e.cost_key,
        'decision', rev.decision, 'basis', rev.basis, 'superseded', to_jsonb(retired)));
  end if;
  return jsonb_build_object('review', to_jsonb(rev), 'superseded', to_jsonb(retired));
end;
$$;

-- A supplier withdraws an accepted quotation, or a person retires one. Only accepted, not-yet-retired evidence.
create or replace function public.gf_retire_cost_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare e public.cost_evidence; s public.cost_evidence_state;
begin
  select * into s from public.cost_evidence_state where id = (p->>'evidence_id')::uuid;
  if not found then raise exception 'no such evidence' using errcode = '23503'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.deliverable_id::text || ':' || s.cost_key, 0));
  select * into s from public.cost_evidence_state where id = s.id;
  if s.state <> 'accepted' then
    raise exception 'only accepted evidence can be withdrawn; this is %', s.state using errcode = '23514';
  end if;
  insert into public.cost_evidence_retirements (evidence_id, kind, reason, retired_by)
  values (s.id, 'withdrawn', nullif(p->>'reason', ''), p->>'retired_by');
  if s.project_id is not null then
    perform public.gf_emit(s.project_id, p_event, jsonb_build_object('evidence_id', s.id, 'cost_key', s.cost_key,
                                                                    'kind', 'withdrawn'));
  end if;
  return jsonb_build_object('retired', true, 'id', s.id);
end;
$$;

-- A run that used accepted evidence, recorded once per (engagement, intake, evidence set).
create or replace function public.gf_record_cost_evidence_run(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.cost_evidence_runs; proj uuid;
begin
  select pl.project_id into proj from public.project_links pl
   where pl.object_type = 'deliverable' and pl.object_id = (p->>'deliverable_id');
  insert into public.cost_evidence_runs (deliverable_id, project_id, intake_digest, evidence_digest, evidence_ids,
                                         effect, ignored, document_sha256)
  values ((p->>'deliverable_id')::uuid, proj, p->>'intake_digest', p->>'evidence_digest',
          (select array_agg(x::uuid) from jsonb_array_elements_text(p->'evidence_ids') x),
          p->'effect', coalesce(p->'ignored', '[]'::jsonb), p->>'document_sha256')
  returning * into r;
  if proj is not null then
    perform public.gf_emit(proj, p_event, jsonb_build_object('run_id', r.id, 'evidence_ids', to_jsonb(r.evidence_ids)));
  end if;
  return jsonb_build_object('created', true, 'run', to_jsonb(r));
exception when unique_violation then
  select * into r from public.cost_evidence_runs
   where deliverable_id = (p->>'deliverable_id')::uuid and intake_digest = p->>'intake_digest'
     and evidence_digest = p->>'evidence_digest';
  return jsonb_build_object('created', false, 'run', to_jsonb(r));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.gf_submit_cost_evidence(jsonb, jsonb) from public;
    grant execute on function public.gf_submit_cost_evidence(jsonb, jsonb) to service_role;
    revoke all on function public.gf_review_cost_evidence(jsonb, jsonb) from public;
    grant execute on function public.gf_review_cost_evidence(jsonb, jsonb) to service_role;
    revoke all on function public.gf_retire_cost_evidence(jsonb, jsonb) from public;
    grant execute on function public.gf_retire_cost_evidence(jsonb, jsonb) to service_role;
    revoke all on function public.gf_record_cost_evidence_run(jsonb, jsonb) from public;
    grant execute on function public.gf_record_cost_evidence_run(jsonb, jsonb) to service_role;
    revoke all on public.cost_evidence_state from public;
    grant select on public.cost_evidence_state to service_role;
  end if;
end
$$;

-- Later gf_* functions in this schema should not be handed to the API roles by default either.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.cost_evidence, public.cost_evidence_reviews, public.cost_evidence_retirements, public.cost_evidence_runs, public.cost_evidence_state from %I', r);
    end if;
  end loop;
end
$$;
