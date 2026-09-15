-- 0010_scenarios.sql — a subscriber's saved siting scenarios
--
-- The second half of the same gap as 0009. app/api/scenarios has shipped a full
-- GET/POST/DELETE surface against this table since the Intelligence plan went on
-- sale, and /account renders it. The table did not exist, so a paying subscriber
-- saved a scenario, got `ok: true` back, and had nothing to return to.
--
-- Scoped by email, which is the authenticated identity /account holds. Every row
-- is one modelled comparison — a region, a load, and what the delay costs — so
-- nothing here is client site data and nothing here is an engine output.
create table if not exists public.scenarios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  email text not null,
  name text not null default 'Untitled site',
  mw numeric not null default 0,
  region_id text,
  value_per_mw_month numeric not null default 0,
  months_saved numeric not null default 0,
  avoided_eur bigint not null default 0
);

create index if not exists scenarios_email_idx
  on public.scenarios (email, created_at desc);

alter table public.scenarios enable row level security;
-- No policies: the service role reaches it through app/api/scenarios, which
-- checks the subscription and scopes every query to the caller's own email.
