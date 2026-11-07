-- 0048_evidence_verification.sql: the one path by which an evidence file becomes verified or rejected, the guard that keeps the file a
-- reviewer vouched for the file it was, and the FINAL definition of calibration_ledger_rows (every gate of 0046, 0047 and this migration).
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Until it is applied the admin route
-- POST /api/admin/evidence/[id]/review answers 503 ("not available"), /admin/reviews keeps working as it did (observations and delivery
-- records can still be rejected, and verifying one still needs a verified file), and nothing else changes.
--
-- REPLAY ORDER. This migration holds the view that governs. Re-running 0038, 0046 or 0047 after it silently replaces the view (and for
-- 0038 gf_submit_observation) with an older, weaker definition. Migrations are applied once, in order (scripts/apply-migration.py gate 2).
-- tests/test_calibration_final_gate.py reads the FINAL view and function from a database built by the whole chain and fails if any gate is
-- missing, so a reorder or a later redefinition that drops one fails CI.
--
-- Why. project_evidence.review_status is what makes an observation eligible for the calibration ledger (0038: gf_review_observation refuses
-- to verify an observation whose file is not 'verified', and the export view requires it). But nothing in the application ever set it: the
-- server writes 'unverified' and the review screen had no file decision at all, so no observation could ever reach the ledger and the
-- only way to change a status was a raw UPDATE. A raw UPDATE is also the way to swap the digest, name or storage path of a file after a
-- reviewer vouched for it, or to flip a status behind the reviewers' back.
--
--   A. project_evidence_reviews: an append-only record of ONE decision per file ('verified' or 'rejected'), by a named reviewer, with a
--      reason, and, for a verification, the SHA-256 the reviewing SERVER says it computed from the stored object. One row per evidence_id
--      (unique): a decision is never flipped and a second one is refused. The reviewer name is self-typed text under one shared admin
--      password; it is recorded as typed and is not an authenticated identity.
--      WHAT THE DATABASE CAN AND CANNOT CHECK: the hash is computed by the route (lib/project-evidence-review.ts), not by the database,
--      which never sees the bytes. The database compares a CLAIMED hash with the digest stored at upload, and refuses a difference. It cannot
--      tell that the route really hashed the stored object.
--   B. gf_review_evidence(p, p_event): the ONLY way a decision row is created and a status changes. It is SECURITY DEFINER with a pinned
--      search_path, and direct INSERT on project_evidence_reviews is revoked from service_role (and anon, authenticated, public), so a pre-seeded
--      or forged decision row is not possible for PostgREST or service_role callers; a trigger additionally refuses an insert made as one of
--      those roles even where a blanket grant gives the privilege back (scripts/realdb-up.sh grants ALL after the migrations). It refuses a
--      verification unless sha256_confirmed equals the digest stored for the file (GF007), refuses a file already decided (GF008), writes the
--      decision, moves review_status and appends the 'evidence_reviewed' history event, in one transaction. service_role may execute it.
--      A superuser or the table owner connecting directly can still bypass all of this: it is a guard for the application role, not for the
--      owner of the database.
--   C. A guard on project_evidence. INSERT: a file arrives 'unverified' (a file that arrives verified is refused). UPDATE: every column
--      except note and source_category is frozen (id, project_id, filename, media_type, sha256, byte_size, storage_ref, uploaded_at,
--      evidence_class); review_status may move only from 'unverified' to the decision on record, only when the change is made by
--      gf_review_evidence (not by an API role), with its transaction-local setting set, and with a stored decision row that says the same
--      thing. DELETE of a file that has been decided is refused. A TRUNCATE guard (gf_append_only, as 0025/0038/0040/0047) covers the table.
--      The restore check loads a SCRATCH database under session_replication_role = replica, which skips these triggers.
--   D. The history gains the 'evidence_reviewed' event (added to the list as it stands).
--   E. calibration_ledger_rows, FINAL definition: everything 0038 required, plus 0046 (forecast stored, created before the observed date,
--      case_digest present and still equal to the digest of the stored request and result, predicted_value still the number the stored result
--      holds), 0047 (production origin, the project's latest permission a grant), and this migration: a verified decision row for the file
--      whose sha256_confirmed equals the file's stored sha256. Every column and the privileges are unchanged.
--      CONSEQUENCES, stated plainly: a file marked verified by a raw update before this migration has NO decision row and does not qualify;
--      an observation against a revision written before 0046 (no case_digest) does not qualify; an observation stored before 0047 is
--      'unclassified' and does not qualify. There is deliberately no withdrawal of a mistaken verdict (a decision is recorded once and is
--      final), and revoking a permission does not recall rows already imported by `gridforge calibrate import`. A reviewed, append-only
--      origin-attestation step for past observations is a future decision for the owner, not built here.
--
-- Rows already in production are untouched: nothing is rewritten, deleted or back-filled, and a file already 'verified' or 'rejected' by an
-- earlier raw update stays as it is (it simply cannot be reviewed again). Additive and idempotent. RLS on, no policies (service role only).

-- ---------------------------------------------------------------------------
-- D. The history gains one event type: the list as it stands plus this one (see 0047)
-- ---------------------------------------------------------------------------
do $$
declare cur text; have text[]; want text[] := array['evidence_reviewed'];
        base text[] := array['project_created', 'btm_case_attached', 'btm_case_revised', 'rfq_generated', 'supplier_response_received',
          'comparison_completed', 'supplier_selected', 'evidence_attached', 'paid_product_attached', 'observation_submitted',
          'observation_reviewed', 'supplier_actual_submitted', 'supplier_actual_reviewed', 'cost_evidence_received', 'cost_evidence_reviewed',
          'cost_evidence_retired', 'cost_evidence_run', 'comparison_saved', 'share_issued', 'share_revoked'];
begin
  select pg_get_constraintdef(c.oid) into cur from pg_constraint c
   where c.conrelid = 'public.project_events'::regclass and c.conname = 'project_events_event_type_check';
  select coalesce(array_agg(distinct m[1]), '{}') into have from regexp_matches(coalesce(cur, ''), '''([a-z_]+)''', 'g') as m;
  alter table public.project_events drop constraint if exists project_events_event_type_check;
  execute 'alter table public.project_events add constraint project_events_event_type_check check (event_type in ('
    || (select string_agg(quote_literal(x), ', ' order by x) from (select distinct unnest(base || have || want) as x) u) || '))';
end
$$;

-- ---------------------------------------------------------------------------
-- A. The decision record
-- ---------------------------------------------------------------------------
create table if not exists public.project_evidence_reviews (
  id uuid primary key default gen_random_uuid(),
  -- One decision per file, ever.
  evidence_id uuid not null unique references public.project_evidence (id),
  project_id uuid not null references public.projects (id),
  decision text not null check (decision in ('verified', 'rejected')),
  reviewer text not null check (length(btrim(reviewer)) > 0 and length(reviewer) <= 120),
  reason text not null check (length(btrim(reason)) > 0 and length(reason) <= 500),
  -- The digest the reviewing server SAYS it computed from the stored object. Required to verify, optional to reject.
  sha256_confirmed text check (sha256_confirmed ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz not null default now(),
  check (decision <> 'verified' or sha256_confirmed is not null)
);

create index if not exists project_evidence_reviews_project_idx on public.project_evidence_reviews (project_id);

create or replace function public.gf_evidence_review_guard() returns trigger
language plpgsql as $$
declare ev public.project_evidence;
begin
  -- gf_review_evidence is SECURITY DEFINER, so inside it current_user is the function owner. A row written as one of the API roles did not come
  -- from it, whatever privileges those roles hold.
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator') then
    raise exception 'a review decision is written only by gf_review_evidence' using errcode = '42501';
  end if;
  select * into ev from public.project_evidence where id = new.evidence_id;
  if not found then
    raise exception 'no such evidence' using errcode = '23503';
  end if;
  if new.project_id is distinct from ev.project_id then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  if new.decision = 'verified' and new.sha256_confirmed is distinct from ev.sha256 then
    raise exception 'the confirmed SHA-256 does not match the digest stored for this file, so it cannot be verified' using errcode = 'GF007';
  end if;
  return new;
end;
$$;

drop trigger if exists project_evidence_reviews_guard on public.project_evidence_reviews;
create trigger project_evidence_reviews_guard
  before insert on public.project_evidence_reviews
  for each row execute function public.gf_evidence_review_guard();

drop trigger if exists project_evidence_reviews_append_only on public.project_evidence_reviews;
create trigger project_evidence_reviews_append_only
  before update or delete on public.project_evidence_reviews
  for each row execute function public.gf_append_only();
drop trigger if exists project_evidence_reviews_no_truncate on public.project_evidence_reviews;
create trigger project_evidence_reviews_no_truncate
  before truncate on public.project_evidence_reviews
  for each statement execute function public.gf_append_only();

alter table public.project_evidence_reviews enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- C. The guard on the file itself
-- ---------------------------------------------------------------------------
create or replace function public.gf_project_evidence_guard() returns trigger
language plpgsql as $$
declare
  free text[] := array['note', 'source_category', 'review_status'];
begin
  if tg_op = 'INSERT' then
    if new.review_status is distinct from 'unverified' then
      raise exception 'a file arrives unverified: review_status is set only by gf_review_evidence' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.review_status <> 'unverified' then
      raise exception 'a reviewed file cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
    raise exception 'project_evidence rows are immutable except note and source_category: the file a reviewer vouched for stays the file it was'
      using errcode = '42501';
  end if;
  if new.review_status is distinct from old.review_status then
    if old.review_status <> 'unverified'
       or current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
       or current_setting('gridforge.evidence_review', true) is distinct from new.id::text
       or not exists (select 1 from public.project_evidence_reviews r
                      where r.evidence_id = new.id and r.decision = new.review_status) then
      raise exception 'review_status changes only through gf_review_evidence, once, to the decision on record' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists project_evidence_guard on public.project_evidence;
create trigger project_evidence_guard
  before insert or update or delete on public.project_evidence
  for each row execute function public.gf_project_evidence_guard();

drop trigger if exists project_evidence_no_truncate on public.project_evidence;
create trigger project_evidence_no_truncate
  before truncate on public.project_evidence
  for each statement execute function public.gf_append_only();

-- ---------------------------------------------------------------------------
-- B. The only way a decision is written and a status changes
-- ---------------------------------------------------------------------------
create or replace function public.gf_review_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ev public.project_evidence; r public.project_evidence_reviews;
begin
  select * into ev from public.project_evidence where id = (p->>'evidence_id')::uuid for update;
  if not found then
    raise exception 'no such evidence' using errcode = '23503';
  end if;
  if ev.review_status <> 'unverified' then
    raise exception 'this file has already been reviewed: a decision is recorded once and is final' using errcode = 'GF008';
  end if;
  insert into public.project_evidence_reviews (evidence_id, project_id, decision, reviewer, reason, sha256_confirmed)
  values (ev.id, ev.project_id, p->>'decision', p->>'reviewer', p->>'reason', p->>'sha256_confirmed')
  returning * into r;
  perform set_config('gridforge.evidence_review', ev.id::text, true);
  update public.project_evidence set review_status = r.decision where id = ev.id;
  perform set_config('gridforge.evidence_review', '', true);
  perform public.gf_emit(ev.project_id, p_event,
      jsonb_build_object('evidence_id', ev.id, 'decision', r.decision, 'sha256_confirmed', r.sha256_confirmed));
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- E. The FINAL ledger view: every gate
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
                    where c2.scope_type = 'project' and c2.scope_id = o.project_id));

-- ---------------------------------------------------------------------------
-- Privileges, per 0020/0038: the gf_* functions are service_role-only; direct INSERT on the decision table is revoked.
-- ---------------------------------------------------------------------------
do $$
declare f text; r text;
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
  revoke all on public.project_evidence_reviews from public;
  revoke all on public.calibration_ledger_rows from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.project_evidence_reviews from %I', r);
      execute format('revoke all on public.calibration_ledger_rows from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Read-only: the decision rows are written by gf_review_evidence (SECURITY DEFINER), never directly.
    revoke insert, update, delete on public.project_evidence_reviews from service_role;
    revoke truncate on public.project_evidence_reviews from service_role;
    grant select on public.project_evidence_reviews to service_role;
    grant select on public.calibration_ledger_rows to service_role;
  end if;
end
$$;
