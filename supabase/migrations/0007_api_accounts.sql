-- 0007_api_accounts.sql — self-serve metered API accounts
--
-- One row per paying account. Deliberately NOT a key store: we record the id of
-- the key that is currently live and the ids we have revoked, never the key
-- itself. The engine verifies keys offline by their signature, so nothing here
-- needs to hold a working credential — and a database that can hand somebody a
-- working credential is a database worth stealing.
--
-- `account` is the billing identity. Usage on the engine aggregates under it, so
-- rotating a key does not reset a customer's monthly allowance.
create table if not exists public.api_accounts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  token text not null unique,              -- the customer's portal link
  account text not null unique,            -- billing identity, mirrored in every key
  email text,
  company text,
  plan text not null,
  monthly_units integer not null default 0,
  status text not null default 'active',   -- active | past_due | cancelled
  key_id text,
  key_issued_at date,
  key_expires_at date,
  revoked_key_ids text[] default '{}',
  stripe_customer_id text,
  stripe_subscription_id text
);

create index if not exists api_accounts_token_idx on public.api_accounts (token);
create index if not exists api_accounts_account_idx on public.api_accounts (account);
create index if not exists api_accounts_sub_idx on public.api_accounts (stripe_subscription_id);

alter table public.api_accounts enable row level security;
-- No policies: the service role reaches it, nothing else. The portal token is the
-- only way a customer touches this table, and that goes through our own route.
