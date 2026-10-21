-- 0040_integrity_hardening.sql — the database, not the application, refuses what the records must never allow
--
-- Found by an independent read of the PRODUCTION catalog and reproduced on a scratch database. Supabase's default ACLs hand
-- anon / authenticated / service_role ALL privileges on every new public table, and several invariants lived only in the
-- application or in a single RPC. This migration moves them into the schema. Additive and idempotent: no row is rewritten or
-- deleted, every constraint that existing rows might not satisfy is added NOT VALID (so it binds every new write) and then
-- VALIDATEd only if the existing rows satisfy it (a violation is a NOTICE, never a failed migration).
--
--   F6  The API roles (anon, authenticated) hold NO privilege on any public table, sequence or function, now or by default.
--       The browser client only calls /auth/v1 with the anon key (lib/supabase-client.ts, lib/portal.ts); every table is read
--       and written by the server with the service role.
--   F3  service_role can no longer TRUNCATE any public table, and every append-only / paid-record table has a BEFORE TRUNCATE
--       guard (gf_append_only, the pattern of 0025/0038) that also stops the table owner. DELETE stays granted: the application
--       deletes rows of founding_reservations (webhook, checkout), scenarios (a customer's own), operator_notices (a once-only
--       claim released on failure) and, through functions, rate_limit_windows and expired reservations. The restore check
--       (scripts/verify-backup-restore.py) empties a SCRATCH database under session_replication_role = replica, which skips triggers.
--   F2  The deposit/credit ledger is enforced by the tables, not only by gf_scope_deposit: a credit row must be the same buyer
--       (normalised email), from a product the catalogue says credits that deposit (data in engagement_credit_sources, with a
--       parity test against lib/products.ts creditsAgainst), no more than that source paid, added only while the deposit is being
--       scoped (contacted: a credit added to a scoped deposit would make its recorded credit disagree with the ledger), and a
--       deposit cannot become scoped unless its credit equals the ledger's sum and deposit + credit does not exceed the fee
--       (NULL-safe: a NULL credit is 0, never "no check").
--   F4  deliverables.status is a closed set, and a deliverable cannot BECOME released without a named reviewer in
--       intake->_gridforge->review->by (a proposal, which the operator writes already issued, is the one exemption).
--   F5  A response or comparison belongs to the package's own project (composite foreign key), a package's selection names a
--       response and a comparison of THAT package, and a case can only be attached if it exists.
--
-- NOT done here: tying a case to a project's buyer email. A project has no buyer email column (only a company name), so the
-- database cannot say whose it is; the application's check (the case's registered email must match the request) stays.

-- ---------------------------------------------------------------------------------------------------------------------
-- F6. The API roles hold nothing
-- ---------------------------------------------------------------------------------------------------------------------
do $$
declare r text; o text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = r) then continue; end if;
    execute format('revoke all on all tables in schema public from %I', r);
    execute format('revoke all on all sequences in schema public from %I', r);
    execute format('revoke all on all functions in schema public from %I', r);
    -- What a table created LATER inherits. Default ACLs belong to the role that creates the objects: the migration runner
    -- (postgres) and, on Supabase, supabase_admin. A role we cannot alter is reported, not fatal.
    foreach o in array array['postgres', 'supabase_admin'] loop
      if not exists (select 1 from pg_roles where rolname = o) then continue; end if;
      begin
        execute format('alter default privileges for role %I in schema public revoke all on tables from %I', o, r);
        execute format('alter default privileges for role %I in schema public revoke all on sequences from %I', o, r);
        execute format('alter default privileges for role %I in schema public revoke all on functions from %I', o, r);
      exception when insufficient_privilege then
        raise notice 'could not change the default privileges of role % for %: run this as that role', o, r;
      end;
    end loop;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- F3. No TRUNCATE for the service role; a guard for the owner and everyone else
-- ---------------------------------------------------------------------------------------------------------------------
do $$
declare o text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke truncate on all tables in schema public from service_role;
    foreach o in array array['postgres', 'supabase_admin'] loop
      if not exists (select 1 from pg_roles where rolname = o) then continue; end if;
      begin
        execute format('alter default privileges for role %I in schema public revoke truncate on tables from service_role', o);
      exception when insufficient_privilege then
        raise notice 'could not change the default privileges of role % for service_role', o;
      end;
    end loop;
  end if;
end
$$;

-- Every table whose rows are a record somebody paid for or a ledger that must never be emptied. (Tables the application
-- legitimately clears in bulk are not here: rate_limit_windows, founding_reservations, operator_notices.)
do $$
declare t text;
begin
  foreach t in array array[
    'usage_events', 'usage_settlements', 'engagement_credits', 'engagement_deposits', 'engagement_credit_sources',
    'customer_notifications', 'deliverables', 'watches', 'api_accounts', 'subscriptions',
    'cost_evidence', 'cost_evidence_retirements', 'cost_evidence_reviews', 'cost_evidence_runs',
    'procurement_packages', 'procurement_responses', 'procurement_comparisons', 'project_events'
  ] loop
    -- engagement_credit_sources is created below; guard it there.
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.gf_append_only()',
                   t || '_no_truncate', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- F2. The credit ledger's rules live in the tables
-- ---------------------------------------------------------------------------------------------------------------------
-- WHICH product credits WHICH deposit is data, not a branch: one row per (deposit kind, source kind), with the catalogue price
-- the source is worth when its own row recorded no amount. tests/test_integrity_hardening_migration.py fails if this table and
-- lib/products.ts (creditsAgainst, amountCents) ever disagree.
create table if not exists public.engagement_credit_sources (
  deposit_kind text not null check (length(btrim(deposit_kind)) > 0),
  source_kind text not null check (length(btrim(source_kind)) > 0),
  catalogue_cents int not null check (catalogue_cents > 0),
  primary key (deposit_kind, source_kind)
);
insert into public.engagement_credit_sources (deposit_kind, source_kind, catalogue_cents)
  values ('envelope_study_deposit', 'density_screen', 450000)
  on conflict (deposit_kind, source_kind) do nothing;
alter table public.engagement_credit_sources enable row level security;

drop trigger if exists engagement_credit_sources_append_only on public.engagement_credit_sources;
create trigger engagement_credit_sources_append_only
  before update or delete on public.engagement_credit_sources
  for each row execute function public.gf_append_only();
drop trigger if exists engagement_credit_sources_no_truncate on public.engagement_credit_sources;
create trigger engagement_credit_sources_no_truncate
  before truncate on public.engagement_credit_sources
  for each statement execute function public.gf_append_only();

create or replace function public.gf_credit_insert_guard() returns trigger
language plpgsql as $$
declare
  dep public.engagement_deposits;
  src public.deliverables;
  rule public.engagement_credit_sources;
  already bigint;
begin
  select * into dep from public.engagement_deposits where id = new.deposit_id for update;
  if not found then
    raise exception 'a credit needs an existing deposit' using errcode = '23503';
  end if;
  if dep.status <> 'contacted' then
    raise exception 'a credit is applied only while a deposit is being scoped (this one is %)', dep.status using errcode = '55000';
  end if;
  select * into src from public.deliverables where id = new.source_deliverable_id;
  if not found then
    raise exception 'credit source not found' using errcode = '23503';
  end if;
  if src.stripe_session_id is null then
    raise exception 'a credit must come from a paid engagement' using errcode = '55000';
  end if;
  if lower(btrim(coalesce(src.email, ''))) = '' or lower(btrim(coalesce(src.email, ''))) <> lower(btrim(coalesce(dep.email, ''))) then
    raise exception 'a credit applies only to the buyer who paid it' using errcode = '55000';
  end if;
  select * into rule from public.engagement_credit_sources where deposit_kind = dep.kind and source_kind = src.kind;
  if not found then
    raise exception 'a % does not credit a %', src.kind, dep.kind using errcode = '55000';
  end if;
  if new.amount_cents > coalesce(src.amount_cents, rule.catalogue_cents) then
    raise exception 'a credit cannot exceed what the engagement was paid' using errcode = '55000';
  end if;
  select coalesce(sum(amount_cents), 0) into already from public.engagement_credits where deposit_id = new.deposit_id;
  if dep.agreed_fee_cents is not null and dep.amount_cents + already + new.amount_cents > dep.agreed_fee_cents then
    raise exception 'the deposit and its credits cannot exceed the agreed fee' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists engagement_credits_insert_guard on public.engagement_credits;
create trigger engagement_credits_insert_guard
  before insert on public.engagement_credits
  for each row execute function public.gf_credit_insert_guard();

-- 0030's deposit guard, NULL-safe, and a scoped deposit's credit must be the ledger's sum.
create or replace function public.gf_deposit_guard() returns trigger
language plpgsql as $$
declare
  steps text[] := array['paid', 'contacted', 'scoped', 'delivered'];
  ledger bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_deposits is append-only: a payment record is never deleted' using errcode = '55000';
  end if;
  if new.stripe_session_id is distinct from old.stripe_session_id or new.kind is distinct from old.kind
     or new.amount_cents is distinct from old.amount_cents or new.currency is distinct from old.currency
     or new.email is distinct from old.email or new.company is distinct from old.company
     or new.project_id is distinct from old.project_id or new.paid_at is distinct from old.paid_at then
    raise exception 'the payment facts of a deposit never change' using errcode = '55000';
  end if;
  if array_position(steps, new.status) is distinct from array_position(steps, old.status) + 1 then
    raise exception 'a deposit moves forward one step at a time (% -> %)', old.status, new.status
      using errcode = '55000';
  end if;
  if (old.owner is not null and new.owner is distinct from old.owner)
     or (old.contacted_at is not null and new.contacted_at is distinct from old.contacted_at)
     or (old.scope_note is not null and new.scope_note is distinct from old.scope_note)
     or (old.scoped_at is not null and new.scoped_at is distinct from old.scoped_at) then
    raise exception 'recorded steps are not rewritten' using errcode = '55000';
  end if;
  if old.status = 'contacted' and new.status = 'scoped' then
    if new.agreed_fee_cents is null or new.delivery_due_on is null then
      raise exception 'scoping a deposit records the agreed fee and the delivery date' using errcode = '55000';
    end if;
    -- A NULL credit is zero. (`amount + NULL > fee` is NULL, and a NULL condition never raised: that was the hole.)
    new.credit_applied_cents := coalesce(new.credit_applied_cents, 0);
    if new.amount_cents + new.credit_applied_cents > new.agreed_fee_cents then
      raise exception 'the deposit and its credits cannot exceed the agreed fee' using errcode = '55000';
    end if;
    select coalesce(sum(amount_cents), 0) into ledger from public.engagement_credits where deposit_id = new.id;
    if new.credit_applied_cents <> ledger then
      raise exception 'the credit recorded on a deposit must equal what the credit ledger holds for it (% recorded, % in the ledger)',
        new.credit_applied_cents, ledger using errcode = '55000';
    end if;
  elsif new.agreed_fee_cents is distinct from old.agreed_fee_cents
     or new.credit_applied_cents is distinct from old.credit_applied_cents
     or new.delivery_due_on is distinct from old.delivery_due_on then
    raise exception 'the agreed fee, credit and delivery date are recorded at scoping and never rewritten'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- F4. A deliverable's status is a closed set; releasing it needs a named reviewer
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.deliverables drop constraint if exists deliverables_status_valid;
alter table public.deliverables add constraint deliverables_status_valid
  check (status in ('awaiting_intake', 'generating', 'draft', 'released', 'engine_unavailable')) not valid;
do $$
begin
  alter table public.deliverables validate constraint deliverables_status_valid;
exception when check_violation then
  raise notice 'existing deliverables have a status outside the closed set: deliverables_status_valid binds new writes but is not validated';
end
$$;

create or replace function public.gf_deliverable_release_guard() returns trigger
language plpgsql as $$
begin
  -- On the way INTO released only: a row that was released before a reviewer was recorded keeps working (bid comparisons are
  -- written to released rows), but nothing new becomes released anonymously. A proposal is written already issued by the operator.
  if new.status = 'released' and (tg_op = 'INSERT' or old.status is distinct from 'released') and new.kind is distinct from 'proposal' then
    if nullif(btrim(coalesce(new.intake -> '_gridforge' -> 'review' ->> 'by', '')), '') is null then
      raise exception 'a deliverable cannot be released without a named reviewer (intake._gridforge.review.by)' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deliverables_release_guard on public.deliverables;
create trigger deliverables_release_guard
  before insert or update on public.deliverables
  for each row execute function public.gf_deliverable_release_guard();

-- ---------------------------------------------------------------------------------------------------------------------
-- F5. A package belongs to its project, and what refers to it refers to the same project
-- ---------------------------------------------------------------------------------------------------------------------
-- Added only if absent, so a re-run does not drop a unique constraint the foreign keys depend on.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'procurement_packages_id_project_key' and conrelid = 'public.procurement_packages'::regclass) then
    alter table public.procurement_packages add constraint procurement_packages_id_project_key unique (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'procurement_responses_package_project_fkey' and conrelid = 'public.procurement_responses'::regclass) then
    alter table public.procurement_responses add constraint procurement_responses_package_project_fkey
      foreign key (package_id, project_id) references public.procurement_packages (id, project_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'procurement_comparisons_package_project_fkey' and conrelid = 'public.procurement_comparisons'::regclass) then
    alter table public.procurement_comparisons add constraint procurement_comparisons_package_project_fkey
      foreign key (package_id, project_id) references public.procurement_packages (id, project_id) not valid;
  end if;
end
$$;
do $$
begin
  alter table public.procurement_responses validate constraint procurement_responses_package_project_fkey;
exception when foreign_key_violation then
  raise notice 'existing responses name another project than their package: the foreign key binds new writes but is not validated';
end
$$;
do $$
begin
  alter table public.procurement_comparisons validate constraint procurement_comparisons_package_project_fkey;
exception when foreign_key_violation then
  raise notice 'existing comparisons name another project than their package: the foreign key binds new writes but is not validated';
end
$$;

-- 0015's selection trigger, plus: the selected response and comparison are this package's own.
create or replace function public.gf_package_selection_once() returns trigger
language plpgsql as $$
declare
  strip text[] := array['selected_supplier', 'selected_response_id',
                        'selected_comparison_id', 'selected_at', 'selected_by'];
begin
  if tg_op = 'DELETE' then
    if old.selected_supplier is not null then
      raise exception 'a package with a selected supplier cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.selected_supplier is not null then
    raise exception 'a supplier was already selected for this package' using errcode = '42501';
  end if;
  if (to_jsonb(new) - strip) <> (to_jsonb(old) - strip) then
    raise exception 'only the supplier selection may be set on a package' using errcode = '42501';
  end if;
  if new.selected_response_id is not null and not exists (
       select 1 from public.procurement_responses r
        where r.id = new.selected_response_id and r.package_id = new.id and r.project_id = new.project_id) then
    raise exception 'the selected response is not a response to this package' using errcode = '23503';
  end if;
  if new.selected_comparison_id is not null and not exists (
       select 1 from public.procurement_comparisons c
        where c.id = new.selected_comparison_id and c.package_id = new.id and c.project_id = new.project_id) then
    raise exception 'the selected comparison is not a comparison of this package' using errcode = '23503';
  end if;
  return new;
end;
$$;

-- 0015's gf_attach_case, plus: the case must exist (a link to a token nobody issued is a dangling claim on a project).
create or replace function public.gf_attach_case(p_project uuid, p_case_token text,
                                                 p_event jsonb) returns jsonb
language plpgsql as $$
declare v uuid;
begin
  if not exists (select 1 from public.power_deployment_cases where case_token = p_case_token) then
    raise exception 'that case does not exist' using errcode = '23503';
  end if;
  insert into public.project_links (project_id, object_type, object_id)
  values (p_project, 'power_deployment_case', p_case_token)
  on conflict (project_id, object_type, object_id) do nothing
  returning id into v;
  if v is null then
    return jsonb_build_object('created', false);
  end if;
  perform public.gf_emit(p_project, p_event);
  return jsonb_build_object('created', true, 'link_id', v);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- F1  a project's history must not hold the Stripe session id
--
-- The session id is what /commissioned turns into the buyer's private intake / API-access / watch link, and a project's event
-- history is readable by whoever holds the project token or a share link. New attachments carry payload.session_ref, the
-- SHA-256 of the session id, and idempotency moves to that. Events written before this migration keep their (append-only,
-- immutable) raw id, which the API no longer returns (lib/project-state.ts allow-list); a redelivered webhook for such a
-- session is still recognised here by hashing the stored id.
-- ---------------------------------------------------------------------------------------------------------------------
create unique index if not exists project_events_one_purchase_per_session_ref
  on public.project_events ((payload ->> 'session_ref'))
  where event_type = 'paid_product_attached' and payload ? 'session_ref';

create or replace function public.gf_attach_purchase(p_project uuid, p_object_type text,
                                                     p_object_id text, p_event jsonb) returns jsonb
language plpgsql as $$
declare v uuid; c text; ref text := p_event -> 'payload' ->> 'session_ref';
begin
  if ref is not null and exists (
       select 1 from public.project_events e
       where e.event_type = 'paid_product_attached'
         and (e.payload ->> 'session_ref' = ref
              or encode(sha256(convert_to(e.payload ->> 'stripe_session_id', 'UTF8')), 'hex') = ref)) then
    return jsonb_build_object('created', false);       -- this Stripe session was already attached
  end if;
  if p_object_type is not null then
    if p_object_type not in ('deliverable', 'watch') then
      raise exception 'a purchase attaches as a deliverable or a watch, not %', p_object_type
        using errcode = '22023';
    end if;
    insert into public.project_links (project_id, object_type, object_id)
    values (p_project, p_object_type, p_object_id)
    on conflict (project_id, object_type, object_id) do nothing
    returning id into v;
    if v is null then
      return jsonb_build_object('created', false);   -- already attached: its event exists too
    end if;
  end if;
  perform public.gf_emit(p_project, p_event);
  return jsonb_build_object('created', true);
exception when unique_violation then
  get stacked diagnostics c = constraint_name;
  if c = 'project_links_one_project_per_object' then
    raise;                                            -- belongs to another project: refuse
  end if;
  return jsonb_build_object('created', false);        -- this Stripe session was already attached
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privileges of what this migration created (the revokes above ran BEFORE some of it existed)
-- ---------------------------------------------------------------------------------------------------------------------
do $$
declare r text; f text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke truncate on all tables in schema public from service_role;
    for f in select p.oid::regprocedure::text from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'gf\_%' loop
      execute format('revoke all on function %s from public', f);
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end
$$;
