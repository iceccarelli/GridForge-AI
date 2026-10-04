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
  event_type text not null,
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
