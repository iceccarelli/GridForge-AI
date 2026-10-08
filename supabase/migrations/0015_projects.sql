-- 0015_projects.sql — the Verified Power Record: one canonical project, joined to
-- the objects that already exist, with an immutable history.
--
-- A project is a JOIN and EVIDENCE layer. It is not authoritative for anything the
-- engine computes: the BTM case's request/result stay in power_deployment_cases,
-- prices stay in lib/products.ts, supplier scoring stays in gridforge.procurement.
-- Nothing in this migration copies a request, a result or a price.
--
-- Everything is reached only through the service role (app/api/projects/*), exactly
-- like watches, scenarios and power_deployment_cases above it: RLS on, no policies.

-- ---------------------------------------------------------------------------
-- A. projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_token text not null unique,
  company text,
  project_name text not null,
  site_label text,
  -- Only what the customer supplied. Never geocoded, inferred or enriched.
  location jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'decision', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- B. project_links — attach existing objects without duplicating them
-- ---------------------------------------------------------------------------
create table if not exists public.project_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  object_type text not null
    check (object_type in ('power_deployment_case', 'deliverable', 'watch',
                           'procurement_package', 'calibration_observation')),
  -- power_deployment_case -> case_token; procurement_package -> package_token;
  -- calibration_observation -> the ledger's own observation identifier.
  object_id text not null,
  -- Typed attachment point for a FUTURE calibration observation: the prediction
  -- it reconciles, as 'power_deployment_case:<case_token>:r<revision>:<architecture>'.
  -- Only meaningful on a calibration_observation link, and required there — an
  -- observation with no prediction behind it is not a reconciliation. Nothing in
  -- this repository writes such a link yet, and the calibration ledger itself
  -- (gridforge/calibration) is untouched.
  prediction_ref text,
  created_at timestamptz not null default now(),
  unique (project_id, object_type, object_id),
  check ((object_type = 'calibration_observation') = (prediction_ref is not null))
);

create index if not exists project_links_object_idx
  on public.project_links (object_type, object_id);

-- A BTM case or an RFQ package belongs to at most one project, whatever two callers
-- race to do: the database, not the application's read-then-write, is the arbiter.
create unique index if not exists project_links_one_project_per_object
  on public.project_links (object_type, object_id)
  where object_type in ('power_deployment_case', 'procurement_package');

-- ---------------------------------------------------------------------------
-- C. project_evidence — a narrow inventory of uploaded artifacts
-- ---------------------------------------------------------------------------
create table if not exists public.project_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  filename text not null,
  media_type text not null
    check (media_type in ('application/pdf', 'text/csv', 'application/json')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 5242880),
  -- '<bucket>/<path>' of the stored object (Supabase Storage, private bucket).
  storage_ref text not null,
  source_category text not null default 'other'
    check (source_category in ('utility_correspondence', 'supplier_document', 'load_data',
                               'site_documentation', 'other')),
  -- Null means NOT YET CLASSIFIED. A file existing is not evidence of any class;
  -- only a review (not built here) may set one. Never defaulted upward.
  evidence_class text check (evidence_class in ('E0','E1','E2','E3','E4','E5','E6','E7')),
  review_status text not null default 'unverified'
    check (review_status in ('unverified', 'verified', 'rejected')),
  note text,
  uploaded_at timestamptz not null default now()
);

create index if not exists project_evidence_project_idx on public.project_evidence (project_id);

-- ---------------------------------------------------------------------------
-- D. project_events — immutable commercial/engineering history
-- ---------------------------------------------------------------------------
create table if not exists public.project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  event_type text not null
    check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                          'rfq_generated', 'supplier_response_received',
                          'comparison_completed', 'supplier_selected', 'evidence_attached')),
  occurred_at timestamptz not null default now(),
  actor text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists project_events_project_idx
  on public.project_events (project_id, occurred_at);

-- ---------------------------------------------------------------------------
-- E. The procurement package and what comes back against it
-- ---------------------------------------------------------------------------
-- Hall procurement lives on `deliverables` (a paid, human-released engagement). A BTM
-- case has no such row, so the BTM package needs its own owner. The smallest one:
-- the package (what was asked), the responses (what suppliers answered) and the
-- comparisons (what the existing engine ranked) — three immutable-by-trigger record
-- types, with selection the only thing ever set on a package afterwards.
create table if not exists public.procurement_packages (
  id uuid primary key default gen_random_uuid(),
  package_token text not null unique,
  project_id uuid not null references public.projects (id),
  -- The package is built from this exact, immutable revision of the case. The
  -- request is NOT copied here: power_deployment_cases rows are never mutated, so
  -- (case_token, case_revision) reproduces the input byte for byte.
  case_token text not null,
  case_revision int not null,
  architecture text not null,
  -- gridforge/reporting/btm_spec*.py output, verbatim, via /v1/power/deploy/spec.
  spec_summary jsonb not null,
  response_template jsonb not null,
  document_md text not null,
  document_html text not null,
  created_at timestamptz not null default now(),
  -- Selection is a human business decision, set once, and is NOT a ranking.
  selected_supplier text,
  selected_response_id uuid,
  selected_comparison_id uuid,
  selected_at timestamptz,
  selected_by text
);

create index if not exists procurement_packages_project_idx
  on public.procurement_packages (project_id);

create table if not exists public.procurement_responses (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.procurement_packages (id),
  project_id uuid not null references public.projects (id),
  supplier text not null,
  -- The completed response schedule exactly as submitted (SupplierResponse shape).
  response jsonb not null,
  received_at timestamptz not null default now()
);

-- One response per supplier per package: a duplicate is refused, never merged.
create unique index if not exists procurement_responses_one_per_supplier
  on public.procurement_responses (package_id, lower(supplier));

create table if not exists public.procurement_comparisons (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.procurement_packages (id),
  project_id uuid not null references public.projects (id),
  case_token text not null,
  case_revision int not null,
  architecture text not null,
  response_ids jsonb not null,
  -- /v1/power/deploy/bids output, verbatim. Selection never rewrites it.
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists procurement_comparisons_package_idx
  on public.procurement_comparisons (package_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Immutability. RLS does not bind the service role, so history is enforced where
-- the service role cannot step around it: a trigger.
-- ---------------------------------------------------------------------------
create or replace function public.gf_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists project_events_append_only on public.project_events;
create trigger project_events_append_only
  before update or delete on public.project_events
  for each row execute function public.gf_append_only();

drop trigger if exists procurement_responses_append_only on public.procurement_responses;
create trigger procurement_responses_append_only
  before update or delete on public.procurement_responses
  for each row execute function public.gf_append_only();

drop trigger if exists procurement_comparisons_append_only on public.procurement_comparisons;
create trigger procurement_comparisons_append_only
  before update or delete on public.procurement_comparisons
  for each row execute function public.gf_append_only();

-- A package may change exactly once, from "no selection" to "a selection", and
-- nothing else on it may move. Once a supplier is selected it is never deleted (an
-- unselected package can be withdrawn, e.g. when its history event fails to record;
-- the foreign keys from responses and comparisons already protect any that has data).
create or replace function public.gf_package_selection_once() returns trigger
language plpgsql as $$
declare
  strip text[] := array['selected_supplier', 'selected_response_id',
                        'selected_comparison_id', 'selected_at', 'selected_by'];
begin
  if tg_op = 'DELETE' then
    if old.selected_supplier is not null then
      raise exception 'a package with a selected supplier cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.selected_supplier is not null then
    raise exception 'a supplier was already selected for this package' using errcode = '42501';
  end if;
  if (to_jsonb(new) - strip) <> (to_jsonb(old) - strip) then
    raise exception 'only the supplier selection may be set on a package' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists procurement_packages_selection_once on public.procurement_packages;
create trigger procurement_packages_selection_once
  before update or delete on public.procurement_packages
  for each row execute function public.gf_package_selection_once();


-- ---------------------------------------------------------------------------
-- Atomic business writes: a business record and the history event that describes
-- it are inserted by ONE function call, i.e. one transaction. If the event cannot
-- be written (bad actor, unknown type, any error) the record is rolled back with it,
-- so there is never a completed business state without its history, nor a history
-- line for something that did not happen. The application calls these through
-- PostgREST (/rest/v1/rpc/<name>); it has no other path that writes both.
--
-- Not a framework: plain functions, each doing exactly one insert (or the one
-- permitted update) plus gf_emit. They are SECURITY INVOKER and are executable only
-- by the service role.
-- ---------------------------------------------------------------------------
create or replace function public.gf_emit(p_project uuid, p_event jsonb,
                                          p_extra jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into public.project_events (project_id, event_type, occurred_at, actor, payload)
  values (p_project, p_event->>'event_type',
          coalesce((p_event->>'occurred_at')::timestamptz, now()),
          p_event->>'actor',
          coalesce(p_event->'payload', '{}'::jsonb) || coalesce(p_extra, '{}'::jsonb))
  returning id into v;
  return v;
end;
$$;

create or replace function public.gf_create_project(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.projects;
begin
  insert into public.projects (project_token, company, project_name, site_label, location,
                               status, created_at, updated_at)
  values (p->>'project_token', p->>'company', p->>'project_name', p->>'site_label',
          p->'location', coalesce(p->>'status', 'draft'),
          coalesce((p->>'created_at')::timestamptz, now()),
          coalesce((p->>'updated_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(r.id, p_event);
  return to_jsonb(r);
end;
$$;

-- Returns {created:false} (and writes nothing) when the link already existed.
create or replace function public.gf_attach_case(p_project uuid, p_case_token text,
                                                 p_event jsonb) returns jsonb
language plpgsql as $$
declare v uuid;
begin
  insert into public.project_links (project_id, object_type, object_id)
  values (p_project, 'power_deployment_case', p_case_token)
  on conflict (project_id, object_type, object_id) do nothing
  returning id into v;
  if v is null then
    return jsonb_build_object('created', false);
  end if;
  perform public.gf_emit(p_project, p_event);
  return jsonb_build_object('created', true, 'link_id', v);
end;
$$;

-- A new revision of a case that belongs to one or more projects: the revision row and
-- one btm_case_revised event per owning project, together.
create or replace function public.gf_append_case_revision(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.power_deployment_cases; l record; n int := 0;
begin
  insert into public.power_deployment_cases (case_token, revision, email, company,
                                             project_name, request, result, changed_fields)
  values (p->>'case_token', (p->>'revision')::int, p->>'email', p->>'company',
          p->>'project_name', p->'request', p->'result',
          coalesce(array(select jsonb_array_elements_text(p->'changed_fields')), '{}'))
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

create or replace function public.gf_create_package(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.procurement_packages;
begin
  insert into public.procurement_packages (package_token, project_id, case_token, case_revision,
        architecture, spec_summary, response_template, document_md, document_html, created_at)
  values (p->>'package_token', (p->>'project_id')::uuid, p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->'spec_summary',
          p->'response_template', p->>'document_md', p->>'document_html',
          coalesce((p->>'created_at')::timestamptz, now()))
  returning * into r;
  insert into public.project_links (project_id, object_type, object_id)
  values (r.project_id, 'procurement_package', r.package_token);
  perform public.gf_emit(r.project_id, p_event);
  return to_jsonb(r) - 'document_md' - 'document_html';
end;
$$;

create or replace function public.gf_add_response(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.procurement_responses;
begin
  insert into public.procurement_responses (package_id, project_id, supplier, response, received_at)
  values ((p->>'package_id')::uuid, (p->>'project_id')::uuid, p->>'supplier', p->'response',
          coalesce((p->>'received_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
                         jsonb_build_object('response_id', r.id, 'received_at', r.received_at));
  return to_jsonb(r);
end;
$$;

create or replace function public.gf_add_comparison(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.procurement_comparisons;
begin
  insert into public.procurement_comparisons (package_id, project_id, case_token, case_revision,
        architecture, response_ids, result, created_at)
  values ((p->>'package_id')::uuid, (p->>'project_id')::uuid, p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->'response_ids', p->'result',
          coalesce((p->>'created_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event, jsonb_build_object('comparison_id', r.id));
  return to_jsonb(r);
end;
$$;

-- The one permitted update on a package. Returns null (and writes nothing) if a supplier
-- was already selected — the caller reads that as a conflict.
create or replace function public.gf_select_supplier(p_package uuid, p jsonb, p_event jsonb)
returns jsonb
language plpgsql as $$
declare r public.procurement_packages;
begin
  update public.procurement_packages
     set selected_supplier = p->>'selected_supplier',
         selected_response_id = (p->>'selected_response_id')::uuid,
         selected_comparison_id = (p->>'selected_comparison_id')::uuid,
         selected_at = (p->>'selected_at')::timestamptz,
         selected_by = p->>'selected_by'
   where id = p_package and selected_supplier is null
  returning * into r;
  if not found then
    return null;
  end if;
  perform public.gf_emit(r.project_id, p_event);
  return to_jsonb(r) - 'document_md' - 'document_html';
end;
$$;

create or replace function public.gf_add_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_evidence;
begin
  insert into public.project_evidence (project_id, filename, media_type, sha256, byte_size,
        storage_ref, source_category, evidence_class, review_status, note, uploaded_at)
  values ((p->>'project_id')::uuid, p->>'filename', p->>'media_type', p->>'sha256',
          (p->>'byte_size')::bigint, p->>'storage_ref', coalesce(p->>'source_category', 'other'),
          p->>'evidence_class', coalesce(p->>'review_status', 'unverified'), p->>'note',
          coalesce((p->>'uploaded_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event, jsonb_build_object('evidence_id', r.id));
  return to_jsonb(r);
end;
$$;

do $$
declare f text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    for f in select p.oid::regprocedure::text from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'gf\_%' loop
      execute format('revoke all on function %s from public', f);
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end
$$;

alter table public.projects enable row level security;
alter table public.project_links enable row level security;
alter table public.project_evidence enable row level security;
alter table public.project_events enable row level security;
alter table public.procurement_packages enable row level security;
alter table public.procurement_responses enable row level security;
alter table public.procurement_comparisons enable row level security;
-- No policies: service role only, like every table above.

-- ---------------------------------------------------------------------------
-- Evidence object storage: one private bucket. Skipped where Supabase Storage is
-- not installed (a plain Postgres used for migration checks).
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('project-evidence', 'project-evidence', false)
    on conflict (id) do nothing;
  end if;
end
$$;
