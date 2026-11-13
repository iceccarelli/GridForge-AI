-- 0056_calibration_publication_gates.sql: four gates an observation must clear BEFORE it is recorded and again before it is published:
-- a completion milestone (D1), an organisation's consent that names its scope and a version of the consent text (D3), a withdrawal that leaves a
-- tombstone and marks what was published as superseded (D5), and a registry of released snapshots that refuses a release which differs too little
-- from an earlier one (R4, the database half; the policy itself is gridforge/calibration/release.py).
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. It needs 0015-0018, 0038, 0046-0053 applied first (it reads
-- organisations, sites and the project's hall attachment from 0049/0050, supplier_actuals from 0018, calibration_ledger_rows from 0052, and replaces
-- that view). Until it is applied nothing changes: the ledger holds 0 observations and no real one may be put in before it is.
--
-- REPLAY ORDER. This migration holds the FINAL calibration_ledger_rows: 0052's definition, read from that file, plus THREE more conditions (below).
-- Re-running 0038, 0046, 0047, 0048 or 0052 AFTER this one silently replaces the view with an older and weaker definition. Migrations are applied
-- once, in order (scripts/apply-migration.py gate 2). tests/test_calibration_final_gate.py reads the FINAL view from a database built by the whole
-- chain and fails if any gate is missing, this one included. gf_submit_observation is NOT redefined here (0053 still holds it): the insert-time gates
-- are a trigger on project_observations, so they bind every way a row can be inserted, not only that function.
--
-- WHAT IS NEW, in one place
--   D3  calibration_consents: an append-only log, per ORGANISATION, of a grant or a withdrawal of consent. A grant names the organisation, the SCOPE
--       (what may be published: today only 'aggregate_residual_statistics', and at what aggregation: the fewest observations and the fewest distinct
--       organisations an aggregate containing the organisation's data must rest on) and a VERSION of the consent text with the SHA-256 of that text,
--       and the digest of the signed document. Only an active OWNER of the organisation can record one (checked in the table's trigger, not only in
--       the function). The standing decision is the row with the highest seq. Nothing is updated or deleted.
--   D3  Insert gate: a project_observations row whose data_origin is 'production' is refused unless its project is attached to a hall of an
--       organisation (the organisation is DERIVED from that attachment and stored on the row, never taken from the caller) and that organisation's
--       standing consent is a grant. The consent that covered the row is stored on it (consent_id).
--   D3  Publication gate: calibration_ledger_rows requires the organisation's standing consent to still be a grant.
--   D1  project_completion_milestones: an append-only record that a project reached the 'energised' milestone on a date, backed by a VERIFIED evidence
--       file of that project and attested by an editor or owner of the organisation. The insert gate refuses a production observation for a project
--       with no such record, an observation dated before the milestone, and an observation of a project whose own supplier records (0018) show
--       delivery still in flight at the observed date (any date anywhere in a line's chain of corrections counts, unless the latest record states an
--       energisation date on or before the observed one). The view applies the same rule again. The date is not before 2000 and not in the future. A
--       record is bound to the ORGANISATION it was attested under (derived, never supplied): one attested under another organisation is absent for a
--       project that has been moved (GF016 names the cause), so the new organisation attests it afresh. An OWNER corrects a wrong date by a later record
--       that supersedes the first (supersedes_id; nothing is edited or deleted), and the gate and the view read the record nothing supersedes.
--   D5  calibration_tombstones: when an organisation's consent is WITHDRAWN (a new row; the trigger on that insert does the rest in the same
--       transaction) every observation recorded under the organisation gets a tombstone: the SHA-256 of its id, the time and the withdrawal row, and
--       NO content. The view excludes tombstoned observations for ever (a later re-grant covers only observations recorded after it), and the insert
--       gate refuses to record an observation whose id hash is tombstoned, so a re-import cannot resurrect one. The insert gate takes the SAME advisory lock
--       as the consent writer before it reads the consent, so a withdrawal that arrives while an observation insert is open waits for it and tombstones that
--       row too; and the view also requires that no withdrawal followed the consent a row was recorded under (consent_id), whatever was granted since.
--       Every released snapshot that contained any of the organisation's observations gets an appended supersession row; the snapshot itself is never edited.
--   R4  calibration_release_snapshots: an append-only registry of what was released, keyed by the hashes of the observations and organisations behind
--       it. A new snapshot is refused unless it is a safe group by itself (at least 10 observations, from at least 3 organisations, none supplying
--       more than 40%), is recorded no sooner than the cadence after the previous one (measured between the registry's OWN recorded_at stamps, which the
--       trigger sets from the database clock; the caller's released_at is only bounded to within a day of it, GF018, so a release cannot be back-dated or
--       forward-dated to satisfy the cadence), contains no tombstoned observation, and differs from EVERY earlier
--       snapshot (superseded ones too: the reader still holds them) by a safe group (the larger of the two differences, the one a reader cannot know).
--       The constants live in gf_calibration_release_policy() and are the same numbers as gridforge/calibration/release.py (a test compares them).
--       The database checks the snapshot as a whole; the per-cell and the multi-release linear-algebra checks are release.py's, which must run first.
--
-- DEVIATIONS from the brief, each deliberate
--   * The insert gates (D1, D3) bind rows whose data_origin is 'production' only. A row of origin test, synthetic or unclassified can never reach
--     calibration_ledger_rows (0047 requires production and the column is immutable: project_observations is append-only), so refusing it would
--     break rehearsals on preview deployments without protecting anything. The tombstone check applies to every origin.
--   * The completion milestone is a NEW record, not a column of supplier_actuals: a project whose equipment was procured outside Time to Power
--     (0017 allows it) has no supplier record, yet can attest that it is energised. The supplier records are used as a CONTRADICTION check only.
--   * Consent is per ORGANISATION (the unit the brief names and the unit of 'distinct organisations' in R4). 0047's per-project permission remains
--     and is still required by the view: both must hold.
--
-- EXISTING ROWS. Nothing is rewritten, deleted or back-filled. project_observations gains two nullable columns (organisation_id, consent_id); a row
-- stored before this migration has neither, so it has no consent naming its organisation and is NOT in the ledger view. No organisation, scope or
-- consent version is invented for it.
--
-- WHAT THE DATABASE CANNOT CHECK. The consent text itself and the signed document are digests the owner typed; nothing here opens either. An
-- owner of an organisation is whoever the registry (0049) says is one. The milestone date is the attester's declaration, backed by a file a reviewer
-- verified. A person with database ownership (or a connection that disables triggers, as the restore check does) is outside every one of these guards.
-- A withdrawal stops FUTURE aggregates; it cannot recall a snapshot already seen. That is why R4 exists.
--
--   gf_calibration_publication_inputs()   for each observation the ledger view admits now: the hashes of the observation and of its organisation and the floors of its
--       consent, for gridforge/calibration/release.py. A function so that nothing depends on calibration_ledger_rows (a later `drop view` of it stays possible).
--
-- OPERATOR NOTES
--   * BEFORE YOU APPLY THIS, the application must be able to meet it. From the moment it is applied a PRODUCTION observation is refused (SQLSTATE GF015, GF016
--     or GF017) unless its project is attached to a hall of an organisation that has recorded a consent (gf_record_calibration_consent) and the project has attested
--     its completion milestone (gf_attest_completion_milestone). Nothing in lib/ or app/ calls those functions yet and lib/project-observations.ts maps none of the
--     codes, so applied before that exists every production submission fails closed. That is the intended direction (no observation is accepted without the gates),
--     and one reason this is written and not applied. lib/calibration-gates.ts lists the view's conditions and must gain the three added here.
--   * Locks. The only changes to an existing table are two nullable columns and one trigger on project_observations (no rewrite; a short ACCESS EXCLUSIVE lock) and
--     the event-type check on project_events, added NOT VALID and then validated (see 0049). The file sets `lock_timeout = '5s'` (SET LOCAL) at its top and each of
--     those statements sets it again for itself, so a reader that holds the table open makes the apply FAIL after five seconds instead of queueing behind it and
--     blocking everyone else; re-run it when the table is quiet. Each is done only when it is not already in place, so a re-apply takes none of these locks. (The
--     view is replaced with CREATE OR REPLACE, which does lock the view: a query that is reading calibration_ledger_rows at that moment also meets the timeout.)
--   * Personal data. recorded_by and attested_by are e-mail addresses written to append-only tables (0049's note applies: erasure is the owner's decision).
--
-- Additive and idempotent. RLS on, no policies (service role only), like every table that holds a customer's material.

-- Every lock wait in this file is bounded. LOCAL: it lasts to the end of the transaction the file runs in (the applier submits the file as ONE query, which is
-- one transaction; so does `psql -1`). Run statement by statement (plain `psql -f`, autocommit) SET LOCAL has no effect and says so in a warning, which is why the
-- statements below that take an ACCESS EXCLUSIVE lock on a table other sessions use also set the same bound for themselves, and why they take no lock at all when
-- there is nothing to change (a re-apply).
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. The history gains one event type: the list as it stands plus this one (see 0047)
-- ---------------------------------------------------------------------------
do $$
declare cur text; have text[]; want text[] := array['completion_milestone_attested'];
        base text[] := array['project_created', 'btm_case_attached', 'btm_case_revised', 'rfq_generated', 'supplier_response_received',
          'comparison_completed', 'supplier_selected', 'evidence_attached', 'paid_product_attached', 'observation_submitted',
          'observation_reviewed', 'supplier_actual_submitted', 'supplier_actual_reviewed', 'cost_evidence_received', 'cost_evidence_reviewed',
          'cost_evidence_retired', 'cost_evidence_run', 'comparison_saved', 'share_issued', 'share_revoked'];
begin
  select pg_get_constraintdef(c.oid) into cur from pg_constraint c
   where c.conrelid = 'public.project_events'::regclass and c.conname = 'project_events_event_type_check';
  select coalesce(array_agg(distinct m[1]), '{}') into have from regexp_matches(coalesce(cur, ''), '''([a-z_]+)''', 'g') as m;
  -- Already holding every type it should (a re-apply): nothing to rebuild, so no lock is taken on the busiest table of the record.
  if cur is not null and have @> (base || want) then
    return;
  end if;
  perform set_config('lock_timeout', '5s', true);
  alter table public.project_events drop constraint if exists project_events_event_type_check;
  -- NOT VALID takes the lock only to register the constraint (new rows are checked from now on, no scan under it); VALIDATE then reads the existing rows
  -- under a lock that blocks neither readers nor writers. (Inside one transaction the first lock is held to its end all the same: the gain is that the
  -- scan is not what holds it up, and that a re-apply takes no lock at all, above.)
  execute 'alter table public.project_events add constraint project_events_event_type_check check (event_type in ('
    || (select string_agg(quote_literal(x), ', ' order by x) from (select distinct unnest(base || have || want) as x) u) || ')) not valid';
  alter table public.project_events validate constraint project_events_event_type_check;
end
$$;

-- ---------------------------------------------------------------------------
-- A. Hashes and the release policy (the numbers gridforge/calibration/release.py also holds)
-- ---------------------------------------------------------------------------
-- The same string gridforge.calibration.ledger.published_source_ref hashes (its first 32 hex characters head a published row's source reference), so a
-- tombstone can be matched to a ledger row without the database id ever being published.
create or replace function public.gf_calibration_observation_hash(p_id uuid) returns text
language sql immutable as $$
  select encode(sha256(convert_to('gridforge.calibration.observation:' || p_id::text, 'UTF8')), 'hex')
$$;

create or replace function public.gf_calibration_organisation_hash(p_id uuid) returns text
language sql immutable as $$
  select encode(sha256(convert_to('gridforge.calibration.organisation:' || p_id::text, 'UTF8')), 'hex')
$$;

-- K, M, the largest share one organisation may supply, the release step and the cadence. See release.py for the reasoning behind each.
create or replace function public.gf_calibration_release_policy() returns jsonb
language sql immutable as $$
  select jsonb_build_object('min_cell_observations', 10, 'min_cell_organisations', 3, 'max_organisation_share_permille', 400,
                            'release_step_observations', 10, 'release_step_organisations', 3, 'min_release_interval_days', 30)
$$;

-- A group is {observation hash: organisation hash}. Safe: at least p_min_obs observations, at least p_min_orgs distinct organisations, none above the share.
create or replace function public.gf_release_group_safe(p_members jsonb, p_min_obs int, p_min_orgs int) returns boolean
language sql immutable as $$
  with m as (select key as obs, value as org from jsonb_each_text(p_members)),
       per as (select org, count(*) as c from m group by org),
       tot as (select count(*) as n from m)
  select (select n from tot) >= p_min_obs
     and (select count(*) from per) >= p_min_orgs
     and (select coalesce(max(c), 0) from per) * 1000
         <= (select (public.gf_calibration_release_policy() ->> 'max_organisation_share_permille')::int * n from tot)
$$;

create or replace function public.gf_release_members_minus(p_a jsonb, p_b jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each_text(p_a) where not (p_b ? key)
$$;

-- May a new membership follow an earlier one? What a reader learns by differencing the two is the sum over what was added minus the sum over what was
-- removed. The LARGER of the two halves is the one a reader cannot know, so it must itself be a safe group (a tie: the new side). A membership identical
-- to an earlier one adds nothing and is refused as a release.
create or replace function public.gf_release_step_ok(p_new jsonb, p_old jsonb) returns boolean
language sql immutable as $$
  with h as (select public.gf_release_members_minus(p_new, p_old) as a, public.gf_release_members_minus(p_old, p_new) as b)
  select case
           when a = '{}'::jsonb and b = '{}'::jsonb then false
           when (select count(*) from jsonb_object_keys(a)) >= (select count(*) from jsonb_object_keys(b))
             then public.gf_release_group_safe(a, (public.gf_calibration_release_policy() ->> 'release_step_observations')::int,
                                                  (public.gf_calibration_release_policy() ->> 'release_step_organisations')::int)
           else public.gf_release_group_safe(b, (public.gf_calibration_release_policy() ->> 'release_step_observations')::int,
                                                  (public.gf_calibration_release_policy() ->> 'release_step_organisations')::int)
         end
    from h
$$;

-- ---------------------------------------------------------------------------
-- B. Consent: one append-only log per organisation
-- ---------------------------------------------------------------------------
create table if not exists public.calibration_consents (
  id uuid primary key default gen_random_uuid(),
  -- the order of decisions is a sequence, not a clock: two rows in one transaction share now()
  seq bigint generated always as identity unique,
  organisation_id uuid not null references public.organisations (id),
  kind text not null check (kind in ('granted', 'withdrawn')),
  -- WHAT may be published. One value today; a new form of publication is a new value and a new migration, never a free-text field.
  publish_scope text not null check (publish_scope in ('aggregate_residual_statistics')),
  -- AT WHAT AGGREGATION: an aggregate that contains this organisation's data must rest on at least this many observations and organisations. The
  -- floors are the release policy's (10, 3) or stricter; a consent cannot ask for less than the policy gives everyone.
  min_aggregate_observations int not null check (min_aggregate_observations between 10 and 100000),
  min_aggregate_organisations int not null check (min_aggregate_organisations between 3 and 1000),
  -- WHICH TEXT the organisation agreed to: its version label and the SHA-256 of the exact text shown.
  consent_text_version text not null check (consent_text_version ~ '^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$'),
  consent_text_sha256 text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$' and consent_text_sha256 !~ '^(.)\1{63}$'),
  -- The signed document that evidences this decision (a withdrawal names its own).
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$' and document_sha256 !~ '^(.)\1{63}$'),
  recorded_by text not null
    check (recorded_by = lower(btrim(recorded_by)) and position('@' in recorded_by) > 1 and length(recorded_by) <= 254 and recorded_by !~ '\s'),
  recorded_at timestamptz not null default clock_timestamp(),
  note text check (note is null or length(note) <= 1000)
);

create index if not exists calibration_consents_org_idx on public.calibration_consents (organisation_id, seq desc);

create or replace function public.gf_calibration_consent_guard() returns trigger
language plpgsql as $$
declare latest text;
begin
  -- serialise the decisions of one organisation, so two racing withdrawals both see the standing grant or one sees the other
  perform pg_advisory_xact_lock(hashtextextended('calibration_consent:' || new.organisation_id::text, 0));
  if public.gf_org_access(new.organisation_id, new.recorded_by, 'owner') <> 'ok' then
    raise exception 'only an active owner of the organisation can record or withdraw its calibration consent' using errcode = 'GF015';
  end if;
  select c.kind into latest from public.calibration_consents c where c.organisation_id = new.organisation_id order by c.seq desc limit 1;
  if new.kind = 'withdrawn' and latest is distinct from 'granted' then
    raise exception 'there is no standing consent to withdraw for this organisation' using errcode = 'GF015';
  end if;
  return new;
end;
$$;

drop trigger if exists calibration_consents_guard on public.calibration_consents;
create trigger calibration_consents_guard
  before insert on public.calibration_consents
  for each row execute function public.gf_calibration_consent_guard();

drop trigger if exists calibration_consents_append_only on public.calibration_consents;
create trigger calibration_consents_append_only
  before update or delete on public.calibration_consents
  for each row execute function public.gf_append_only();
drop trigger if exists calibration_consents_no_truncate on public.calibration_consents;
create trigger calibration_consents_no_truncate
  before truncate on public.calibration_consents
  for each statement execute function public.gf_append_only();

alter table public.calibration_consents enable row level security;

-- ---------------------------------------------------------------------------
-- C. Released snapshots, the tombstones of withdrawn observations, and the supersession of snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.calibration_release_snapshots (
  snapshot_id text primary key check (snapshot_id ~ '^[0-9a-f]{64}$'),
  seq bigint generated always as identity unique,
  released_at timestamptz not null,
  -- {observation hash: organisation hash} for every observation behind ANY cell of the release. Hashes only: no value, no name, no id.
  members jsonb not null check (jsonb_typeof(members) = 'object'),
  -- {cell name: [observation hash, ...]}: which of the members each published cell rests on.
  cells jsonb not null check (jsonb_typeof(cells) = 'object' and cells <> '{}'::jsonb),
  figures_sha256 text not null check (figures_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp()
);

create table if not exists public.calibration_tombstones (
  -- sha256 of the observation id (gf_calibration_observation_hash). One tombstone per observation, ever.
  observation_hash text primary key check (observation_hash ~ '^[0-9a-f]{64}$'),
  withdrawn_at timestamptz not null,
  withdrawal_id uuid not null references public.calibration_consents (id)
);

create table if not exists public.calibration_snapshot_supersessions (
  id uuid primary key default gen_random_uuid(),
  snapshot_id text not null references public.calibration_release_snapshots (snapshot_id),
  withdrawal_id uuid not null references public.calibration_consents (id),
  superseded_at timestamptz not null,
  reason text not null check (length(btrim(reason)) > 0),
  -- a withdrawal supersedes a snapshot once
  unique (snapshot_id, withdrawal_id)
);

create or replace function public.gf_release_snapshot_guard() returns trigger
language plpgsql as $$
declare pol jsonb := public.gf_calibration_release_policy(); prev public.calibration_release_snapshots;
begin
  perform pg_advisory_xact_lock(hashtextextended('calibration_release', 0));
  if exists (select 1 from jsonb_each(new.members) e
              where jsonb_typeof(e.value) <> 'string' or e.key !~ '^[0-9a-f]{64}$' or (e.value #>> '{}') !~ '^[0-9a-f]{64}$') then
    raise exception 'a snapshot''s members must map observation hashes to organisation hashes (64 lowercase hex characters each)' using errcode = 'GF018';
  end if;
  if exists (select 1 from jsonb_each(new.cells) c where jsonb_typeof(c.value) <> 'array') then
    raise exception 'each cell of a snapshot must be a list of observation hashes' using errcode = 'GF018';
  end if;
  if exists (select 1 from jsonb_each(new.cells) c, jsonb_array_elements(c.value) h(x)
              where jsonb_typeof(h.x) <> 'string' or not (new.members ? (h.x #>> '{}'))) then
    raise exception 'a cell lists an observation that is not among the snapshot''s members' using errcode = 'GF018';
  end if;
  -- The registry's OWN clock decides when a snapshot was recorded; whatever the caller put in recorded_at is overwritten. released_at is the caller's
  -- statement of when the figures were released, and is held to within a day of that clock, so the cadence below cannot be satisfied by dating a release.
  new.recorded_at := clock_timestamp();
  if new.released_at > new.recorded_at + interval '5 minutes' then
    raise exception 'a snapshot cannot be released in the future' using errcode = 'GF018';
  end if;
  if new.released_at < new.recorded_at - interval '1 day' then
    raise exception 'a snapshot is dated % but is being recorded at %: a release is registered within a day of the time it is released, and cannot be back-dated',
      new.released_at, new.recorded_at using errcode = 'GF018';
  end if;
  if exists (select 1 from jsonb_object_keys(new.members) k join public.calibration_tombstones t on t.observation_hash = k) then
    raise exception 'a snapshot contains an observation whose organisation withdrew its consent' using errcode = 'GF017';
  end if;
  if not public.gf_release_group_safe(new.members, (pol ->> 'min_cell_observations')::int, (pol ->> 'min_cell_organisations')::int) then
    raise exception 'a snapshot must rest on at least % observations from at least % organisations, none supplying more than % per mille',
      pol ->> 'min_cell_observations', pol ->> 'min_cell_organisations', pol ->> 'max_organisation_share_permille' using errcode = 'GF018';
  end if;
  select * into prev from public.calibration_release_snapshots order by seq desc limit 1;
  -- the cadence is measured between the times the registry recorded the two (its own clock), never between dates a caller chose
  if found and new.recorded_at < prev.recorded_at + make_interval(days => (pol ->> 'min_release_interval_days')::int) then
    raise exception 'the previous snapshot was recorded at %; the next may not be recorded within % days of it',
      prev.recorded_at, pol ->> 'min_release_interval_days' using errcode = 'GF018';
  end if;
  if exists (select 1 from public.calibration_release_snapshots s where not public.gf_release_step_ok(new.members, s.members)) then
    raise exception 'a snapshot must differ from every earlier release by a safe group (at least % observations from at least % organisations): the difference of two releases is what a reader computes',
      pol ->> 'release_step_observations', pol ->> 'release_step_organisations' using errcode = 'GF018';
  end if;
  return new;
end;
$$;

drop trigger if exists calibration_release_snapshots_guard on public.calibration_release_snapshots;
create trigger calibration_release_snapshots_guard
  before insert on public.calibration_release_snapshots
  for each row execute function public.gf_release_snapshot_guard();

-- The effects of a withdrawal, in the same transaction as the withdrawal row itself, whatever inserted it. SECURITY DEFINER with a pinned search_path so the
-- tombstones and supersessions are written by this function alone: the API roles are given no INSERT on either table below.
create or replace function public.gf_calibration_consent_withdrawn() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind <> 'withdrawn' then
    return null;
  end if;
  insert into public.calibration_tombstones (observation_hash, withdrawn_at, withdrawal_id)
  select public.gf_calibration_observation_hash(o.id), new.recorded_at, new.id
    from public.project_observations o
   where o.organisation_id = new.organisation_id
  on conflict (observation_hash) do nothing;
  insert into public.calibration_snapshot_supersessions (snapshot_id, withdrawal_id, superseded_at, reason)
  select s.snapshot_id, new.id, new.recorded_at,
         'an organisation whose observations this snapshot contains withdrew its consent; later releases exclude them'
    from public.calibration_release_snapshots s
   where exists (select 1 from jsonb_each_text(s.members) m where m.value = public.gf_calibration_organisation_hash(new.organisation_id))
  on conflict (snapshot_id, withdrawal_id) do nothing;
  return null;
end;
$$;

drop trigger if exists calibration_consents_withdrawn on public.calibration_consents;
create trigger calibration_consents_withdrawn
  after insert on public.calibration_consents
  for each row execute function public.gf_calibration_consent_withdrawn();

do $$
declare t text;
begin
  foreach t in array array['calibration_release_snapshots', 'calibration_tombstones', 'calibration_snapshot_supersessions'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.gf_append_only()', t || '_append_only', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.gf_append_only()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D. The completion milestone
-- ---------------------------------------------------------------------------
create table if not exists public.project_completion_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  -- The organisation the project belonged to when this was attested: derived by the guard from the project's hall attachment, never supplied. A milestone
  -- stands for the project only under the organisation that attested it; when the project moves to another organisation that one attests it afresh.
  organisation_id uuid not null references public.organisations (id),
  milestone text not null check (milestone in ('energised')),
  -- not before 2000: an implausible date is not a milestone (and a wrong one is corrected by an owner, below, never edited)
  reached_on date not null check (reached_on >= date '2000-01-01'),
  -- The file that shows it (a commissioning or energisation record). It must be one of this project's files and VERIFIED by a reviewer (0048).
  evidence_id uuid not null references public.project_evidence (id),
  basis text not null check (length(btrim(basis)) between 1 and 1000),
  attested_by text not null
    check (attested_by = lower(btrim(attested_by)) and position('@' in attested_by) > 1 and length(attested_by) <= 254 and attested_by !~ '\s'),
  attested_at timestamptz not null default clock_timestamp(),
  -- A CORRECTION: an owner's later record that supersedes this one (a wrong date). Nothing is edited or deleted; the standing record of a project under its
  -- organisation is the one nothing supersedes.
  supersedes_id uuid references public.project_completion_milestones (id)
);

-- One first attestation per project, milestone and organisation; each record is corrected at most once (the next correction supersedes the correction).
create unique index if not exists project_completion_milestones_one_initial
  on public.project_completion_milestones (project_id, milestone, organisation_id) where supersedes_id is null;
create unique index if not exists project_completion_milestones_one_correction
  on public.project_completion_milestones (supersedes_id) where supersedes_id is not null;

create or replace function public.gf_milestone_guard() returns trigger
language plpgsql as $$
declare org uuid; ev public.project_evidence; prev public.project_completion_milestones;
begin
  select s.org_id into org from public.projects p join public.sites s on s.id = p.site_id where p.id = new.project_id;
  if org is null then
    raise exception 'a completion milestone can be attested only for a project that is attached to a hall of an organisation' using errcode = 'GF016';
  end if;
  new.organisation_id := org;
  if new.supersedes_id is null then
    if public.gf_org_access(org, new.attested_by, 'editor') <> 'ok' then
      raise exception 'only an active owner or editor of the project''s organisation can attest its completion milestone' using errcode = 'GF016';
    end if;
  else
    -- a correction of a wrong date: an OWNER's act, of a record of this project under the organisation it belongs to now, and of the standing one
    select * into prev from public.project_completion_milestones where id = new.supersedes_id;
    if not found or prev.project_id <> new.project_id or prev.milestone <> new.milestone or prev.organisation_id <> org then
      raise exception 'a correction must supersede a completion milestone record of this project that was attested under the organisation it belongs to now' using errcode = 'GF016';
    end if;
    if exists (select 1 from public.project_completion_milestones x where x.supersedes_id = prev.id) then
      raise exception 'that completion milestone record has already been corrected: correct the latest one' using errcode = 'GF016';
    end if;
    if public.gf_org_access(org, new.attested_by, 'owner') <> 'ok' then
      raise exception 'only an active owner of the project''s organisation can correct its completion milestone' using errcode = 'GF016';
    end if;
  end if;
  select * into ev from public.project_evidence where id = new.evidence_id and project_id = new.project_id;
  if not found then
    raise exception 'that evidence does not belong to this project' using errcode = 'GF016';
  end if;
  if ev.review_status is distinct from 'verified' then
    raise exception 'the evidence for a completion milestone must be verified by a reviewer first' using errcode = 'GF016';
  end if;
  if new.reached_on > (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'a milestone dated in the future is a plan, not a milestone that has been reached' using errcode = 'GF016';
  end if;
  if new.reached_on < date '2000-01-01' then
    raise exception 'a milestone dated before 2000 is not a plausible date for a project to have been energised' using errcode = 'GF016';
  end if;
  return new;
end;
$$;

drop trigger if exists project_completion_milestones_guard on public.project_completion_milestones;
create trigger project_completion_milestones_guard
  before insert on public.project_completion_milestones
  for each row execute function public.gf_milestone_guard();
drop trigger if exists project_completion_milestones_append_only on public.project_completion_milestones;
create trigger project_completion_milestones_append_only
  before update or delete on public.project_completion_milestones
  for each row execute function public.gf_append_only();
drop trigger if exists project_completion_milestones_no_truncate on public.project_completion_milestones;
create trigger project_completion_milestones_no_truncate
  before truncate on public.project_completion_milestones
  for each statement execute function public.gf_append_only();
alter table public.project_completion_milestones enable row level security;

-- Do the project's own supplier records (0018) show delivery still in flight at `p_observed_on`? A LINE is one procurement package's chain of records: the
-- initial one and each correction of it (0018: one initial and at most one correction per record; a correction is a whole new record of only the facts it
-- supplies, nothing is inherited). The line's LATEST record that a reviewer has not rejected speaks for it:
--   * it has an energisation date on or before the observed date: the line is delivered, not in flight (a correction that retracts or moves the date is the
--     supplier's own, later word);
--   * otherwise (no energisation date, or one after the observed date): the line is in flight if ANY record of its chain (not rejected) gives any date at all
--     (purchase, dispatch, arrival, installation, energisation). A later record that carries a cost only, or any other fact but the energisation date, does
--     not erase the dates of the records it corrects: it cannot be used to make an in-flight delivery look absent. To clear the line the correction must state
--     the energisation date.
-- A rejected record is ignored, as before. A project with no supplier record, or only records that carry no date, is not in flight by this test: absence
-- of a date is not a date.
create or replace function public.gf_project_delivery_in_flight(p_project uuid, p_observed_on date) returns boolean
language sql stable as $$
  with recursive chain as (
    select a.id, a.package_id, 1 as depth, a.po_date, a.dispatch_date, a.on_site_date, a.install_complete_date, a.energised_date
      from public.supplier_actuals a where a.project_id = p_project and a.supersedes_id is null
    union all
    select b.id, b.package_id, c.depth + 1, b.po_date, b.dispatch_date, b.on_site_date, b.install_complete_date, b.energised_date
      from public.supplier_actuals b join chain c on b.supersedes_id = c.id
     where b.project_id = p_project and c.depth < 1000
  ),
  live as (
    select c.* from chain c
     where not exists (select 1 from public.supplier_actual_reviews r where r.actual_id = c.id and r.decision = 'rejected')
  ),
  latest as (
    select distinct on (l.package_id) l.* from live l order by l.package_id, l.depth desc
  )
  select exists (
    select 1 from latest h
     where (h.energised_date is null or h.energised_date > p_observed_on)
       and exists (select 1 from live l
                    where l.package_id = h.package_id
                      and (l.po_date is not null or l.dispatch_date is not null or l.on_site_date is not null
                           or l.install_complete_date is not null or l.energised_date is not null)))
$$;

create or replace function public.gf_attest_completion_milestone(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_completion_milestones;
begin
  -- `supersedes_id` present: a correction of a wrong date by an owner (the guard checks it); absent: the first attestation under the project's organisation.
  insert into public.project_completion_milestones (project_id, milestone, reached_on, evidence_id, basis, attested_by, supersedes_id)
  values ((p->>'project_id')::uuid, p->>'milestone', (p->>'reached_on')::date, (p->>'evidence_id')::uuid, p->>'basis',
          lower(btrim(p->>'attested_by')), (p->>'supersedes_id')::uuid)
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('milestone_id', r.id, 'milestone', r.milestone, 'reached_on', r.reached_on, 'evidence_id', r.evidence_id,
                         'supersedes_id', r.supersedes_id));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- E. The consent writers
-- ---------------------------------------------------------------------------
create or replace function public.gf_record_calibration_consent(p jsonb) returns jsonb
language plpgsql as $$
declare r public.calibration_consents;
begin
  -- Nothing is defaulted: a consent that does not name its scope, its floors and its text version is refused by the table, not completed here.
  insert into public.calibration_consents (organisation_id, kind, publish_scope, min_aggregate_observations, min_aggregate_organisations,
        consent_text_version, consent_text_sha256, document_sha256, recorded_by, note)
  values ((p->>'organisation_id')::uuid, 'granted', p->>'publish_scope', (p->>'min_aggregate_observations')::int,
          (p->>'min_aggregate_organisations')::int, p->>'consent_text_version', p->>'consent_text_sha256', p->>'document_sha256',
          lower(btrim(p->>'recorded_by')), nullif(btrim(coalesce(p->>'note', '')), ''))
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- A withdrawal repeats the scope and the text version of the grant it ends, so the log reads as a pair.
create or replace function public.gf_withdraw_calibration_consent(p jsonb) returns jsonb
language plpgsql as $$
declare g public.calibration_consents; r public.calibration_consents; n_t bigint; n_s bigint;
begin
  select * into g from public.calibration_consents where organisation_id = (p->>'organisation_id')::uuid order by seq desc limit 1;
  if not found or g.kind <> 'granted' then
    raise exception 'there is no standing consent to withdraw for this organisation' using errcode = 'GF015';
  end if;
  insert into public.calibration_consents (organisation_id, kind, publish_scope, min_aggregate_observations, min_aggregate_organisations,
        consent_text_version, consent_text_sha256, document_sha256, recorded_by, note)
  values (g.organisation_id, 'withdrawn', g.publish_scope, g.min_aggregate_observations, g.min_aggregate_organisations,
          g.consent_text_version, g.consent_text_sha256, p->>'document_sha256', lower(btrim(p->>'recorded_by')),
          nullif(btrim(coalesce(p->>'note', '')), ''))
  returning * into r;
  select count(*) into n_t from public.calibration_tombstones where withdrawal_id = r.id;
  select count(*) into n_s from public.calibration_snapshot_supersessions where withdrawal_id = r.id;
  return jsonb_build_object('consent', to_jsonb(r), 'tombstoned', n_t, 'snapshots_superseded', n_s);
end;
$$;

-- Registering a released snapshot. The guard above is the policy; this only writes the row.
create or replace function public.gf_record_release_snapshot(p jsonb) returns jsonb
language plpgsql as $$
declare r public.calibration_release_snapshots;
begin
  insert into public.calibration_release_snapshots (snapshot_id, released_at, members, cells, figures_sha256)
  values (p->>'snapshot_id', (p->>'released_at')::timestamptz, p->'members', p->'cells', p->>'figures_sha256')
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- F. The insert gate on observations (D1, D3) and the refusal to resurrect a withdrawn one (D5)
-- ---------------------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS takes the ACCESS EXCLUSIVE lock BEFORE it looks, so a re-apply would queue behind (and block) every reader of the table: look first.
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'project_observations' and column_name in ('organisation_id', 'consent_id')) < 2 then
    perform set_config('lock_timeout', '5s', true);
    alter table public.project_observations
      add column if not exists organisation_id uuid references public.organisations (id),
      add column if not exists consent_id uuid references public.calibration_consents (id);
  end if;
end
$$;
comment on column public.project_observations.organisation_id is
  'The organisation the observation was recorded under: derived by the database from the project''s open hall attachment at insert, never supplied. '
  'NULL for rows written before 0056 and for rows that are not production. Only a production row with an organisation and a standing consent can be exported.';
comment on column public.project_observations.consent_id is
  'The consent (calibration_consents) that stood for the organisation when the row was recorded: its scope, floors and text version. NULL as above.';

create or replace function public.gf_observation_publication_gates() returns trigger
language plpgsql as $$
declare org uuid; c public.calibration_consents; m public.project_completion_milestones;
begin
  -- D5. An observation whose id hash is tombstoned is never recorded again, whatever its origin.
  if exists (select 1 from public.calibration_tombstones t where t.observation_hash = public.gf_calibration_observation_hash(new.id)) then
    raise exception 'this observation was withdrawn with its organisation''s consent and cannot be recorded again' using errcode = 'GF017';
  end if;
  -- Only a row that claims to be production can ever reach the ledger (0047); a test, synthetic or unclassified row is not gated here.
  if new.data_origin is distinct from 'production' then
    return new;
  end if;
  -- D3. The organisation is the one the project is attached to; without one there is nobody whose consent could name it.
  select s.org_id into org from public.projects p join public.sites s on s.id = p.site_id where p.id = new.project_id;
  if org is null then
    raise exception 'a production observation needs a project attached to a hall of an organisation: there is no organisation whose consent could cover it' using errcode = 'GF015';
  end if;
  -- The SAME lock the consent writer takes (gf_calibration_consent_guard), taken BEFORE the consent is read and held to the end of this transaction. A
  -- withdrawal that arrives while this insert is open therefore waits for it, and then tombstones this row too (its trigger reads project_observations
  -- with a fresh snapshot once the lock is its own); a withdrawal that committed first is seen by the read below. Without it the row would be recorded under
  -- a consent that was withdrawn a moment later, escape the tombstones, and come back when the organisation granted consent again.
  perform pg_advisory_xact_lock(hashtextextended('calibration_consent:' || org::text, 0));
  select * into c from public.calibration_consents where organisation_id = org order by seq desc limit 1;
  if not found or c.kind <> 'granted' then
    raise exception 'the organisation has no standing calibration consent (none was recorded, or it was withdrawn)' using errcode = 'GF015';
  end if;
  new.organisation_id := org;
  new.consent_id := c.id;
  -- D1. The project has reached, and attested, its completion milestone; the observation is not older than it; its own supplier records agree.
  -- The standing record of the project's milestone UNDER ITS ORGANISATION NOW (not superseded by a correction). One attested under another organisation is
  -- absent for this one: a milestone does not travel with a project that has been moved.
  select * into m from public.project_completion_milestones pm
   where pm.project_id = new.project_id and pm.milestone = 'energised' and pm.organisation_id = org
     and not exists (select 1 from public.project_completion_milestones x where x.supersedes_id = pm.id);
  if not found then
    if exists (select 1 from public.project_completion_milestones where project_id = new.project_id and milestone = 'energised') then
      raise exception 'the project''s completion milestone was attested under another organisation; the organisation it belongs to now has to attest it again: a milestone does not move with the project' using errcode = 'GF016';
    end if;
    raise exception 'the project has not attested that it reached its completion milestone (energised): partial or in-flight data is not recorded' using errcode = 'GF016';
  end if;
  if m.reached_on > new.observed_on then
    raise exception 'the observation is dated % but the project reached its completion milestone on %: data from before completion is not recorded', new.observed_on, m.reached_on using errcode = 'GF016';
  end if;
  if public.gf_project_delivery_in_flight(new.project_id, new.observed_on) then
    raise exception 'a supplier record of this project shows delivery still in flight at the observed date: partial or in-flight data is not recorded' using errcode = 'GF016';
  end if;
  return new;
end;
$$;

-- DROP TRIGGER takes an ACCESS EXCLUSIVE lock on project_observations; the trigger's body is the function above (replaced in place), so on a re-apply it is left
-- alone, and only created when absent or switched back on when disabled.
do $$
declare st "char";
begin
  select t.tgenabled into st from pg_trigger t
   where t.tgrelid = 'public.project_observations'::regclass and t.tgname = 'project_observations_publication_gates' and not t.tgisinternal;
  if not found then
    perform set_config('lock_timeout', '5s', true);
    create trigger project_observations_publication_gates
      before insert on public.project_observations
      for each row execute function public.gf_observation_publication_gates();
  elsif st <> 'O' then
    perform set_config('lock_timeout', '5s', true);
    alter table public.project_observations enable trigger project_observations_publication_gates;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- G. The FINAL ledger view: 0052's definition plus the three publication conditions
-- ---------------------------------------------------------------------------
create or replace view public.calibration_ledger_rows with (security_invoker = true) as
select o.id,
       o.calibration_key as key,
       o.observed_value,
       o.predicted_value,
       o.unit,
       o.site_ref,
       o.measurement_kind,
       r.evidence_sha256,
       o.engine_provenance_digest,
       o.report_date,
       o.observed_on,
       o.method,
       r.evidence_class,
       r.reviewer as reviewed_by,
       r.reviewed_at
from public.project_observations o
join public.project_observation_reviews r on r.observation_id = o.id
join public.project_evidence e on e.id = o.evidence_id
join public.power_deployment_cases c on c.case_token = o.case_token and c.revision = o.case_revision
where r.decision = 'verified'
  and r.evidence_class = 'E5'
  and o.measurement_kind in ('metered', 'bms_trend', 'commissioning_record')
  and o.calibration_key = 'btm.firm_MW' and o.unit = 'MW'
  and o.site_ref is not null
  and o.engine_provenance_digest is not null
  and r.evidence_sha256 is not null
  and e.review_status = 'verified' and e.sha256 = r.evidence_sha256
  and exists (select 1 from public.project_evidence_reviews er
              where er.evidence_id = e.id and er.decision = 'verified' and er.sha256_confirmed = e.sha256)
  and lower(btrim(r.reviewer)) <> lower(btrim(o.submitted_by))
  and c.created_at is not null
  and c.created_at < (o.observed_on::timestamp at time zone 'UTC')
  and c.case_digest is not null
  and c.case_digest = encode(sha256(convert_to(jsonb_build_object('request', c.request, 'result', c.result)::text, 'UTF8')), 'hex')
  and o.predicted_value = public.gf_forecast_predicted_mw(c.result, o.architecture)
  and o.data_origin = 'production'
  and exists (
    select 1 from public.calibration_permissions cp
    where cp.scope_type = 'project' and cp.scope_id = o.project_id and cp.kind = 'granted'
      and cp.seq = (select max(c2.seq) from public.calibration_permissions c2
                    where c2.scope_type = 'project' and c2.scope_id = o.project_id))
  and not exists (
    select 1 from public.hall_project_attachments hpa
    join public.sites st on st.id = hpa.site_id
    where hpa.project_id = o.project_id
      and st.data_origin <> 'production')
  -- 0056 (D3): the organisation the row was recorded under still has a standing consent, and its latest decision is a grant; and (D3/D5, defence in depth) the
  -- consent the row was RECORDED UNDER (consent_id) has not been followed by a withdrawal, whatever has been granted since. A tombstone is the primary record of a
  -- withdrawal; the second term keeps out a row that somehow escaped it (an insert whose snapshot predates the withdrawal, a withdrawal written with the triggers
  -- off) when the organisation grants consent again.
  and exists (
    select 1 from public.calibration_consents cc
    where cc.organisation_id = o.organisation_id and cc.kind = 'granted'
      and cc.seq = (select max(c3.seq) from public.calibration_consents c3 where c3.organisation_id = o.organisation_id))
  and exists (
    select 1 from public.calibration_consents rc
    where rc.id = o.consent_id and rc.organisation_id = o.organisation_id and rc.kind = 'granted'
      and not exists (select 1 from public.calibration_consents w
                      where w.organisation_id = rc.organisation_id and w.kind = 'withdrawn' and w.seq > rc.seq))
  -- 0056 (D1): the project attested its completion milestone UNDER THE ORGANISATION THE ROW WAS RECORDED UNDER (the standing record, not one an owner has since
  -- corrected), the observation is not older than it, and no supplier record of the project shows delivery in flight.
  and exists (
    select 1 from public.project_completion_milestones pm
    where pm.project_id = o.project_id and pm.milestone = 'energised' and pm.organisation_id = o.organisation_id and pm.reached_on <= o.observed_on
      and not exists (select 1 from public.project_completion_milestones x where x.supersedes_id = pm.id)
      and not public.gf_project_delivery_in_flight(o.project_id, o.observed_on))
  -- 0056 (D5): the observation was not withdrawn with its organisation's consent (a tombstone is permanent, a later re-grant does not lift it).
  and not exists (
    select 1 from public.calibration_tombstones tb
    where tb.observation_hash = public.gf_calibration_observation_hash(o.id));

-- What the release layer needs, and nothing the importer gets: for each row the ledger view admits NOW, the hashes of the observation and of its organisation,
-- and the aggregation floors its consent asks for (the stricter of the consent it was recorded under and the one that stands now). A FUNCTION, not a view: a
-- view on calibration_ledger_rows would make `drop view calibration_ledger_rows` impossible (the view is replaced with CREATE OR REPLACE, but a restore or a
-- test that rebuilds it from an older definition drops it first), and a SQL function body keeps no dependency on what it reads.
create or replace function public.gf_calibration_publication_inputs()
returns table (observation_hash text, organisation_hash text, min_observations int, min_organisations int)
language sql stable as $$
  select public.gf_calibration_observation_hash(o.id),
         public.gf_calibration_organisation_hash(o.organisation_id),
         greatest(rc.min_aggregate_observations, sc.min_aggregate_observations),
         greatest(rc.min_aggregate_organisations, sc.min_aggregate_organisations)
    from public.calibration_ledger_rows l
    join public.project_observations o on o.id = l.id
    join public.calibration_consents rc on rc.id = o.consent_id
    join public.calibration_consents sc on sc.organisation_id = o.organisation_id
     and sc.seq = (select max(c4.seq) from public.calibration_consents c4 where c4.organisation_id = o.organisation_id)
   order by 1
$$;

-- ---------------------------------------------------------------------------
-- Privileges, per 0020/0038/0047: the gf_* functions are service_role-only; the new tables and views are readable (and, where a function writes
-- them as the caller, insertable) by service_role alone. The tombstones and supersessions are written by the SECURITY DEFINER trigger alone.
--
-- A Supabase project hands ALL on every new public table to anon, authenticated and service_role through default privileges (0040), so a GRANT of select to
-- service_role takes nothing away: service_role would keep INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER and REFERENCES, and a forged INSERT into
-- calibration_tombstones (no trigger stops an insert there) would suppress any observation for ever. Each object is therefore REVOKED from every API role
-- (and public) first, and only what the code path needs is granted back: select everywhere, insert where a gf_* function writes the table as the caller
-- (the consent log, the snapshot registry, the milestone record). The identity sequences behind the two `seq` columns are revoked too: an insert into an
-- identity column needs no privilege on its sequence, and setval on one could hand a withdrawal a lower seq than the grant it ends.
-- ---------------------------------------------------------------------------
do $$
declare f text; r text; t text; sq text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'gf\_%' loop
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
  foreach t in array array['calibration_consents', 'calibration_release_snapshots', 'project_completion_milestones',
                           'calibration_tombstones', 'calibration_snapshot_supersessions',
                           'calibration_ledger_rows'] loop
    execute format('revoke all on public.%I from public', t);
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on public.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      if t in ('calibration_consents', 'calibration_release_snapshots', 'project_completion_milestones') then
        execute format('grant select, insert on public.%I to service_role', t);
      else
        execute format('grant select on public.%I to service_role', t);
      end if;
    end if;
  end loop;
  foreach t in array array['calibration_consents', 'calibration_release_snapshots'] loop
    sq := pg_get_serial_sequence(format('public.%I', t), 'seq');
    if sq is not null then
      execute format('revoke all on sequence %s from public', sq);
      foreach r in array array['anon', 'authenticated', 'service_role'] loop
        if exists (select 1 from pg_roles where rolname = r) then
          execute format('revoke all on sequence %s from %I', sq, r);
        end if;
      end loop;
    end if;
  end loop;
end
$$;
