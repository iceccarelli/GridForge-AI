-- 0003_deliverables.sql — purchased engineering deliverables (idempotent)
--
-- Lifecycle: awaiting_intake -> generating -> draft -> released.
-- Generation is automated; RELEASE IS NOT. A human puts their name to an
-- engineering opinion before a client reads it.
create table if not exists public.deliverables (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  token text not null unique,
  kind text not null,
  status text not null default 'awaiting_intake',
  email text,
  company text,
  qualification_id uuid references public.qualifications (id),
  stripe_session_id text,
  amount_cents integer,
  intake jsonb,
  document_html text,
  document_md text,
  title text,
  released_at timestamptz
);

create index if not exists deliverables_token_idx on public.deliverables (token);
create index if not exists deliverables_status_idx on public.deliverables (status);
create index if not exists deliverables_created_at_idx on public.deliverables (created_at desc);

alter table public.deliverables enable row level security;
