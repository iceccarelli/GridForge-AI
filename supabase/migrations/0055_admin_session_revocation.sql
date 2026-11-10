-- 0055_admin_session_revocation.sql: a server-side denylist of logged-out admin sessions.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. It needs nothing but PostgreSQL (no earlier migration).
--
-- ORDER AGAINST THE WEBSITE DEPLOY MATTERS HERE, unlike most migrations. The new website code (lib/admin.ts) reads this denylist on EVERY admin request
-- and FAILS CLOSED in production when it cannot: with the new code deployed and this migration NOT applied, no admin session is accepted and the login
-- route answers 503 naming this migration. Apply 0055 first (or together with the deploy). Before the new code is deployed the table is simply unused.
--
-- Why. An admin session is a stateless cookie `<expiry>.<nonce>.<mac>` (HMAC under ADMIN_SESSION_SECRET). Logging out only asked the browser to forget it,
-- so a copy of the cookie (a proxy log, a stolen laptop) stayed valid until it expired. Logout now writes the session's nonce here and the check reads it.
--
-- What is stored. nonce_hash = HMAC-SHA256 under the session secret of the cookie's nonce, computed by the site (64 lowercase hex characters). Never the
-- nonce, the MAC or the cookie: the database cannot reconstruct a cookie, and a reader of this table cannot tell which cookie a row belongs to without the
-- secret. expires_at = when that cookie would have expired anyway (clamped to at most a day from now, whatever the caller says).
--
-- Bounded retention. A row is only needed until its cookie has expired, which is at most a few hours (4 h today). gf_admin_session_revoke deletes every row
-- that expired more than an hour ago each time it runs, so the table holds the logouts of roughly the last few hours and nothing older, and only a validly
-- signed cookie can add a row (the website checks the MAC before calling it). There is no history here and nothing to query it for.
--
-- Access. RLS is on with NO policy, and every privilege is closed to PUBLIC, anon and authenticated, at the table and the function layer (the convention of
-- 0020, 0027, 0044, 0049): only the service role reaches the table, through the two functions below.
--
-- Additive and idempotent.

create table if not exists public.admin_session_revocations (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists admin_session_revocations_expiry_idx on public.admin_session_revocations (expires_at);

alter table public.admin_session_revocations enable row level security;
-- No policies: service role only.

-- Deny one session until it would have expired anyway. Idempotent (logging out twice is one row). Prunes what no cookie can still need.
create or replace function public.gf_admin_session_revoke(p_nonce_hash text, p_expires_at timestamptz) returns void
language plpgsql as $$
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'p_nonce_hash must be 64 lowercase hex characters' using errcode = '22023';
  end if;
  if p_expires_at is null then
    raise exception 'p_expires_at is required' using errcode = '22023';
  end if;

  -- Retention: a row whose cookie expired more than an hour ago (clock-skew margin) can never matter again.
  delete from public.admin_session_revocations where expires_at < now() - interval '1 hour';

  insert into public.admin_session_revocations (nonce_hash, expires_at)
  values (p_nonce_hash, least(p_expires_at, now() + interval '1 day'))
  on conflict (nonce_hash) do nothing;
end;
$$;

-- Has this session been logged out? True or false, never an error for a well-formed argument.
create or replace function public.gf_admin_session_revoked(p_nonce_hash text) returns boolean
language plpgsql stable as $$
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'p_nonce_hash must be 64 lowercase hex characters' using errcode = '22023';
  end if;
  return exists (select 1 from public.admin_session_revocations where nonce_hash = p_nonce_hash);
end;
$$;

do $$
declare f text; r text;
begin
  -- Table: nothing for the API roles; the service role may read, add and prune, never truncate or rewrite a row.
  revoke all on public.admin_session_revocations from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.admin_session_revocations from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Default privileges (a Supabase project's, or the real-database rig's) hand a new table to service_role in full: take that back, then give exactly what is used.
    revoke all on public.admin_session_revocations from service_role;
    grant select, insert, delete on public.admin_session_revocations to service_role;
  end if;

  -- Functions: service role only (a Supabase project's default privileges would otherwise hand them to anon and authenticated; see 0020).
  foreach f in array array['public.gf_admin_session_revoke(text, timestamptz)', 'public.gf_admin_session_revoked(text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;
