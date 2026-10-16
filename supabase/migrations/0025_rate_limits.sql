-- 0025_rate_limits.sql — a shared, atomic request counter for the public engine proxies
--
-- POST /api/power/compare and POST /api/power/deploy/cases call the capacity engine with the SITE's platform key:
-- anyone on the internet could spend that key's metered units in a loop. A counter in a serverless function's memory
-- is per instance and resets on every cold start, so it bounds nothing. This counter lives in the database every
-- instance already shares, and the increment is one atomic UPSERT: under concurrency the row lock serialises the
-- callers, so exactly `limit` requests in a window are admitted whatever the instance count.
--
-- Fixed windows: window_start = the window the call falls in. A bucket is a short pseudonymous string the site derives
-- (a keyed digest of the caller's public IP, or a route-wide "all" bucket); no IP address, token or request body is
-- ever stored here. Windows are at most a day. Every hit also sweeps a bounded batch of rows older than two days from
-- ANY bucket, so a caller who never returns still has their row removed (growth is bounded by the traffic itself, not
-- by how many distinct callers ever appeared). Fixed windows admit up to twice the limit within seconds across a window
-- boundary; the limit is per window, not per any interval of that length.
--
-- Service-role only, RLS on with no policies, like every other table the site writes. Forward-only and additive.

create table if not exists public.rate_limit_windows (
  bucket text not null check (length(bucket) between 1 and 120),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  updated_at timestamptz not null default now(),
  primary key (bucket, window_start)
);

create index if not exists rate_limit_windows_start_idx on public.rate_limit_windows (window_start);

alter table public.rate_limit_windows enable row level security;

-- One hit against a bucket. Returns {allowed, hits, limit, remaining, window_seconds, window_start, retry_after_seconds}.
-- The increment and the decision are the same statement: a caller admitted by this function has a seat; a denied one
-- did not take one from anybody else, because hits beyond the limit are still counted (so the Retry-After is honest)
-- but admit nothing.
create or replace function public.gf_rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql as $$
declare
  w_start timestamptz;
  n integer;
begin
  -- Validate BEFORE any arithmetic uses the window: a zero window must be refused by name, not by a division error.
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate limit needs a positive limit and a window of at most a day' using errcode = '22023';
  end if;
  w_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_windows (bucket, window_start, hits, updated_at)
  values (p_bucket, w_start, 1, now())
  on conflict (bucket, window_start) do update
    set hits = public.rate_limit_windows.hits + 1, updated_at = now()
  returning hits into n;
  -- Housekeeping, any bucket: a bounded batch of rows from two days ago or older (windows are at most a day).
  delete from public.rate_limit_windows
   where ctid = any (array(select ctid from public.rate_limit_windows
                            where window_start < now() - interval '2 days' limit 100));
  -- and this bucket's own previous windows.
  delete from public.rate_limit_windows
   where bucket = p_bucket and window_start < w_start - make_interval(secs => p_window_seconds);
  return jsonb_build_object(
    'allowed', n <= p_limit,
    'hits', n,
    'limit', p_limit,
    'remaining', greatest(p_limit - n, 0),
    'window_seconds', p_window_seconds,
    'window_start', w_start,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (w_start + make_interval(secs => p_window_seconds) - now())))::integer)
  );
end;
$$;

do $$
begin
  revoke all on function public.gf_rate_limit_hit(text, integer, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_rate_limit_hit(text, integer, integer) to service_role;
  end if;
end
$$;
