-- 0055_admin_session_revocation_and_free_domain_cap.sql: two independent, additive changes from an external security review.
--
--   A. a server-side denylist of logged-out admin sessions (public.admin_session_revocations, gf_admin_session_revoke, gf_admin_session_revoked);
--   B. a per-email-domain cap on VERIFIED free accounts per UTC month, enforced inside the same serialised call as the site-wide ceiling
--      (gf_free_account_verify_capped).
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. A needs nothing earlier; B needs 0028 and 0033 (api_accounts,
-- free_email_norm, free_verified_at, gf_free_account_verify). It rewrites no row and changes no existing function: gf_free_account_verify (0033) is left
-- exactly as it is, which also means a replay of 0033 cannot undo anything here.
--
-- ORDER AGAINST THE WEBSITE DEPLOY MATTERS HERE, unlike most migrations. The new website code FAILS CLOSED without this migration, by design:
--   * lib/admin.ts reads the denylist (A) on EVERY admin request and, in production, refuses every admin session while it cannot; the login route answers
--     503 naming this migration instead of handing out a cookie that would be refused;
--   * app/api/keys/route.ts mints a free account's first key through gf_free_account_verify_capped (B); without it that call answers 503 ("Could not issue a
--     key just now. Nothing was changed.") and a verified free account is not created. Keys of accounts that are already verified, and every paid key, are unaffected.
-- Apply 0055 first (or together with the deploy). Before the new code is deployed the objects below are simply unused.
--
-- Additive and idempotent (create ... if not exists / create or replace; the privilege block at the end is re-runnable). RLS stays on, with no policy.
--
-- ===================================================================================================================================================
-- A. Admin session revocation
-- ===================================================================================================================================================
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

-- ===================================================================================================================================================
-- B. Per-domain cap on verified free accounts
-- ===================================================================================================================================================
--
-- Why. The free allowance admits at most p_max VERIFIED accounts per UTC month (0033). Whoever controls a catch-all domain controls unlimited inboxes
-- (u1@evil.example, u2@evil.example, ...), the application's address normalisation only folds Gmail dots and "+tag", and each such address can open its
-- emailed link: a script could verify the whole month's ceiling and leave every real visitor with "the free allowance is full". The application now passes
-- the account's DOMAIN KEY (its domain, or the last two labels of it, three under a two-part suffix such as co.uk: computed in lib/payg.ts freeDomainKey so
-- that one wildcard catch-all is one domain) and a per-domain cap, or NULLs for a common free-mail provider, which is exempt (lib/payg.ts FREE_MAIL_DOMAINS:
-- the list lives in one place, the application, not here).
--
-- What it does, in ONE serialised call (the same advisory lock as gf_free_account_verify, so the two can never interleave and a burst of concurrent first
-- mints cannot overshoot either limit):
--   * unknown token / not a free account          -> {ok:false, reason:'unknown'}
--   * already verified                            -> {ok:true, already:true}                 (never turned away, never counted twice)
--   * site-wide ceiling reached (p_max)           -> {ok:false, reason:'capacity'}           (the broader truth wins when both are full)
--   * the domain is at its cap (p_domain_max)     -> {ok:false, reason:'domain_capacity'}    (verified this UTC month whose normalised email is on the
--                                                                                              domain key or a sub-domain of it)
--   * otherwise it verifies the account           -> {ok:true, already:false, domain_count:N} (N = this domain's verified accounts this month INCLUDING this one;
--                                                                                              only when a cap was supplied; the site logs one line at 80%)
-- Both p_domain_key and p_domain_max NULL = no per-domain cap (an exempt domain); exactly one of them NULL is refused, and so is a key that is not a plain
-- lower-case domain (it is used in a LIKE pattern).
--
-- Not covered, stated plainly: an attacker who owns MANY domains (each costs money; the site-wide ceiling still bounds the total), disposable-mail domains
-- (each is its own domain), and a free-mail provider's own addresses (exempt by design). The sub-domain grouping is a heuristic, not the Public Suffix List.

create or replace function public.gf_free_account_verify_capped(p_token text, p_max integer, p_domain_key text, p_domain_max integer) returns jsonb
language plpgsql as $$
declare v_id uuid; v_verified timestamptz; v_month_start timestamptz; v_count integer; v_domain_count integer;
begin
  if p_token is null or p_max is null or p_max < 0 then
    raise exception 'free account verification arguments out of range' using errcode = '22023';
  end if;
  if (p_domain_key is null) <> (p_domain_max is null) then
    raise exception 'p_domain_key and p_domain_max are given together or not at all' using errcode = '22023';
  end if;
  if p_domain_key is not null and (p_domain_key !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' or length(p_domain_key) > 253 or p_domain_max < 1) then
    raise exception 'domain cap arguments out of range' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('gf_free_account_verify'));   -- the SAME lock as gf_free_account_verify (0033)
  select id, free_verified_at into v_id, v_verified from public.api_accounts where token = p_token and plan = 'api_free';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if v_verified is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  v_month_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  select count(*) into v_count from public.api_accounts where free_verified_at >= v_month_start;
  if v_count >= p_max then
    return jsonb_build_object('ok', false, 'reason', 'capacity');
  end if;

  if p_domain_key is not null then
    -- Domain or sub-domain of the key. The key holds only [a-z0-9.-], so it carries no LIKE wildcard.
    select count(*) into v_domain_count from public.api_accounts
      where free_verified_at >= v_month_start and free_email_norm is not null
        and (split_part(free_email_norm, '@', 2) = p_domain_key or split_part(free_email_norm, '@', 2) like '%.' || p_domain_key);
    if v_domain_count >= p_domain_max then
      return jsonb_build_object('ok', false, 'reason', 'domain_capacity');
    end if;
  end if;

  update public.api_accounts set free_verified_at = now() where id = v_id;
  return case when p_domain_key is null
              then jsonb_build_object('ok', true, 'already', false)
              else jsonb_build_object('ok', true, 'already', false, 'domain_count', v_domain_count + 1) end;
end
$$;

-- ===================================================================================================================================================
-- Privileges (A and B): service role only, at the table and the function layer
-- ===================================================================================================================================================
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
  foreach f in array array['public.gf_admin_session_revoke(text, timestamptz)', 'public.gf_admin_session_revoked(text)', 'public.gf_free_account_verify_capped(text, integer, text, integer)'] loop
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
