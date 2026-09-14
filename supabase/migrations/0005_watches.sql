-- 0005_watches.sql — Hall Watch: the model stays live (idempotent)
--
-- A study is a photograph; a hall is not. A watch keeps the hall's inputs on
-- record and re-solves them, so the client hears what moved and why — including
-- when the movement came from our side because a library or the constraint set
-- was revised.
create table if not exists public.watches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  token text not null unique,
  status text not null default 'active',          -- active | paused | cancelled
  cadence text not null default 'quarterly',      -- monthly | quarterly
  email text,
  company text,
  site_name text,
  hall_id text,
  intake jsonb,                                   -- the hall's inputs on record
  last_state jsonb,                               -- the answer as last reported
  last_run_at timestamptz,
  next_run_at timestamptz,
  stripe_subscription_id text,
  stripe_customer_id text
);

create table if not exists public.watch_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  watch_id uuid not null references public.watches (id) on delete cascade,
  material boolean not null default false,
  headline text,
  racks_delta integer,
  weeks_delta numeric,
  binding_moved boolean,
  document_html text,
  document_md text,
  change jsonb,
  trigger text default 'scheduled'                -- scheduled | inputs_updated
);

create index if not exists watches_status_idx on public.watches (status);
create index if not exists watches_next_run_idx on public.watches (next_run_at);
create index if not exists watch_notes_watch_idx on public.watch_notes (watch_id, created_at desc);

alter table public.watches enable row level security;
alter table public.watch_notes enable row level security;
