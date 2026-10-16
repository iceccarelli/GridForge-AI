-- 0024_rate_limit.sql — the guard in front of every public route that spends the platform engine key
--
-- A public route that calls the engine with GRIDFORGE_API_KEY (the Time-to-Power comparison is the first)
-- spends the company's metered units on behalf of an anonymous visitor. lib/rate-limit.ts calls the one
-- function below before the engine is touched. The guard FAILS CLOSED: until this migration is applied the
-- function does not exist, PostgREST answers 404, and every guarded route answers 503 rather than running
-- unmetered.
--
-- What is stored, and what is not:
--   * `subject` is an HMAC-SHA256 of the caller's address under a server-side secret, computed by the site.
--     No address, header, user agent or token reaches this table, and without the secret the value cannot
--     be turned back into an address.
--   * One row per (bucket, subject, window). A counter, not evidence: rows older than a day are removed
--     by the function itself, so the table does not grow without bound and holds no history of anyone.
--
-- The hit is one atomic INSERT .. ON CONFLICT DO UPDATE, so concurrent requests cannot both be counted as
-- "the last one allowed".

create table if not exists public.rate_limit_windows (
  bucket text not null check (length(bucket) between 1 and 64 and bucket ~ '^[a-z0-9_:.-]+$'),
  subject text not null check (subject ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits int not null check (hits >= 1),
  primary key (bucket, subject, window_start)
);

create index if not exists rate_limit_windows_window_idx on public.rate_limit_windows (window_start);

alter table public.rate_limit_windows enable row level security;
-- No policies: service role only, like every table in this schema.

create or replace function public.gf_rate_limit_hit(p_bucket text, p_subject text,
                                                    p_limit int, p_window_seconds int) returns jsonb
language plpgsql as $$
declare
  ws timestamptz;
  n int;
  ends timestamptz;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'p_limit must be between 1 and 100000' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'p_window_seconds must be between 1 and 86400' using errcode = '22023';
  end if;
  ws := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  ends := ws + make_interval(secs => p_window_seconds);

  insert into public.rate_limit_windows as w (bucket, subject, window_start, hits)
  values (p_bucket, p_subject, ws, 1)
  on conflict (bucket, subject, window_start)
  do update set hits = least(w.hits + 1, 2147483000)
  returning w.hits into n;

  -- Housekeeping on a small fraction of calls: nothing older than a day is ever read again.
  if random() < 0.01 then
    delete from public.rate_limit_windows where window_start < now() - interval '1 day';
  end if;

  return jsonb_build_object(
    'allowed', n <= p_limit,
    'hits', n,
    'limit', p_limit,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (ends - clock_timestamp())))::int)
  );
end;
$$;

do $$
declare r text;
begin
  revoke all on function public.gf_rate_limit_hit(text, text, int, int) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.gf_rate_limit_hit(text, text, int, int) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_rate_limit_hit(text, text, int, int) to service_role;
  end if;
end
$$;
