-- GridForge AI — lead store. Paste into Supabase → SQL Editor → Run.
-- Service-role key (server-only, in /api/audit) bypasses RLS to insert.
-- Anon key can never read leads: RLS is on and no public policy exists.

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  -- contact
  name        text not null,
  company     text not null,
  email       text not null,

  -- project shape
  location    text not null,
  capacity_mw numeric,
  urgency     text not null check (urgency in ('immediate','90days','exploratory')),
  grid_status text not null check (grid_status in
                ('no_application','in_queue','study_phase','offer_received','unknown')),
  services    text[] not null default '{}',
  message     text not null,

  -- attribution + scoring (server-computed)
  context     text not null default 'general',
  source      text not null default 'gridforge.ai',
  score       int  not null default 0,
  tier        text not null check (tier in ('hot','warm','exploratory')),
  reasons     text[] not null default '{}',

  -- pipeline
  status      text not null default 'new' check (status in
                ('new','reviewed','call_booked','proposal','won','lost'))
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_tier_idx       on public.leads (tier);
create index if not exists leads_status_idx     on public.leads (status);

alter table public.leads enable row level security;
-- No policies = no anon/auth access. Only the service-role key (server) writes.
-- When you build the founder dashboard, add a policy scoped to your own auth uid.
