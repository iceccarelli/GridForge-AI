-- 0050_hall_inputs.sql: what is CLAIMED about a hall, one figure at a time, each with its origin, its evidence class and its source.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Requires 0049 (sites and halls), 0015
-- (projects, project_evidence) and 0044 (intake_evidence_files). Nothing in the application needs the tables until a signed-in
-- editor records a figure on /account/sites; until then the routes answer 503.
--
-- The same hall data was typed again into qualifications, intakes, watches (overwritten in place), BTM cases, projects and scenarios.
-- Here a figure is written ONCE, never overwritten, and says what kind of figure it is.
--
--   hall_inputs              APPEND-ONLY. One row per claim: field_path ('grid.firm_capacity_MVA', 'transformers[0].unit_rating_MVA': the
--                            intake's own paths), the value, its unit, the evidence class E0..E7, the ORIGIN, an optional source file, the
--                            date the figure is "as of" and who recorded it. A correction is a NEW row that supersedes exactly one earlier
--                            row of the same hall and field; the earlier row stays.
--   hall_inputs_current      the latest, non-superseded row per (hall, field): what is believed now.
--   hall_project_attachments / hall_project_detachments   APPEND-ONLY. Which project (an anonymous, token-addressed engagement, 0015) was attached to
--                            which hall, by whom, when; and who took it out. At most one attachment of a project is open at a time.
--   projects.site_id / hall_id   nullable, additive: set only by gf_attach_project_to_hall, never moved.
--
-- ORIGIN is a different axis from the engine's evidence CLASS (E0..E7, an ordinal of what has been done to a number: lib/evidence-classes.ts).
-- It says where a figure came from, and the database refuses to let a declared figure pass for a measured one:
--   measured | observed | quotation   REQUIRE a source file (exactly one: a project file or a purchased engagement's intake file).
--   vendor                            a supplier's declared figure; a file is welcome and not required.
--   modelled | assumed                may not claim a class above E3 (E0 assumption, E1 model, E2 simulation, E3 engineering estimate = model +
--                                     review). E4 is "compared against test data", E5 "the customer's own measured data", E6 "reconciled against
--                                     the site", E7 "observed in operation": every one of those needs data that a model or an assumption is not.
--   missing                           the honest record of an unknown: NO value, NO source, class E0. Never blank, never a zero.
-- What the database does NOT do: it does not certify that a sourced figure's class is deserved. A class above E3 on a measured, observed or
-- quoted figure is the recorder's declaration beside a file; the file's own review status (project_evidence.review_status) is shown beside it,
-- and a rejected file cannot be cited at all.
--
-- VALUE is jsonb, limited to a finite number (|x| <= 1e15), a short string or a boolean (or SQL NULL for 'missing'), not a bare numeric: intake
-- paths include text ('busway') and booleans next to quantities. A unit belongs only to a number (or to a missing figure, which names what is missing).
--
-- SOURCES. Two evidence tables exist and a column can reference only one, so there are two nullable columns and a CHECK that at most one is set
-- (and exactly one for measured / observed / quotation). A project file counts only if its project is attached to THIS hall; an intake file only
-- if the engagement was bought by the person recording. A figure cannot cite another organisation's evidence.
--
-- Corrections, reviews and what a class means here:
--   * DECLARED class. The class on a row is what the recorder declared. For a figure that cites a file, a class above E3 needs that file to be a project
--     file whose review_status is 'verified' AT THE TIME OF WRITING (hall_inputs_unreviewed_source); an unreviewed file, a rejected one, or an intake file
--     (a purchased engagement's document, which has no review step: "not reviewable") supports at most E3. A 'vendor' figure with no file is also capped at
--     E3. The file's review status can change later; reads show its LIVE status beside the declared class, and never rewrite the class.
--   * Limits per hall: 500 distinct fields, and at most 50 rows (the first claim and its corrections) per field, so a read and a history stay bounded.
--   * Field paths are stored lower case (the intake's own paths read grid.firm_capacity_mva here): two spellings are one field. Units use a conservative
--     alphabet (letters, digits and % / . _ ^ * + ( ) space - and the signs micro, degree, superscript 2 and 3, middle dot, ohm).
--
-- OPERATOR NOTES (see 0049 for the long form): run in a session with `set lock_timeout = '5s';` (this file alters public.projects, which takes a short
-- ACCESS EXCLUSIVE lock for the two new columns and the trigger, and rebuilds project_events_event_type_check, which re-validates that table once);
-- email addresses are written to append-only tables here too (recorded_by, attached_by, detached_by), so erasure is an owner decision.
--
-- WHO MAY ATTACH. projects carries NO buyer email (only a company name), so the database cannot say whose a project is. The project's link token remains
-- the ONLY credential for attaching it, as it is for everything else about that engagement (0015). What this adds around it: the attachment is no longer
-- silent and permanent. The project's own log gets a project_attached_to_hall event (no address in it), an owner of the hall's organisation can detach
-- (gf_detach_project_from_hall, recorded, with its own event), the hall's timeline stops showing the project's log from then on, and the history of every
-- attach and detach is kept. A project goes into another hall only after it has been detached.
--
-- Additive and idempotent. RLS on, no policies (service role only); no TRUNCATE; no existing row is touched.

-- ---------------------------------------------------------------------------
-- A. projects.site_id / hall_id
-- ---------------------------------------------------------------------------
alter table public.projects add column if not exists site_id uuid;
alter table public.projects add column if not exists hall_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_hall_both_or_neither' and conrelid = 'public.projects'::regclass) then
    alter table public.projects add constraint projects_hall_both_or_neither check ((site_id is null) = (hall_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_hall_pair' and conrelid = 'public.projects'::regclass) then
    -- The pair must name a hall OF that site. (MATCH SIMPLE: a project with both null is not checked.)
    alter table public.projects add constraint projects_hall_pair foreign key (site_id, hall_id) references public.halls (site_id, id);
  end if;
end
$$;

create index if not exists projects_hall_idx on public.projects (hall_id) where (hall_id is not null);

-- ---------------------------------------------------------------------------
-- B. Attachments and detachments: who put which project in which hall, and who took it out
-- ---------------------------------------------------------------------------
-- Over time a project can be in a hall, out of it, and in another: one attachment row per time it went in, one detachment row per time it came out.
-- Neither table is ever edited. At most ONE attachment of a project is open (has no detachment) at any moment.
create table if not exists public.hall_project_attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  site_id uuid not null,
  hall_id uuid not null,
  attached_by text not null check (attached_by = lower(btrim(attached_by)) and position('@' in attached_by) > 1),
  attached_at timestamptz not null default now(),
  constraint hall_project_attachments_hall_pair foreign key (site_id, hall_id) references public.halls (site_id, id),
  -- the triple a detachment must name, so it cannot close an attachment of another project or hall
  constraint hall_project_attachments_triple unique (id, project_id, hall_id)
);

create index if not exists hall_project_attachments_hall_idx on public.hall_project_attachments (hall_id);
create index if not exists hall_project_attachments_project_idx on public.hall_project_attachments (project_id);

create table if not exists public.hall_project_detachments (
  id uuid primary key default gen_random_uuid(),
  -- UNIQUE: an attachment is closed once.
  attachment_id uuid not null unique,
  project_id uuid not null references public.projects (id),
  site_id uuid not null,
  hall_id uuid not null,
  detached_by text not null check (detached_by = lower(btrim(detached_by)) and position('@' in detached_by) > 1),
  detached_at timestamptz not null default now(),
  constraint hall_project_detachments_attachment foreign key (attachment_id, project_id, hall_id) references public.hall_project_attachments (id, project_id, hall_id),
  constraint hall_project_detachments_hall_pair foreign key (site_id, hall_id) references public.halls (site_id, id)
);

create index if not exists hall_project_detachments_hall_idx on public.hall_project_detachments (hall_id);

-- A project that is already in a hall cannot be attached again until it has been detached, whoever calls (the project row is locked first, so two
-- racing attachments are serialised and the second sees the first).
create or replace function public.gf_attachment_guard() returns trigger
language plpgsql as $$
begin
  perform 1 from public.projects where id = new.project_id for update;
  if exists (select 1 from public.hall_project_attachments a
              where a.project_id = new.project_id
                and not exists (select 1 from public.hall_project_detachments d where d.attachment_id = a.id)) then
    raise exception 'that project is already attached to a hall; detach it first' using errcode = '23505';
  end if;
  return new;
end
$$;

drop trigger if exists hall_project_attachments_guard on public.hall_project_attachments;
create trigger hall_project_attachments_guard before insert on public.hall_project_attachments
  for each row execute function public.gf_attachment_guard();

-- A project is given a hall only through an OPEN recorded attachment, and leaves one only through a recorded detachment. It never moves from one
-- hall to another in a single step. A project is created without a hall.
create or replace function public.gf_project_hall_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.hall_id is not null or new.site_id is not null then
      raise exception 'a project is created without a hall; attach it with a recorded attachment (gf_attach_project_to_hall)' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.hall_id is not null then
    if new.hall_id is distinct from old.hall_id or new.site_id is distinct from old.site_id then
      -- Leaving (both null) is allowed once every attachment of the project has been closed by a detachment; anything else is a move.
      if new.hall_id is null and new.site_id is null
         and (select count(*) from public.hall_project_detachments where project_id = old.id)
           = (select count(*) from public.hall_project_attachments where project_id = old.id) then
        return new;
      end if;
      raise exception 'a project that belongs to a hall cannot move to another hall or leave it except through a recorded detachment' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.hall_id is not null and new.site_id is not null
     and not exists (select 1 from public.hall_project_attachments a
                      where a.project_id = new.id and a.hall_id = new.hall_id and a.site_id = new.site_id
                        and not exists (select 1 from public.hall_project_detachments d where d.attachment_id = a.id)) then
    raise exception 'a project can only be given a hall through a recorded attachment (gf_attach_project_to_hall)' using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists projects_hall_guard on public.projects;
create trigger projects_hall_guard before insert or update on public.projects
  for each row execute function public.gf_project_hall_guard();

drop trigger if exists hall_project_attachments_append_only on public.hall_project_attachments;
create trigger hall_project_attachments_append_only before update or delete on public.hall_project_attachments
  for each row execute function public.gf_append_only();
drop trigger if exists hall_project_attachments_no_truncate on public.hall_project_attachments;
create trigger hall_project_attachments_no_truncate before truncate on public.hall_project_attachments
  for each statement execute function public.gf_append_only();
drop trigger if exists hall_project_detachments_append_only on public.hall_project_detachments;
create trigger hall_project_detachments_append_only before update or delete on public.hall_project_detachments
  for each row execute function public.gf_append_only();
drop trigger if exists hall_project_detachments_no_truncate on public.hall_project_detachments;
create trigger hall_project_detachments_no_truncate before truncate on public.hall_project_detachments
  for each statement execute function public.gf_append_only();

-- The project's own log says it was attached and detached, so the people who hold the project's link are told. project_events_event_type_check is
-- REBUILT as the UNION of what it allows now and the two new types, read from the catalog (the same pattern whatever order the migrations that
-- extend it are applied in: no type already allowed is dropped).
do $$
declare def text; have text[]; want text[] := array['project_attached_to_hall', 'project_detached_from_hall'];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'project_events_event_type_check' and c.conrelid = 'public.project_events'::regclass;
  select coalesce(array_agg(distinct m[1]), '{}') into have from regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g') as m;
  select array_agg(distinct t order by t) into have from unnest(have || want) as t;
  alter table public.project_events drop constraint if exists project_events_event_type_check;
  execute format('alter table public.project_events add constraint project_events_event_type_check check (event_type in (%s))',
                 (select string_agg(quote_literal(t), ', ' order by t) from unnest(have) as t));
end
$$;

-- ---------------------------------------------------------------------------
-- C. hall_inputs
-- ---------------------------------------------------------------------------
create table if not exists public.hall_inputs (
  id uuid primary key default gen_random_uuid(),
  -- The order claims were recorded in (the clock can repeat inside one transaction; this cannot).
  seq bigint generated always as identity,
  hall_id uuid not null references public.halls (id),
  field_path text not null,
  value jsonb,
  unit text,
  evidence_class text not null,
  origin text not null,
  project_evidence_id uuid references public.project_evidence (id),
  intake_evidence_file_id uuid references public.intake_evidence_files (id),
  as_of date not null,
  recorded_by text not null check (recorded_by = lower(btrim(recorded_by)) and position('@' in recorded_by) > 1 and length(recorded_by) <= 254),
  supersedes_id uuid references public.hall_inputs (id),
  created_at timestamptz not null default now(),

  constraint hall_inputs_field_path check (
    length(field_path) <= 120
    and field_path ~ '^[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?(\.[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?){0,5}$'),
  constraint hall_inputs_evidence_class check (evidence_class in ('E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7')),
  constraint hall_inputs_origin check (origin in ('measured', 'observed', 'vendor', 'quotation', 'modelled', 'assumed', 'missing')),
  -- A finite, bounded number, a short string or a boolean. (jsonb has no NaN or Infinity; a JSON null is refused: an unknown is origin 'missing'.)
  constraint hall_inputs_value_shape check (
    value is null
    or case jsonb_typeof(value)
         when 'number' then abs((value #>> '{}')::numeric) <= 1e15
         when 'string' then length(value #>> '{}') between 1 and 200
         when 'boolean' then true
         else false end),
  constraint hall_inputs_unit check (
    unit is null
    or (length(unit) between 1 and 24
        -- a conservative alphabet: letters, digits, % / . _ ^ * + ( ) space -, and the signs micro, degree, superscript 2 and 3, middle dot, ohm
        and unit ~ '^[A-Za-z0-9%/._^*+() \u00b5\u00b0\u00b2\u00b3\u00b7\u03a9-]+$'
        and (value is null or jsonb_typeof(value) = 'number'))),
  -- 'missing' is exactly "no value", has no source, and is class E0; any other origin has a value.
  constraint hall_inputs_missing_shape check (
    (origin = 'missing') = (value is null)
    and (origin <> 'missing' or (evidence_class = 'E0' and project_evidence_id is null and intake_evidence_file_id is null))),
  constraint hall_inputs_one_source check (num_nonnulls(project_evidence_id, intake_evidence_file_id) <= 1),
  constraint hall_inputs_origin_source check (
    origin not in ('measured', 'observed', 'quotation') or num_nonnulls(project_evidence_id, intake_evidence_file_id) = 1),
  -- A supplier's own figure with no file behind it is at most an estimate.
  constraint hall_inputs_vendor_class check (
    origin <> 'vendor' or evidence_class in ('E0', 'E1', 'E2', 'E3') or num_nonnulls(project_evidence_id, intake_evidence_file_id) = 1),
  constraint hall_inputs_assumed_class check (
    origin not in ('assumed', 'modelled') or evidence_class in ('E0', 'E1', 'E2', 'E3')),
  constraint hall_inputs_as_of check (as_of >= date '1990-01-01')
);

-- A correction is a line, not a tree: one first claim per (hall, field), and each claim is replaced at most once. Two people correcting the
-- same figure at the same moment cannot both land; the second is told to look again.
create unique index if not exists hall_inputs_one_root on public.hall_inputs (hall_id, field_path) where supersedes_id is null;
create unique index if not exists hall_inputs_one_successor on public.hall_inputs (supersedes_id) where supersedes_id is not null;
create index if not exists hall_inputs_hall_idx on public.hall_inputs (hall_id, seq);
create index if not exists hall_inputs_field_idx on public.hall_inputs (hall_id, field_path);

-- What the table checks on the way in that a CHECK cannot (it reads other tables, or the clock).
create or replace function public.gf_hall_input_guard() returns trigger
language plpgsql as $$
declare
  org uuid;
  prev public.hall_inputs;
  pe public.project_evidence;
  ie_email text;
begin
  if new.as_of > current_date + 1 then
    raise exception 'hall_inputs_as_of_future: a figure cannot be as of a date in the future (%)', new.as_of
      using errcode = '23514', constraint = 'hall_inputs_as_of_future';
  end if;

  -- The recorder must be an editor or owner of the organisation the hall belongs to, whatever called the database.
  select s.org_id into org from public.halls h join public.sites s on s.id = h.site_id where h.id = new.hall_id;
  if org is null or public.gf_registry_rank(public.gf_org_role(org, new.recorded_by)) < public.gf_registry_rank('editor') then
    raise exception 'the recorder is not an editor or owner of this hall''s organisation' using errcode = '42501';
  end if;

  -- Bounds per hall, taken under a per-hall lock so two writers cannot both take the last place: 500 distinct fields, and 50 rows (a claim and its
  -- corrections) per field.
  perform pg_advisory_xact_lock(hashtextextended('hall_inputs:' || new.hall_id::text, 0));
  if new.supersedes_id is null then
    if not exists (select 1 from public.hall_inputs x where x.hall_id = new.hall_id and x.field_path = new.field_path and x.supersedes_id is null)
       and (select count(*) from public.hall_inputs x where x.hall_id = new.hall_id and x.supersedes_id is null) >= 500 then
      raise exception 'hall_inputs_field_limit: a hall holds at most 500 distinct fields' using errcode = '23514', constraint = 'hall_inputs_field_limit';
    end if;
  elsif (select count(*) from public.hall_inputs x where x.hall_id = new.hall_id and x.field_path = new.field_path) >= 50 then
    raise exception 'hall_inputs_correction_limit: a field holds at most 50 claims (the first and its corrections)' using errcode = '23514', constraint = 'hall_inputs_correction_limit';
  end if;

  -- A correction names an earlier claim of the SAME hall and field. (A reference to nothing is left to the foreign key.)
  if new.supersedes_id is not null then
    select * into prev from public.hall_inputs where id = new.supersedes_id;
    if found and (prev.hall_id <> new.hall_id or prev.field_path <> new.field_path) then
      raise exception 'hall_inputs_supersedes_scope: a correction must supersede an input of the same hall and the same field'
        using errcode = '23514', constraint = 'hall_inputs_supersedes_scope';
    end if;
  end if;

  if new.project_evidence_id is not null then
    select * into pe from public.project_evidence where id = new.project_evidence_id;
    if found then
      if not exists (select 1 from public.projects p where p.id = pe.project_id and p.hall_id = new.hall_id) then
        raise exception 'hall_inputs_source_not_in_hall: that file does not belong to a project attached to this hall'
          using errcode = '23514', constraint = 'hall_inputs_source_not_in_hall';
      end if;
      if pe.review_status = 'rejected' then
        raise exception 'hall_inputs_source_rejected: that file was reviewed and rejected'
          using errcode = '23514', constraint = 'hall_inputs_source_rejected';
      end if;
      -- A DECLARED class above E3 needs a file that has been reviewed and verified (its status can change later; the read shows the live one).
      if new.evidence_class > 'E3' and pe.review_status <> 'verified' then
        raise exception 'hall_inputs_unreviewed_source: a class above E3 needs a source file that has been reviewed and verified; declare E3 or lower until then'
          using errcode = '23514', constraint = 'hall_inputs_unreviewed_source';
      end if;
    end if;
  end if;

  if new.intake_evidence_file_id is not null then
    select lower(btrim(d.email)) into ie_email
      from public.intake_evidence_files f join public.deliverables d on d.id = f.deliverable_id
     where f.id = new.intake_evidence_file_id;
    if found and ie_email is distinct from new.recorded_by then
      raise exception 'hall_inputs_source_not_yours: that file belongs to an engagement bought by someone else'
        using errcode = '23514', constraint = 'hall_inputs_source_not_yours';
    end if;
    -- A purchased engagement's file has no review step ("not reviewable"): it supports a declared class of E3 at most.
    if found and new.evidence_class > 'E3' and new.project_evidence_id is null then   -- (two sources at once is the one_source CHECK's refusal)
      raise exception 'hall_inputs_unreviewed_source: a purchased engagement''s file is not reviewable, so it supports a declared class of E3 at most'
        using errcode = '23514', constraint = 'hall_inputs_unreviewed_source';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists hall_inputs_guard on public.hall_inputs;
create trigger hall_inputs_guard before insert on public.hall_inputs
  for each row execute function public.gf_hall_input_guard();

drop trigger if exists hall_inputs_append_only on public.hall_inputs;
create trigger hall_inputs_append_only before update or delete on public.hall_inputs
  for each row execute function public.gf_append_only();
drop trigger if exists hall_inputs_no_truncate on public.hall_inputs;
create trigger hall_inputs_no_truncate before truncate on public.hall_inputs
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- D. Views: every claim with its source LABEL (never a storage location or a digest), and the current one
-- ---------------------------------------------------------------------------
create or replace view public.hall_inputs_labelled with (security_invoker = true) as
select i.id, i.seq, i.hall_id, i.field_path, i.value, i.unit, i.evidence_class, i.origin, i.as_of, i.recorded_by, i.created_at, i.supersedes_id,
       exists (select 1 from public.hall_inputs s where s.supersedes_id = i.id) as superseded,
       case when i.project_evidence_id is not null then 'project_evidence'
            when i.intake_evidence_file_id is not null then 'intake_evidence' end as source_kind,
       coalesce(i.project_evidence_id, i.intake_evidence_file_id) as source_id,
       coalesce(pe.filename, ie.filename) as source_filename,
       pe.review_status as source_review_status
  from public.hall_inputs i
  left join public.project_evidence pe on pe.id = i.project_evidence_id
  left join public.intake_evidence_files ie on ie.id = i.intake_evidence_file_id;

create or replace view public.hall_inputs_current with (security_invoker = true) as
select l.* from public.hall_inputs_labelled l where not l.superseded;

-- ---------------------------------------------------------------------------
-- E. Functions
-- ---------------------------------------------------------------------------
-- One claim as the API shows it: the label of its source (a name and a LIVE review status, never a storage location or a digest).
create or replace function public.gf_hall_input_json(l public.hall_inputs_labelled) returns jsonb
language sql stable as $$
  select jsonb_build_object(
           'id', l.id, 'field_path', l.field_path, 'value', l.value, 'unit', l.unit, 'evidence_class', l.evidence_class,
           'origin', l.origin, 'as_of', l.as_of, 'recorded_by', l.recorded_by, 'recorded_at', l.created_at,
           'supersedes_id', l.supersedes_id, 'superseded', l.superseded,
           'source', case when l.source_kind is null then null
                          else jsonb_build_object('kind', l.source_kind, 'id', l.source_id, 'filename', l.source_filename,
                                                  'review_status', l.source_review_status) end)
$$;

create or replace function public.gf_record_hall_input(
  p_actor text, p_hall uuid, p_field_path text, p_value jsonb, p_unit text, p_evidence_class text, p_origin text,
  p_project_evidence uuid, p_intake_evidence uuid, p_as_of date, p_supersedes uuid default null
) returns jsonb
language plpgsql as $$
declare
  h public.halls;
  s public.sites;
  g text;
  r public.hall_inputs;
  con text;
  cur uuid;
  path text := lower(btrim(coalesce(p_field_path, '')));
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'editor');          -- no such hall: s.org_id is null: not_found
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  begin
    insert into public.hall_inputs (hall_id, field_path, value, unit, evidence_class, origin, project_evidence_id, intake_evidence_file_id,
                                    as_of, recorded_by, supersedes_id)
    values (h.id, path, p_value, p_unit, p_evidence_class, p_origin, p_project_evidence, p_intake_evidence,
            p_as_of, public.gf_registry_email(p_actor), p_supersedes)
    returning * into r;
  exception
    when check_violation then
      get stacked diagnostics con = constraint_name;
      return jsonb_build_object('ok', false, 'constraint', con, 'reason', case
        -- A file or an earlier figure that cannot be used has ONE answer, whatever the reason, so the answer is no oracle for another organisation's ids.
        when con in ('hall_inputs_source_not_in_hall', 'hall_inputs_source_not_yours', 'hall_inputs_supersedes_scope') then 'invalid_reference'
        when con = 'hall_inputs_source_rejected' then 'source_rejected'
        when con = 'hall_inputs_field_limit' then 'field_limit'
        when con = 'hall_inputs_correction_limit' then 'correction_limit'
        else 'invalid_input' end);
    when numeric_value_out_of_range then
      return jsonb_build_object('ok', false, 'reason', 'invalid_input', 'constraint', 'hall_inputs_value_shape');
    when not_null_violation then
      get stacked diagnostics con = column_name;
      return jsonb_build_object('ok', false, 'reason', 'invalid_input', 'constraint', 'hall_inputs_' || coalesce(con, 'required'));
    when foreign_key_violation then
      get stacked diagnostics con = constraint_name;
      return jsonb_build_object('ok', false, 'reason', 'invalid_reference', 'constraint', con);
    when unique_violation then
      get stacked diagnostics con = constraint_name;
      select c.id into cur from public.hall_inputs_current c where c.hall_id = h.id and c.field_path = path;
      return jsonb_build_object('ok', false, 'constraint', con, 'current_id', cur,
                                'reason', case con when 'hall_inputs_one_successor' then 'superseded' else 'field_already_recorded' end);
  end;
  return jsonb_build_object('ok', true, 'id', r.id,
                            'input', public.gf_hall_input_json((select l from public.hall_inputs_labelled l where l.id = r.id)));
end
$$;

-- Current inputs of a hall (at most 500: the per-hall limit), or with p_history every claim, NEWEST FIRST, at most p_limit (1..500, default 500) with
-- `truncated` saying more exist; p_field narrows it to one field (at most 50 claims). Any member may read.
create or replace function public.gf_hall_inputs(p_actor text, p_hall uuid, p_history boolean default false, p_field text default null, p_limit int default 500) returns jsonb
language plpgsql stable as $$
declare
  h public.halls;
  s public.sites;
  g text;
  lim int := least(greatest(coalesce(p_limit, 500), 1), 500);
  f text := case when p_field is null then null else lower(btrim(p_field)) end;
  rows jsonb;
  n int;
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'viewer');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  with q as (
    select l, row_number() over (order by case when p_history then l.seq end desc nulls last, l.field_path, l.seq) as rn
      from public.hall_inputs_labelled l
     where l.hall_id = h.id and (p_history or not l.superseded) and (f is null or l.field_path = f)
  )
  select coalesce(jsonb_agg(public.gf_hall_input_json(q.l) order by q.rn) filter (where q.rn <= lim), '[]'::jsonb), coalesce(max(q.rn), 0)
    into rows, n from q where q.rn <= lim + 1;

  return jsonb_build_object(
    'ok', true,
    'hall', jsonb_build_object('id', h.id, 'label', h.label, 'site_id', s.id, 'site_name', s.name, 'org_id', s.org_id,
                               'data_origin', s.data_origin, 'country', s.country),
    'truncated', n > lim,
    'inputs', rows);
end
$$;

-- Attach a project to a hall, by the project's own link token: the token IS the credential for that engagement (0015), and the database has no buyer
-- address to check it against (see the header). Idempotent for the same hall; refused while the project is in another. Writes the attachment and
-- tells the project through its own log, in one transaction.
create or replace function public.gf_attach_project_to_hall(p_actor text, p_hall uuid, p_project_token text) returns jsonb
language plpgsql as $$
declare
  h public.halls;
  s public.sites;
  g text;
  p public.projects;
  a public.hall_project_attachments;
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'editor');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  select * into p from public.projects where project_token = p_project_token for update;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'project_not_found'); end if;
  if p.hall_id is not null then
    if p.hall_id = h.id then
      return jsonb_build_object('ok', true, 'already_attached', true, 'project_id', p.id, 'project_name', p.project_name);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'project_in_other_hall');
  end if;

  insert into public.hall_project_attachments (project_id, site_id, hall_id, attached_by)
  values (p.id, s.id, h.id, public.gf_registry_email(p_actor)) returning * into a;
  update public.projects set site_id = s.id, hall_id = h.id where id = p.id;
  -- No address in the event: the project's people learn THAT it was attached and to which hall, not by whom.
  perform public.gf_emit(p.id, jsonb_build_object('event_type', 'project_attached_to_hall', 'actor', 'hall_registry',
                                                  'payload', jsonb_build_object('hall_id', h.id, 'site_id', s.id, 'attachment_id', a.id)));
  return jsonb_build_object('ok', true, 'already_attached', false, 'project_id', p.id, 'project_name', p.project_name, 'attachment_id', a.id);
end
$$;

-- An OWNER of the hall's organisation takes a project out of the hall. Recorded (who, when), logged in the project's own log, and the hall's
-- timeline stops showing the project's log from then on; the attachment and this detachment both stay.
create or replace function public.gf_detach_project_from_hall(p_actor text, p_hall uuid, p_project uuid) returns jsonb
language plpgsql as $$
declare
  h public.halls;
  s public.sites;
  g text;
  p public.projects;
  a public.hall_project_attachments;
begin
  select * into h from public.halls where id = p_hall;
  select * into s from public.sites where id = h.site_id;
  g := public.gf_org_access(s.org_id, p_actor, 'owner');
  if g <> 'ok' then return jsonb_build_object('ok', false, 'reason', g); end if;

  select * into p from public.projects where id = p_project for update;
  if p.id is null or p.hall_id is distinct from h.id then return jsonb_build_object('ok', false, 'reason', 'not_attached'); end if;
  select * into a from public.hall_project_attachments x
   where x.project_id = p.id and x.hall_id = h.id and not exists (select 1 from public.hall_project_detachments d where d.attachment_id = x.id)
   order by x.attached_at desc, x.id limit 1;
  if a.id is null then return jsonb_build_object('ok', false, 'reason', 'not_attached'); end if;

  insert into public.hall_project_detachments (attachment_id, project_id, site_id, hall_id, detached_by)
  values (a.id, p.id, s.id, h.id, public.gf_registry_email(p_actor));
  update public.projects set site_id = null, hall_id = null where id = p.id;
  perform public.gf_emit(p.id, jsonb_build_object('event_type', 'project_detached_from_hall', 'actor', 'hall_registry',
                                                  'payload', jsonb_build_object('hall_id', h.id, 'site_id', s.id, 'attachment_id', a.id)));
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- F. Service role only, at the table, the view and the function layer (0020, 0027, 0040, 0044)
-- ---------------------------------------------------------------------------
alter table public.hall_inputs enable row level security;
alter table public.hall_project_attachments enable row level security;
alter table public.hall_project_detachments enable row level security;
-- No policies: the service role reaches these through app/api, which identifies the caller first.

do $$
declare f text; r text; t text;
begin
  foreach f in array array['public.gf_project_hall_guard()', 'public.gf_hall_input_guard()', 'public.gf_attachment_guard()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
  end loop;

  foreach t in array array['hall_inputs', 'hall_project_attachments', 'hall_project_detachments', 'hall_inputs_labelled', 'hall_inputs_current'] loop
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.hall_inputs, public.hall_project_attachments, public.hall_project_detachments to service_role;
    grant select on public.hall_inputs_labelled, public.hall_inputs_current to service_role;
    -- Append-only twice over: the triggers above refuse an UPDATE, DELETE or TRUNCATE from anyone, and the service role is not even granted them.
    revoke update, delete on public.hall_inputs, public.hall_project_attachments, public.hall_project_detachments from service_role;
    revoke truncate on public.hall_inputs, public.hall_project_attachments, public.hall_project_detachments from service_role;
  end if;

  for f in select unnest(array[
      'public.gf_record_hall_input(text, uuid, text, jsonb, text, text, text, uuid, uuid, date, uuid)',
      'public.gf_hall_input_json(public.hall_inputs_labelled)',
      'public.gf_hall_inputs(text, uuid, boolean, text, int)',
      'public.gf_attach_project_to_hall(text, uuid, text)',
      'public.gf_detach_project_from_hall(text, uuid, uuid)']) loop
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
