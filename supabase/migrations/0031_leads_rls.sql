-- 0031_leads_rls.sql — the lead table is service-role only, whichever file created it
--
-- public.leads holds every prospect's name, company, e-mail address, site and megawatts. supabase/schema.sql has always
-- enabled row level security on it, but 0001_leads.sql (the file a migration-driven deploy applies) never did, so a project
-- built from the migrations alone left the table to Supabase's default grants: the anon key, which ships in the browser,
-- could read and write it through PostgREST.
--
-- Additive and idempotent: 0001 is left as it was, and this can be applied any number of times, before or after
-- schema.sql. RLS is enabled with NO policy, so anon and authenticated see no rows and can write none, and the table
-- privileges Supabase grants them by default are revoked as a second, independent lock. The site reads and writes leads
-- only with the service-role key, which bypasses RLS and is not touched here.

alter table public.leads enable row level security;

do $$
declare r text;
begin
  revoke all on table public.leads from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.leads from %I', r);
    end if;
  end loop;
end;
$$;
