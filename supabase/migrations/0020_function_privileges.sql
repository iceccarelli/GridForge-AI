-- 0020: the gf_* functions are service_role-only, and now they actually are.
--
-- 0015/0016/0017/0018/0019 end with `revoke all on function ... from public` and grant
-- EXECUTE to service_role. On Supabase that is not enough: the platform's default
-- privileges grant EXECUTE on every new function in `public` to anon and authenticated
-- *directly* (not through PUBLIC), so the revoke leaves those grants in place. Found on the
-- production project after 0013-0019 were applied: all 17 gf_* functions listed anon and
-- authenticated in their ACL.
--
-- It was not exploitable -- the functions are SECURITY INVOKER and no table grants anything to
-- anon/authenticated, so a call fails on the first table access -- but "service_role-only" is
-- the contract these RPCs are written against, and it should hold at the function layer too,
-- not only because a table below happens to refuse.
--
-- Idempotent. A no-op where the roles do not exist (plain PostgreSQL).

do $$
declare f text; r text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'gf\_%' loop
    -- 0019 left gf_deposit_guard executable by PUBLIC; close that too.
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

-- Later gf_* functions in this schema should not be handed to the API roles by default either.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges in schema public revoke execute on functions from %I', r);
    end if;
  end loop;
end
$$;
