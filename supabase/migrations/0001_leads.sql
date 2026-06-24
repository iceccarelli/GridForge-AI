-- 0001_leads.sql — GridForge AI leads table (idempotent)
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  company text not null,
  email text not null,
  location text not null,
  capacity_mw numeric,
  urgency text,
  grid_status text,
  services jsonb,
  message text,
  context text default 'general',
  source text default 'gridforge.ai',
  score integer,
  tier text,
  reasons jsonb,
  status text default 'new'
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_tier_idx on public.leads (tier);
create index if not exists leads_status_idx on public.leads (status);
