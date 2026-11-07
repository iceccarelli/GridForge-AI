-- 0048_evidence_verification.sql: the one path by which an evidence file becomes verified or rejected, and the guard that keeps the file a
-- reviewer vouched for the file it was.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Until it is applied the admin route
-- POST /api/admin/evidence/[id]/review answers 503 ("not available"), /admin/reviews keeps working as it did (observations and delivery
-- records can still be rejected, and verifying one still needs a verified file), and nothing else changes.
--
-- Why. project_evidence.review_status is what makes an observation eligible for the calibration ledger (0038: gf_review_observation refuses
-- to verify an observation whose file is not 'verified', and the export view requires it). But nothing in the application ever set it: the
-- server writes 'unverified' and the review screen had no file decision at all, so no observation could ever reach the ledger and the
-- only way to change a status was a raw UPDATE. A raw UPDATE is also the way to swap the digest, name or storage path of a file after a
-- reviewer vouched for it, or to flip a status behind the reviewers' back.
--
--   A. project_evidence_reviews: an append-only record of ONE decision per file ('verified' or 'rejected'), by a named reviewer, with a
--      reason, and, for a verification, the SHA-256 the reviewer's SERVER computed from the stored object. One row per evidence_id
--      (unique): a decision is never flipped and a second one is refused. The reviewer name is self-typed text under one shared admin
--      password; it is recorded as typed and is not an authenticated identity.
--   B. gf_review_evidence(p, p_event): the only way a status changes. It refuses a verification unless sha256_confirmed equals the digest
--      stored for the file (GF007: a stored object that no longer hashes to the recorded digest cannot be verified), refuses a file that
--      has already been decided (GF008), writes the decision, moves review_status and appends the 'evidence_reviewed' history event, in one
--      transaction. service_role only (0020's pattern).
--   C. A guard on project_evidence. INSERT: a file arrives 'unverified' (a file that arrives verified is refused). UPDATE: every column
--      except note and source_category is frozen (id, project_id, filename, media_type, sha256, byte_size, storage_ref, uploaded_at,
--      evidence_class); review_status may move only from 'unverified' to the decision on record, and only inside gf_review_evidence (the
--      function sets a transaction-local setting that this guard reads, and the guard ALSO requires a stored decision row that says the
--      same thing, so knowing the setting is not enough). DELETE of a file that has been decided is refused (the foreign key already refuses
--      one a decision row points at). The restore check loads a SCRATCH database under session_replication_role = replica, which skips this.
--   D. The history gains the 'evidence_reviewed' event (added to the list as it stands).
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
  -- The digest of the stored object as the reviewer's server computed it just now. Required to verify, optional to reject.
  sha256_confirmed text check (sha256_confirmed ~ '^[0-9a-f]{64}$'),
  reviewed_at timestamptz not null default now(),
  check (decision <> 'verified' or sha256_confirmed is not null)
);

create index if not exists project_evidence_reviews_project_idx on public.project_evidence_reviews (project_id);

create or replace function public.gf_evidence_review_guard() returns trigger
language plpgsql as $$
declare ev public.project_evidence;
begin
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

-- ---------------------------------------------------------------------------
-- B. The only way a status changes
-- ---------------------------------------------------------------------------
create or replace function public.gf_review_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
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
-- Privileges, per 0020/0038: the gf_* functions are service_role-only.
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
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.project_evidence_reviews from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on public.project_evidence_reviews to service_role;
  end if;
end
$$;
