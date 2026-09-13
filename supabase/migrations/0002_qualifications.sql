-- 0002_qualifications.sql — capacity qualifier submissions (idempotent)
--
-- Every row is a real hall someone typed real numbers into. Over time this table
-- is the proprietary asset the physics is not: the distribution of busway
-- ratings, plant temperatures and contracted-versus-peak headroom across European
-- halls. Nobody else is collecting it.
create table if not exists public.qualifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  site_name text,
  hall_id text,
  metro text,
  country text,
  platform text,
  inputs jsonb not null,
  racks_as_found integer,
  racks_after_relief integer,
  binding_constraint text,
  intake_completeness numeric,
  name text,
  company text,
  email text,
  source text default 'gridforge.ai/qualifier',
  status text default 'scored'
);

create index if not exists qualifications_created_at_idx on public.qualifications (created_at desc);
create index if not exists qualifications_binding_idx on public.qualifications (binding_constraint);
create index if not exists qualifications_metro_idx on public.qualifications (metro);

alter table public.qualifications enable row level security;
