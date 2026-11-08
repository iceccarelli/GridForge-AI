-- 0054_project_quotation_claims.sql: a supplier quotation a PROJECT HOLDER attaches to an uploaded file becomes cost evidence only after
-- a person has verified that file AND accepted the record. It reuses the 0022 quotation lifecycle; it adds no second one.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. Requires 0015 (projects, project_evidence), 0022 + 0023
-- (cost_evidence and its state view), 0026 (gf_save_comparison) and 0048 (gf_review_evidence and its decision table). Until it is applied the
-- project routes that submit or list a quotation claim answer 503 ("not available"), nothing else changes, and every earlier quotation (the
-- ones that arrive through a Procurement Specification engagement) behaves exactly as before.
--
-- REPLAY ORDER. This migration holds the FINAL definitions of gf_review_cost_evidence, gf_retire_cost_evidence and gf_save_comparison, of the
-- cost_evidence_state view and of the two row triggers below. Re-running 0022, 0023 or 0026 after it silently replaces the functions and the view
-- with older, weaker ones (no file gate in the function; a project-level line could not be named by a saved comparison). The ROW TRIGGERS are what
-- keep the file gate in force even then: they are not touched by 0022/0023/0026, so a replay of those cannot remove them, and only a replay of 0054
-- itself changes them (CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS, so it is idempotent). Migrations are applied once, in order
-- (scripts/apply-migration.py gate 2). tests/test_project_quotation_final_gate.py reads the FINAL function and trigger definitions from a database
-- built by the whole chain, and from one with 0022/0026 replayed after it, and fails if any gate is missing.
--
-- Why. 0022 takes a quotation only from a released Procurement Specification (an engagement bought on this site) and ties no quotation to a
-- document. A buyer who already holds a supplier's PDF could not use it: the document could be uploaded as project evidence (0015) and
-- verified (0048), but nothing connected the file to a price, and nothing refused to count a price whose file nobody had checked.
--
--   A. cost_evidence gains an ORIGIN. A line is either an engagement line (deliverable_id set, source_file_id null: exactly the 0022 lines) or a
--      PROJECT line (deliverable_id null, source_file_id = the project_evidence row of the quotation document, project_id = that file's project).
--      The CHECK makes anything between the two impossible. A project line also carries what the submitter CLAIMED: the quote type
--      ('firm_quote' or 'indicative_quote'), the lead time in weeks, the scope notes and who submitted it (text typed under the project token, not an
--      authenticated identity). None of it is verified by being stored. The line is append-only like every cost_evidence row (the 0022 trigger).
--   B. gf_submit_project_quotation: the ONLY writer of a project line. It refuses a file that is not this project's, a file already rejected, a
--      validity date that is already past or earlier than the quotation date, and the 101st claim of a project. The same claim twice is the same
--      line (unique on (project, digest)): a retry creates nothing and writes no second event.
--   C. gf_review_cost_evidence (final): everything 0022 required, and an ACCEPTANCE of a project line needs its file to be VERIFIED: review_status
--      'verified' AND a decision row (0048) whose sha256_confirmed equals the file's stored digest (GF009 otherwise). A rejection needs no file
--      check. The advisory lock and the "one accepted line per cost key is current" rule now work for a project line too (the 0022 key was
--      deliverable-based, and a null deliverable would have made the lock a silent no-op).
--   D. gf_retire_cost_evidence (final): the same lock key.
--   E. gf_save_comparison (final): a saved comparison may name an accepted PROJECT line of its own project (stamped with this project, a file
--      attached, not synthetic, EUR); the earlier rule for engagement lines is unchanged.
--   F. cost_evidence_state is recreated with the new columns APPENDED, so every existing column keeps its name, type and position.
--   G. TWO ROW TRIGGERS make the rules hold for a direct INSERT too (a service_role / PostgREST caller who skips the functions), as 0048 did for
--      review decisions. gf_cost_evidence_review_guard (BEFORE INSERT on cost_evidence_reviews): for a PROJECT line, an acceptance needs the file to
--      belong to the line's project, review_status 'verified' AND a 'verified' decision row whose sha256_confirmed equals the stored digest (GF009);
--      and the reviewer may not be the submitter (GF014: compared trimmed and case-insensitively, as for observations). gf_cost_evidence_line_guard
--      (BEFORE INSERT on cost_evidence): a project line's file must be its own project's (GF010), not rejected (GF011), its validity date may not
--      have passed and its quotation date may not be in the future (GF012). Neither trigger touches an engagement line. A restore under
--      session_replication_role = replica skips them, like the other guards.
--   H. Text and number bounds in the CHECK are the SAME bounds the site applies: no control, invisible or direction-changing code point (the list is
--      in gf_quotation_text_ok and in lib/cost-evidence-claims.ts BAD_RANGES, cross-checked by a test: it does NOT use [[:cntrl:]], which depends on
--      the cluster's locale), a price of at least 0.01 EUR, a quantity of at least 0.001 (a denormal would make the engine's capex infinite).
--
-- QUOTATION DATE RULE (project claims). The engine resolves two accepted lines for one cost key by their quoted_on, newest winning. A project claim
-- is therefore refused if its quotation date is in the future, so a budgetary claim dated tomorrow cannot displace a contracted or firm
-- engagement quotation on the day it is accepted. Engagement lines (0022) are unchanged.
--
-- RE-ENTERING A REJECTED CLAIM. A decision is final. A rejected claim is not re-opened: record the quotation again with the corrected figure, dates,
-- notes or document and it is a NEW line (the digest covers every claimed field), reviewed afresh. The same claim, byte for byte, is the same line.
--
-- WHAT THIS DOES NOT DO. It does not verify that a price is true, that a lead time will be met, or that the supplier exists: a verified file is a
-- file whose bytes are unchanged since upload, and an accepted record is a named person's decision (typed under the shared admin password, as in
-- 0048). It prices nothing, rewrites no row, changes no product, and the engine never sees a supplier's document: only the accepted record's price,
-- unit, dates, scope and supplier name, for one request.
--
-- Additive and idempotent. RLS stays on, with no policy: service role only.

-- ---------------------------------------------------------------------------
-- A. The origin of a line
-- ---------------------------------------------------------------------------
alter table public.cost_evidence alter column deliverable_id drop not null;

alter table public.cost_evidence
  add column if not exists source_file_id uuid references public.project_evidence (id),
  add column if not exists claimed_quote_type text,
  add column if not exists lead_time_weeks numeric,
  add column if not exists notes text,
  add column if not exists submitted_by text;

-- Text a reviewer reads must be what it looks like. The same code points as lib/cost-evidence-claims.ts BAD_RANGES (a test compares them one by one);
-- never [[:cntrl:]], whose meaning depends on the cluster's locale (under C.utf8 a newline passed). `multiline` (the notes) allows tab, LF and CR only.
create or replace function public.gf_quotation_text_ok(t text, multiline boolean) returns boolean
language sql immutable as $fn$
  select t is not null
     and t !~ E'[\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f-\\u1160\\u17b4-\\u17b5\\u180b-\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb\\U000e0000-\\U000e007f\\U000e0100-\\U000e01ef]'
     and (multiline or t !~ E'[\\u0009\\u000a\\u000d]')
$fn$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cost_evidence_origin' and conrelid = 'public.cost_evidence'::regclass) then
    alter table public.cost_evidence add constraint cost_evidence_origin check (
      (deliverable_id is not null
        and source_file_id is null and claimed_quote_type is null and lead_time_weeks is null and notes is null and submitted_by is null)
      or
      (deliverable_id is null and source_file_id is not null and project_id is not null
        and coalesce(claimed_quote_type in ('firm_quote', 'indicative_quote'), false)
        and coalesce(length(btrim(submitted_by)) between 1 and 120, false)
        and (lead_time_weeks is null or (lead_time_weeks > 0 and lead_time_weeks <= 520))
        and (notes is null or length(notes) <= 1000)
        and validation_status = 'validated' and synthetic = false
        and coalesce(valid_until >= received_on, false)
        and coalesce(value >= 0.01 and value <= 1000000000, false)
        and (quoted_quantity is null or (quoted_quantity >= 0.001 and quoted_quantity <= 1000000000))
        and unit ~ '^[A-Za-z0-9/]{1,20}$' and (quoted_quantity_unit is null or quoted_quantity_unit ~ '^[A-Za-z0-9/]{1,20}$')
        and length(supplier) <= 120 and length(scope) <= 300
        and public.gf_quotation_text_ok(supplier, false) and public.gf_quotation_text_ok(scope, false) and public.gf_quotation_text_ok(submitted_by, false)
        and (notes is null or public.gf_quotation_text_ok(notes, true))
        and (reference is null or (length(reference) <= 120 and public.gf_quotation_text_ok(reference, false))))
    );
  end if;
end
$$;

-- The same claim twice is one line: a project line has no deliverable, so the 0022 unique (deliverable, digest) does not cover it.
create unique index if not exists cost_evidence_project_line_uq
  on public.cost_evidence (project_id, line_digest) where deliverable_id is null;
create index if not exists cost_evidence_source_file_idx on public.cost_evidence (source_file_id) where source_file_id is not null;

-- ---------------------------------------------------------------------------
-- F. The state view, new columns appended (see 0023 for the shape it extends)
-- ---------------------------------------------------------------------------
create or replace view public.cost_evidence_state with (security_invoker = true) as
select e.id, e.deliverable_id, e.project_id, e.line_digest, e.cost_key, e.unit, e.value, e.submitted_value, e.currency, e.supplier,
       e.received_on, e.valid_until, e.reference, e.scope, e.quoted_quantity, e.quoted_quantity_unit, e.specification,
       e.response_digest, e.validation_status, e.problems, e.limitations, e.comparability, e.synthetic, e.submitted_at,
       r.decision, r.basis as reviewed_basis, r.comparability as reviewed_comparability, r.includes_keys,
       r.region as reviewed_region, r.reviewer, r.reviewed_at, r.reason as review_reason,
       t.kind as retired_kind, t.superseded_by, t.retired_at,
       case when t.evidence_id is not null then t.kind
            when r.decision = 'accepted' then 'accepted'
            when r.decision = 'rejected' then 'rejected'
            when e.validation_status = 'validated' then 'validated'
            else 'invalid' end as state,
       t.reason as retirement_reason, t.retired_by,
       e.source_file_id, e.claimed_quote_type, e.lead_time_weeks, e.notes, e.submitted_by
from public.cost_evidence e
left join public.cost_evidence_reviews r on r.evidence_id = e.id
left join public.cost_evidence_retirements t on t.evidence_id = e.id;

-- ---------------------------------------------------------------------------
-- B. The only writer of a project line
-- ---------------------------------------------------------------------------
create or replace function public.gf_submit_project_quotation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare f public.project_evidence; proj uuid; r public.cost_evidence; existing public.cost_evidence; n int;
begin
  proj := (p->>'project_id')::uuid;
  select * into f from public.project_evidence where id = (p->>'source_file_id')::uuid;
  if not found or f.project_id is distinct from proj then
    raise exception 'that file is not part of this project' using errcode = 'GF010';
  end if;
  if f.review_status = 'rejected' then
    raise exception 'that file was reviewed and rejected, so a quotation cannot rest on it' using errcode = 'GF011';
  end if;
  if (p->>'valid_until')::date < current_date then
    raise exception 'that quotation has already expired' using errcode = 'GF012';
  end if;
  if (p->>'valid_until')::date < (p->>'received_on')::date then
    raise exception 'the validity date is earlier than the quotation date' using errcode = 'GF012';
  end if;
  if (p->>'received_on')::date > current_date then
    raise exception 'the quotation date is in the future' using errcode = 'GF012';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('project-quotation:' || proj::text, 0));
  select * into existing from public.cost_evidence where project_id = proj and deliverable_id is null and line_digest = p->>'line_digest';
  if found then
    return jsonb_build_object('created', false, 'id', existing.id, 'state', (select s.state from public.cost_evidence_state s where s.id = existing.id));
  end if;
  select count(*) into n from public.cost_evidence where project_id = proj and deliverable_id is null;
  if n >= 100 then
    raise exception 'a project holds at most 100 quotation claims' using errcode = 'GF013';
  end if;

  insert into public.cost_evidence (deliverable_id, project_id, source_file_id, line_digest, cost_key, unit, value, submitted_value, currency,
        supplier, received_on, valid_until, reference, scope, quoted_quantity, quoted_quantity_unit, specification, response_digest,
        validation_status, problems, limitations, comparability, synthetic, claimed_quote_type, lead_time_weeks, notes, submitted_by)
  values (null, proj, f.id, p->>'line_digest', p->>'cost_key', p->>'unit', (p->>'value')::numeric, (p->>'value')::numeric, 'EUR',
          p->>'supplier', (p->>'received_on')::date, (p->>'valid_until')::date, nullif(p->>'reference', ''), p->>'scope',
          nullif(p->>'quoted_quantity', '')::numeric, nullif(p->>'quoted_quantity_unit', ''),
          jsonb_build_object('project', proj, 'file', f.id, 'origin', 'project quotation claim'),
          f.sha256, 'validated', '[]'::jsonb, coalesce(p->'limitations', '[]'::jsonb), p->>'comparability', false,
          p->>'claimed_quote_type', nullif(p->>'lead_time_weeks', '')::numeric, nullif(p->>'notes', ''), p->>'submitted_by')
  returning * into r;
  perform public.gf_emit(proj, p_event, jsonb_build_object('evidence_id', r.id, 'cost_key', r.cost_key,
                         'validation_status', r.validation_status, 'synthetic', false, 'source_file_id', f.id));
  return jsonb_build_object('created', true, 'id', r.id, 'state', 'validated');
end;
$$;

-- ---------------------------------------------------------------------------
-- C. The decision: a project line is accepted only on a verified file
-- ---------------------------------------------------------------------------
create or replace function public.gf_review_cost_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare e public.cost_evidence; rev public.cost_evidence_reviews; prev uuid; retired uuid[] := '{}';
begin
  select * into e from public.cost_evidence where id = (p->>'evidence_id')::uuid;
  if not found then raise exception 'no such evidence' using errcode = '23503'; end if;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(e.deliverable_id::text, 'project:' || e.project_id::text) || ':' || e.cost_key, 0));
  if exists (select 1 from public.cost_evidence_reviews where evidence_id = e.id) then
    raise exception 'this evidence has already been reviewed' using errcode = '23505';
  end if;
  if p->>'decision' = 'accepted' then
    if e.validation_status <> 'validated' then
      raise exception 'only a validated quotation line can be accepted' using errcode = '23514';
    end if;
    if e.valid_until is not null and e.valid_until < current_date then
      raise exception 'this quotation has expired and cannot be accepted' using errcode = '23514';
    end if;
    -- A project line rests on a document. The document must have been verified by a person (the server read the stored bytes back and the
    -- digest equals the one recorded at upload: 0048), and it must still be this project's file.
    if e.source_file_id is not null and not exists (
         select 1 from public.project_evidence pe
           join public.project_evidence_reviews er on er.evidence_id = pe.id
          where pe.id = e.source_file_id and pe.project_id = e.project_id
            and pe.review_status = 'verified' and er.decision = 'verified' and er.sha256_confirmed = pe.sha256) then
      raise exception 'the quotation''s file has not been verified, so the quotation cannot be accepted' using errcode = 'GF009';
    end if;
    for prev in
      select s.id from public.cost_evidence_state s
       where s.cost_key = e.cost_key and s.state = 'accepted' and s.id <> e.id
         and ((e.deliverable_id is not null and s.deliverable_id = e.deliverable_id)
              or (e.deliverable_id is null and s.deliverable_id is null and s.project_id = e.project_id))
    loop
      insert into public.cost_evidence_retirements (evidence_id, kind, superseded_by, reason, retired_by)
      values (prev, 'superseded', e.id, 'replaced by a newer accepted quotation', p->>'reviewer');
      retired := retired || prev;
    end loop;
  end if;
  insert into public.cost_evidence_reviews (evidence_id, decision, basis, comparability, includes_keys, region,
                                            reviewer, reason)
  values (e.id, p->>'decision', nullif(p->>'basis', ''), nullif(p->>'comparability', ''),
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'includes_keys', '[]'::jsonb)) x),
                   '{}'), nullif(p->>'region', ''), p->>'reviewer', nullif(p->>'reason', ''))
  returning * into rev;
  if e.project_id is not null then
    perform public.gf_emit(e.project_id, p_event, jsonb_build_object('evidence_id', e.id, 'cost_key', e.cost_key,
        'decision', rev.decision, 'basis', rev.basis, 'superseded', to_jsonb(retired)));
  end if;
  return jsonb_build_object('review', to_jsonb(rev), 'superseded', to_jsonb(retired));
end;
$$;

-- ---------------------------------------------------------------------------
-- D. Withdrawal: the same lock key
-- ---------------------------------------------------------------------------
create or replace function public.gf_retire_cost_evidence(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare e public.cost_evidence; s public.cost_evidence_state;
begin
  select * into s from public.cost_evidence_state where id = (p->>'evidence_id')::uuid;
  if not found then raise exception 'no such evidence' using errcode = '23503'; end if;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(s.deliverable_id::text, 'project:' || s.project_id::text) || ':' || s.cost_key, 0));
  select * into s from public.cost_evidence_state where id = s.id;
  if s.state <> 'accepted' then
    raise exception 'only accepted evidence can be withdrawn; this is %', s.state using errcode = '23514';
  end if;
  insert into public.cost_evidence_retirements (evidence_id, kind, reason, retired_by)
  values (s.id, 'withdrawn', nullif(p->>'reason', ''), p->>'retired_by');
  if s.project_id is not null then
    perform public.gf_emit(s.project_id, p_event, jsonb_build_object('evidence_id', s.id, 'cost_key', s.cost_key,
                                                                    'kind', 'withdrawn'));
  end if;
  return jsonb_build_object('retired', true, 'id', s.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- E. A saved comparison may name an accepted PROJECT line of its own project (0026 otherwise unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.gf_save_comparison(p jsonb, p_event jsonb,
                                                     p_new_project jsonb default null,
                                                     p_new_event jsonb default null) returns jsonb
language plpgsql as $$
declare pid uuid; r public.project_comparisons; ids uuid[]; k record; ok int;
begin
  if p_new_project is not null then
    pid := (public.gf_create_project(p_new_project, p_new_event)->>'id')::uuid;
  else
    pid := (p->>'project_id')::uuid;
  end if;

  ids := coalesce(array(select distinct x::uuid
                          from jsonb_array_elements_text(coalesce(p->'evidence_ids', '[]'::jsonb)) x), '{}');
  if cardinality(ids) > 0 then
    if p_new_project is not null then
      raise exception 'a new project has no accepted quotations to rest a comparison on' using errcode = '23514';
    end if;
    -- Take turns with review and withdrawal of these lines (the same key gf_review_cost_evidence and gf_retire_cost_evidence take), in a fixed order.
    for k in select distinct coalesce(e.deliverable_id::text, 'project:' || e.project_id::text) as scope_key, e.cost_key
               from public.cost_evidence e
              where e.id = any(ids) order by 1, 2 loop
      perform pg_advisory_xact_lock(hashtextextended(k.scope_key || ':' || k.cost_key, 0));
    end loop;
    select count(*) into ok from public.cost_evidence_state s
     where s.id = any(ids)
       and s.state = 'accepted'
       and s.project_id = pid
       and s.currency = 'EUR'
       and not s.synthetic
       and ((s.deliverable_id is null and s.source_file_id is not null)
            or exists (select 1 from public.project_links l
                        where l.project_id = pid and l.object_type = 'deliverable'
                          and l.object_id = s.deliverable_id::text));
    if ok <> cardinality(ids) then
      raise exception 'a comparison can only rest on accepted quotations of its own project' using errcode = '23514';
    end if;
  end if;

  insert into public.project_comparisons (project_id, request, result, schema, request_digest,
                                          provenance_digest, engine_version, grade, evidence_ids, saved_at)
  values (pid, p->'request', p->'result', p->>'schema', p->>'request_digest',
          p->>'provenance_digest', p->>'engine_version', p->>'grade', ids,
          coalesce((p->>'saved_at')::timestamptz, now()))
  on conflict (project_id, request_digest, provenance_digest) do nothing
  returning * into r;

  if not found then
    select * into r from public.project_comparisons
     where project_id = pid and request_digest = p->>'request_digest'
       and provenance_digest = p->>'provenance_digest';
    return jsonb_build_object('created', false, 'project_id', pid, 'comparison_id', r.id);
  end if;

  perform public.gf_emit(pid, p_event, jsonb_build_object('comparison_id', r.id));
  return jsonb_build_object('created', true, 'project_id', pid, 'comparison_id', r.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- G. Row triggers: the same rules for a direct INSERT (service_role / PostgREST), as 0048 did for review decisions
-- ---------------------------------------------------------------------------
create or replace function public.gf_cost_evidence_line_guard() returns trigger
language plpgsql as $$
declare f public.project_evidence;
begin
  if new.source_file_id is null then
    return new;                                              -- an engagement line: not this guard's business
  end if;
  select * into f from public.project_evidence where id = new.source_file_id;
  if not found or f.project_id is distinct from new.project_id then
    raise exception 'that file is not part of this project' using errcode = 'GF010';
  end if;
  if f.review_status = 'rejected' then
    raise exception 'that file was reviewed and rejected, so a quotation cannot rest on it' using errcode = 'GF011';
  end if;
  if new.valid_until is null or new.valid_until < current_date then
    raise exception 'that quotation has already expired' using errcode = 'GF012';
  end if;
  if new.received_on is null or new.received_on > current_date then
    raise exception 'the quotation date is in the future' using errcode = 'GF012';
  end if;
  return new;
end;
$$;

drop trigger if exists cost_evidence_line_guard on public.cost_evidence;
create trigger cost_evidence_line_guard before insert on public.cost_evidence
  for each row execute function public.gf_cost_evidence_line_guard();

create or replace function public.gf_cost_evidence_review_guard() returns trigger
language plpgsql as $$
declare e public.cost_evidence;
begin
  select * into e from public.cost_evidence where id = new.evidence_id;
  if not found or e.source_file_id is null then
    return new;                                              -- an engagement line (or none): the 0022 rules alone
  end if;
  if lower(btrim(new.reviewer)) = lower(btrim(e.submitted_by)) then
    raise exception 'the reviewer cannot be the person who submitted the quotation' using errcode = 'GF014';
  end if;
  if new.decision = 'accepted' and not exists (
       select 1 from public.project_evidence pe
         join public.project_evidence_reviews er on er.evidence_id = pe.id
        where pe.id = e.source_file_id and pe.project_id = e.project_id
          and pe.review_status = 'verified' and er.decision = 'verified' and er.sha256_confirmed = pe.sha256) then
    raise exception 'the quotation''s file has not been verified, so the quotation cannot be accepted' using errcode = 'GF009';
  end if;
  return new;
end;
$$;

drop trigger if exists cost_evidence_review_guard on public.cost_evidence_reviews;
create trigger cost_evidence_review_guard before insert on public.cost_evidence_reviews
  for each row execute function public.gf_cost_evidence_review_guard();

-- ---------------------------------------------------------------------------
-- Privileges, per 0020/0022/0026: the gf_* functions are service_role-only; the view is service-role-only.
-- ---------------------------------------------------------------------------
do $$
declare r text; f text;
begin
  foreach f in array array['public.gf_submit_project_quotation(jsonb, jsonb)', 'public.gf_review_cost_evidence(jsonb, jsonb)',
                           'public.gf_retire_cost_evidence(jsonb, jsonb)', 'public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb)',
                           'public.gf_cost_evidence_line_guard()', 'public.gf_cost_evidence_review_guard()', 'public.gf_quotation_text_ok(text, boolean)'] loop
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
  revoke all on public.cost_evidence_state from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.cost_evidence_state from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.cost_evidence_state to service_role;
  end if;
end
$$;
