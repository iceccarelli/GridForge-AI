-- 0049_site_registry.sql: organisations, their members, sites and halls: the first record of WHERE a figure belongs.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision; nothing in the application needs these tables
-- until a signed-in person opens /account/sites, and every route under /api/orgs, /api/sites and /api/halls answers 503 until then.
--
-- Until now a hall had no identity of its own: its numbers were typed again into qualifications, intakes, watches (overwritten in
-- place), BTM cases, projects and scenarios, and an "organisation" was only the billing address on a subscription (0027). A project
-- (0015) is an anonymous, token-addressed commercial engagement; it cannot be the record of a place, because a place has many
-- projects over time and a project is the property of whoever holds its link. This adds the missing entities and nothing else:
--
--   organisations          who owns a registry. Not a billing entity: a subscription's seats (0027) are unchanged and unrelated.
--   organisation_members   who may see and change it, keyed by the VERIFIED email address (stored lower-cased), with a role:
--                          owner (everything, including members), editor (sites, halls, inputs), viewer (read only). A removal
--                          closes the row (removed_at), like 0027's seats; it is never deleted and never reopened (add the person
--                          again). The last active owner can never be removed, by the function or by a direct statement.
--   sites                  a place: a name that is unique per organisation, an optional ISO country, and what KIND of data it holds:
--                          'production' (a real asset), 'test' or 'synthetic'. Required, with no default, and fixed once written,
--                          so a rehearsal can never be quietly relabelled as a real hall afterwards.
--   halls                  a hall at a site: a label unique per site.
--
-- Every function checks the acting person's role INSIDE the database (p_actor is the address the application verified with the
-- sign-in provider; the application also checks, and the database does not rely on it). A person who is not an active member of an
-- organisation can neither read nor write anything of it: not its sites, halls, members or inputs, whatever ids they send.
--
-- Additive and idempotent: `create ... if not exists` / `create or replace`, no existing table is altered, no row is touched. All
-- four tables are created with RLS on and no policies (service role only, like every table that holds a customer's material: 0015,
-- 0020, 0027, 0040, 0044); TRUNCATE is revoked from the service role and guarded for everyone else (0040).
--
-- OPERATOR NOTES (owner decisions, not defaults this file can make):
--   * Locks. Everything here is `create ... if not exists` / `create or replace` on NEW objects, so nothing waits on a busy table. Even so, run it in a
--     session with `set lock_timeout = '5s';` (a statement that cannot get its lock then fails fast instead of queueing behind long transactions and
--     blocking everything behind it); re-running is safe.
--   * Personal data. Email addresses are written to append-only tables (organisation_members.email / added_by / removed_by, sites.created_by,
--     halls.created_by, organisations.created_by, and, in 0050, hall_inputs.recorded_by and attachment rows). Rows are never deleted and TRUNCATE is
--     refused, so a request to erase a person cannot be met by deleting rows. Whether and how to honour erasure (pseudonymising these columns by an
--     operator, behind a documented procedure) is the owner's decision; nothing here decides it.
--   * A sole owner. An organisation always keeps one active owner (the last one cannot be removed). If that one person loses their sign-in
--     address, nobody can administer the organisation: a person with database access would have to add an owner. That is deliberate (no back door in
--     the application); recovering it is an owner decision.
--   * Membership has no acceptance step: an owner adds an address and that address's holder is a member when they next sign in with it. The
--     application therefore shows every member who added them and offers "leave" (gf_my_orgs returns added_by and the membership id).
--
-- Named gf_org_add_member / gf_org_remove_member, not gf_add_member / gf_remove_member: 0027 already owns gf_remove_member(text, uuid)
-- for subscription seats, and two PostgREST-visible functions of one name differing only by argument types invite a call to the wrong one.

-- ---------------------------------------------------------------------------
-- A. Small helpers
-- ---------------------------------------------------------------------------
-- A normalised, plausible email address, or NULL. Same shape as lib/team.ts (no whitespace, one @, a dotted domain, <= 254).
create or replace function public.gf_registry_email(p text) returns text
language sql immutable as $$
  select case when lower(btrim(coalesce(p, ''))) ~ '^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$' and length(lower(btrim(p))) <= 254
              then lower(btrim(p)) end
$$;

-- Characters a name may never contain, whatever the database locale decides [[:cntrl:]] means: C0/C1 controls, zero-width characters and the
-- left-to-right / right-to-left marks and overrides (a name that renders as another name), the BOM, and the line and paragraph separators.
create or replace function public.gf_registry_text_bad(p text) returns boolean
language sql immutable as $$
  select p ~ '[[:cntrl:]\u200b-\u200f\u061c\u202a-\u202e\u2060-\u2069\ufeff\u2028\u2029]'
$$;

-- A name with the whitespace taken off both ends, ASCII and Unicode alike (no-break space, en/em spaces, ideographic space...).
create or replace function public.gf_registry_trim(p text) returns text
language sql immutable as $$
  select regexp_replace(coalesce(p, ''), '^[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[[:space:]\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$', '', 'g')
$$;

-- What every name, label and the like must satisfy: 1..120 characters, already trimmed, no control or bidirectional character.
create or replace function public.gf_registry_name_ok(p text) returns boolean
language sql immutable as $$
  select p is not null and length(p) between 1 and 120 and p = public.gf_registry_trim(p) and not public.gf_registry_text_bad(p)
$$;

create or replace function public.gf_registry_rank(p_role text) returns int
language sql immutable as $$
  select case p_role when 'owner' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end
$$;

-- ---------------------------------------------------------------------------
-- B. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (public.gf_registry_name_ok(name)),
  created_by text not null check (created_by = lower(btrim(created_by)) and position('@' in created_by) > 1 and length(created_by) <= 254),
  created_at timestamptz not null default now()
);

-- One creator does not register the same organisation twice by accident. (Names are not unique across creators: that would let a
-- stranger learn that a name is taken, and nothing here treats a name as an identity.)
create unique index if not exists organisations_creator_name_uq on public.organisations (created_by, lower(name));

create table if not exists public.organisation_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id),
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1 and length(email) <= 254 and email !~ '\s'),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  added_by text not null check (added_by = lower(btrim(added_by)) and position('@' in added_by) > 1),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by text,
  check ((removed_at is null) = (removed_by is null))
);

create unique index if not exists organisation_members_one_active on public.organisation_members (org_id, email) where (removed_at is null);
-- "Which organisations is this address in": the first lookup of every request.
create index if not exists organisation_members_email_idx on public.organisation_members (email) where (removed_at is null);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (id),
  name text not null check (public.gf_registry_name_ok(name)),
  country text check (country ~ '^[A-Z]{2}$'),
  -- Required and without a default: whoever creates a site says what kind of data it holds.
  data_origin text not null check (data_origin in ('production', 'test', 'synthetic')),
  created_by text not null check (created_by = lower(btrim(created_by)) and position('@' in created_by) > 1),
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create unique index if not exists sites_org_name_uq on public.sites (org_id, lower(name));

create table if not exists public.halls (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id),
  label text not null check (public.gf_registry_name_ok(label)),
  created_by text not null check (created_by = lower(btrim(created_by)) and position('@' in created_by) > 1),
  created_at timestamptz not null default now(),
  -- The pair a project's (site_id, hall_id) must name together (0050), so a project cannot point at a hall of another site.
  unique (site_id, id)
);

create unique index if not exists halls_site_label_uq on public.halls (site_id, lower(label));

-- ---------------------------------------------------------------------------
-- C. What cannot change, whatever calls the database
-- ---------------------------------------------------------------------------
-- Nothing in these three tables is ever deleted. Only the human-readable name (or label, or country) may be corrected, by an
-- operator: no function here does it. Who owns a site, its organisation, its data origin and its creator are fixed for good.
create or replace function public.gf_registry_guard() returns trigger
language plpgsql as $$
declare mutable text[];
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are never deleted', tg_table_name using errcode = '42501';
  end if;
  mutable := case tg_table_name
               when 'organisations' then array['name']
               when 'sites' then array['name', 'country']
               when 'halls' then array['label']
               else array[]::text[] end;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'a row of % cannot change except its name: its organisation, data origin, creator and time are fixed', tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists organisations_guard on public.organisations;
create trigger organisations_guard before update or delete on public.organisations
  for each row execute function public.gf_registry_guard();
drop trigger if exists sites_guard on public.sites;
create trigger sites_guard before update or delete on public.sites
  for each row execute function public.gf_registry_guard();
drop trigger if exists halls_guard on public.halls;
create trigger halls_guard before update or delete on public.halls
  for each row execute function public.gf_registry_guard();

-- A membership is closed, never edited, deleted or reopened; and closing the last active owner is refused HERE, so a caller that
-- skips the function cannot leave an organisation that nobody can administer. The organisation's row is locked first, so two owners
-- removing each other at the same moment are serialised and the second one sees the first.
create or replace function public.gf_org_member_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'organisation_members rows are never deleted; close the membership (removed_at)' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'removed_at' - 'removed_by') is distinct from (to_jsonb(old) - 'removed_at' - 'removed_by') then
    raise exception 'a membership''s identity cannot change (organisation, address, role, who added it, when)' using errcode = '42501';
  end if;
  if old.removed_at is not null then
    if new.removed_at is distinct from old.removed_at or new.removed_by is distinct from old.removed_by then
      raise exception 'a removed membership cannot be restored; add the person again' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.removed_at is not null and old.role = 'owner' then
    perform 1 from public.organisations where id = old.org_id for update;
    if not exists (select 1 from public.organisation_members
                    where org_id = old.org_id and role = 'owner' and removed_at is null and id <> old.id) then
      raise exception 'the last owner of an organisation cannot be removed' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists organisation_members_guard on public.organisation_members;
create trigger organisation_members_guard before update or delete on public.organisation_members
  for each row execute function public.gf_org_member_guard();

-- No TRUNCATE, by anyone (gf_append_only, 0015; the pattern of 0040).
do $$
declare t text;
begin
  foreach t in array array['organisations', 'organisation_members', 'sites', 'halls'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.gf_append_only()',
                   t || '_no_truncate', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D. Who is the actor in this organisation?
-- ---------------------------------------------------------------------------
create or replace function public.gf_org_role(p_org uuid, p_actor text) returns text
language sql stable as $$
  select role from public.organisation_members
   where org_id = p_org and email = public.gf_registry_email(p_actor) and removed_at is null
$$;

-- One door for every function: 'ok', or the reason the actor is turned away. `not_a_member` is what a stranger gets for an
-- organisation that exists; `not_found` is for an id that names nothing.
create or replace function public.gf_org_access(p_org uuid, p_actor text, p_min text) returns text
language plpgsql stable as $$
declare r text;
begin
  if public.gf_registry_email(p_actor) is null then return 'invalid_actor'; end if;
  if p_org is null or not exists (select 1 from public.organisations where id = p_org) then return 'not_found'; end if;
  r := public.gf_org_role(p_org, p_actor);
  if r is null then return 'not_a_member'; end if;
  if public.gf_registry_rank(r) < public.gf_registry_rank(p_min) then return 'forbidden'; end if;
  return 'ok';
end
$$;

-- ---------------------------------------------------------------------------
-- E. Organisations and members
-- ---------------------------------------------------------------------------
create or replace function public.gf_create_org(p_actor text, p_name text) returns jsonb
language plpgsql as $$
declare
  a text := public.gf_registry_email(p_actor);
  n text := public.gf_registry_trim(p_name);
  o public.organisations;
begin
  if a is null then return jsonb_build_object('ok', false, 'reason', 'invalid_actor'); end if;
  if not public.gf_registry_name_ok(n) then return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
  -- One person does not register organisations without bound. Serialised per person so two requests cannot both take the last place.
  perform pg_advisory_xact_lock(hashtextextended('gf_create_org:' || a, 0));
  if (select count(*) from public.organisations where created_by = a) >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  begin
    insert into public.organisations (name, created_by) values (n, a) returning * into o;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end;
  insert into public.organisation_members (org_id, email, role, added_by) values (o.id, a, 'owner', a);
  return jsonb_build_object('ok', true, 'org_id', o.id, 'name', o.name);
end
$$;

create or replace function public.gf_my_orgs(p_actor text) returns jsonb
language plpgsql stable as $$
declare a text := public.gf_registry_email(p_actor);
begin
  if a is null then return jsonb_build_object('ok', false, 'reason', 'invalid_actor'); end if;
  return jsonb_build_object('ok', true, 'orgs', coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role, 'created_at', o.created_at, 'member_id', m.id, 'added_by', m.added_by,
                                        'added_at', m.added_at) order by lower(o.name), o.id)
      from public.organisation_members m join public.organisations o on o.id = m.org_id
     where m.email = a and m.removed_at is null), '[]'::jsonb));
end
$$;

create or replace function public.gf_org_members(p_actor text, p_org uuid) returns jsonb
language plpgsql stable as $$
declare g text := public.gf_org_access(p_org, p_actor, 'viewer');
begin
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'email', m.email, 'role', m.role, 'added_by', m.added_by, 'added_at', m.added_at)
                     order by m.added_at, m.id)
      from public.organisation_members m where m.org_id = p_org and m.removed_at is null), '[]'::jsonb));
end
$$;

create or replace function public.gf_org_add_member(p_actor text, p_org uuid, p_email text, p_role text) returns jsonb
language plpgsql as $$
declare
  g text := public.gf_org_access(p_org, p_actor, 'owner');
  e text := public.gf_registry_email(p_email);
  new_id uuid;
begin
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  if e is null then return jsonb_build_object('ok', false, 'reason', 'invalid_email'); end if;
  if p_role is null or p_role not in ('owner', 'editor', 'viewer') then return jsonb_build_object('ok', false, 'reason', 'invalid_role'); end if;
  perform 1 from public.organisations where id = p_org for update;
  if (select count(*) from public.organisation_members where org_id = p_org and removed_at is null) >= 100 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  begin
    insert into public.organisation_members (org_id, email, role, added_by)
    values (p_org, e, p_role, public.gf_registry_email(p_actor)) returning organisation_members.id into new_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end;
  return jsonb_build_object('ok', true, 'member_id', new_id);
end
$$;

-- An owner removes anyone; anyone may remove THEMSELVES. The last owner cannot be removed by either.
create or replace function public.gf_org_remove_member(p_actor text, p_org uuid, p_member uuid) returns jsonb
language plpgsql as $$
declare
  g text := public.gf_org_access(p_org, p_actor, 'viewer');
  a text := public.gf_registry_email(p_actor);
  m public.organisation_members;
begin
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  perform 1 from public.organisations where id = p_org for update;
  select * into m from public.organisation_members where id = p_member and org_id = p_org and removed_at is null;
  if m.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if m.email <> a and public.gf_org_role(p_org, a) <> 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if m.role = 'owner' and not exists (select 1 from public.organisation_members
                                       where org_id = p_org and role = 'owner' and removed_at is null and id <> m.id) then
    return jsonb_build_object('ok', false, 'reason', 'last_owner');
  end if;
  update public.organisation_members set removed_at = now(), removed_by = a where id = m.id;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- F. Sites and halls
-- ---------------------------------------------------------------------------
create or replace function public.gf_create_site(p_actor text, p_org uuid, p_name text, p_country text, p_data_origin text) returns jsonb
language plpgsql as $$
declare
  g text := public.gf_org_access(p_org, p_actor, 'editor');
  n text := public.gf_registry_trim(p_name);
  c text := case when p_country is null then null else upper(btrim(p_country)) end;
  s public.sites;
begin
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  if not public.gf_registry_name_ok(n) then return jsonb_build_object('ok', false, 'reason', 'invalid_name'); end if;
  if c is not null and c !~ '^[A-Z]{2}$' then return jsonb_build_object('ok', false, 'reason', 'invalid_country'); end if;
  if p_data_origin is null or p_data_origin not in ('production', 'test', 'synthetic') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_data_origin');
  end if;
  perform 1 from public.organisations where id = p_org for update;
  if (select count(*) from public.sites where org_id = p_org) >= 200 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  begin
    insert into public.sites (org_id, name, country, data_origin, created_by)
    values (p_org, n, c, p_data_origin, public.gf_registry_email(p_actor)) returning * into s;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end;
  return jsonb_build_object('ok', true, 'site_id', s.id,
    'site', jsonb_build_object('id', s.id, 'org_id', s.org_id, 'name', s.name, 'country', s.country, 'data_origin', s.data_origin,
                               'created_by', s.created_by, 'created_at', s.created_at, 'halls', '[]'::jsonb));
end
$$;

-- The sites of ONE organisation the actor belongs to, or (no organisation given) of every organisation they belong to.
create or replace function public.gf_list_sites(p_actor text, p_org uuid default null) returns jsonb
language plpgsql stable as $$
declare
  a text := public.gf_registry_email(p_actor);
  g text;
begin
  if p_org is not null then
    g := public.gf_org_access(p_org, p_actor, 'viewer');
    if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  elsif a is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_actor');
  end if;
  return jsonb_build_object('ok', true, 'sites', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'org_id', s.org_id, 'org_name', o.name, 'name', s.name, 'country', s.country,
                                        'data_origin', s.data_origin, 'created_by', s.created_by, 'created_at', s.created_at,
                                        'halls', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'site_id', h.site_id, 'label', h.label, 'created_by', h.created_by,
                                                                                               'created_at', h.created_at) order by lower(h.label), h.id)
                                                             from public.halls h where h.site_id = s.id), '[]'::jsonb))
                     order by lower(o.name), lower(s.name), s.id)
      from public.sites s
      join public.organisations o on o.id = s.org_id
      join public.organisation_members m on m.org_id = s.org_id and m.email = a and m.removed_at is null
     where p_org is null or s.org_id = p_org), '[]'::jsonb));
end
$$;

create or replace function public.gf_create_hall(p_actor text, p_site uuid, p_label text) returns jsonb
language plpgsql as $$
declare
  s public.sites;
  g text;
  l text := public.gf_registry_trim(p_label);
  h public.halls;
begin
  select * into s from public.sites where id = p_site;
  g := public.gf_org_access(s.org_id, p_actor, 'editor');          -- a null org (no such site) answers not_found
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  if not public.gf_registry_name_ok(l) then return jsonb_build_object('ok', false, 'reason', 'invalid_label'); end if;
  perform 1 from public.sites where id = s.id for update;
  if (select count(*) from public.halls where site_id = s.id) >= 200 then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  begin
    insert into public.halls (site_id, label, created_by) values (s.id, l, public.gf_registry_email(p_actor)) returning * into h;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'label_taken');
  end;
  return jsonb_build_object('ok', true, 'hall_id', h.id,
    'hall', jsonb_build_object('id', h.id, 'site_id', h.site_id, 'label', h.label, 'created_by', h.created_by, 'created_at', h.created_at));
end
$$;

create or replace function public.gf_list_halls(p_actor text, p_site uuid) returns jsonb
language plpgsql stable as $$
declare
  s public.sites;
  g text;
begin
  select * into s from public.sites where id = p_site;
  g := public.gf_org_access(s.org_id, p_actor, 'viewer');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;
  return jsonb_build_object(
    'ok', true,
    'site', jsonb_build_object('id', s.id, 'org_id', s.org_id, 'name', s.name, 'country', s.country, 'data_origin', s.data_origin),
    'halls', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'site_id', h.site_id, 'label', h.label, 'created_by', h.created_by,
                                                           'created_at', h.created_at) order by lower(h.label), h.id)
                         from public.halls h where h.site_id = s.id), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- G. Service role only, at the table and the function layer (see 0020, 0027, 0040)
-- ---------------------------------------------------------------------------
alter table public.organisations enable row level security;
alter table public.organisation_members enable row level security;
alter table public.sites enable row level security;
alter table public.halls enable row level security;
-- No policies: the service role reaches these through app/api, which identifies the caller first.

do $$
declare f text; r text; t text;
begin
  -- Trigger functions are not an API: nothing should reach them through PostgREST's /rpc (the convention of 0044). A trigger runs
  -- without EXECUTE being checked for the role that fires it, so the service role's writes are unaffected.
  foreach f in array array['public.gf_registry_guard()', 'public.gf_org_member_guard()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;

  foreach t in array array['organisations', 'organisation_members', 'sites', 'halls'] loop
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
      execute format('revoke truncate on public.%I from service_role', t);
    end if;
  end loop;

  for f in select unnest(array[
      'public.gf_registry_email(text)',
      'public.gf_registry_text_bad(text)',
      'public.gf_registry_trim(text)',
      'public.gf_registry_name_ok(text)',
      'public.gf_registry_rank(text)',
      'public.gf_org_role(uuid, text)',
      'public.gf_org_access(uuid, text, text)',
      'public.gf_create_org(text, text)',
      'public.gf_my_orgs(text)',
      'public.gf_org_members(text, uuid)',
      'public.gf_org_add_member(text, uuid, text, text)',
      'public.gf_org_remove_member(text, uuid, uuid)',
      'public.gf_create_site(text, uuid, text, text, text)',
      'public.gf_list_sites(text, uuid)',
      'public.gf_create_hall(text, uuid, text)',
      'public.gf_list_halls(text, uuid)']) loop
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
