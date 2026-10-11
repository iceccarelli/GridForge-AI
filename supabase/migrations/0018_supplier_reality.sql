-- 0018_supplier_reality.sql — what a supplier PROMISED against what the project EXPERIENCED
--
--   selected supplier's stored quote  ->  actual-delivery record (typed, sourced, named)
--                                     ->  human review  ->  derived quoted-vs-actual
--
-- This is a record, not a signal. Nothing here feeds gridforge/costs.py, supplier rankings,
-- benchmarks or the calibration ledger; the derivation is a read-only view, and whether a
-- number may ever be reused elsewhere is a later, explicit, human decision.
--
--   * The QUOTE is never typed by the submitter. The function copies it from the stored
--     response of the package's authoritative selection (price EUR, lead time, install time).
--     Without a recorded selection there is nothing to compare against and nothing is accepted.
--   * Every actual-delivery fact is optional and unknown stays NULL. At least one must be given.
--   * An actual cost carries an explicit currency and an explicit scope relationship to the
--     quote. 'unknown' and 'differs' are valid, honest answers; they are never compared.
--   * A submission is immutable. A correction is a NEW record that supersedes exactly one
--     earlier record (no forks); the earlier one stays, with its review.
--   * A review is separate, immutable, human, and one per record.

alter table public.project_events drop constraint if exists project_events_event_type_check;
alter table public.project_events add constraint project_events_event_type_check
  check (event_type in ('project_created', 'btm_case_attached', 'btm_case_revised',
                        'rfq_generated', 'supplier_response_received',
                        'comparison_completed', 'supplier_selected', 'evidence_attached',
                        'paid_product_attached', 'observation_submitted', 'observation_reviewed',
                        'supplier_actual_submitted', 'supplier_actual_reviewed'));

create table if not exists public.supplier_actuals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  package_id uuid not null references public.procurement_packages (id),
  -- Copied by the database from the package's selection; never caller-supplied.
  selected_response_id uuid not null references public.procurement_responses (id),
  supplier text not null,
  case_token text not null,
  case_revision int not null,
  architecture text not null,
  quoted_capex_eur numeric,
  quoted_lead_time_weeks numeric,
  quoted_install_weeks numeric,
  quoted_snapshot jsonb not null,
  -- What happened. Every one may be unknown (NULL).
  po_date date,
  dispatch_date date,          -- as confirmed by the supplier
  on_site_date date,
  install_complete_date date,
  energised_date date,
  actual_cost numeric check (actual_cost is null or actual_cost >= 0),
  actual_cost_currency text,
  -- Is the actual cost the same thing the quote priced? Never assumed.
  cost_scope text check (cost_scope in ('same_as_quote', 'differs', 'unknown')),
  cost_scope_note text,
  evidence_id uuid not null references public.project_evidence (id),
  method text not null check (length(btrim(method)) > 0),
  submitted_by text not null check (length(btrim(submitted_by)) > 0),
  submitted_at timestamptz not null default now(),
  -- A correction names the single record it replaces.
  supersedes_id uuid references public.supplier_actuals (id),
  note text,
  check (po_date is not null or dispatch_date is not null or on_site_date is not null
         or install_complete_date is not null or energised_date is not null
         or actual_cost is not null),
  check ((actual_cost is null) = (actual_cost_currency is null)),
  check ((actual_cost is null) = (cost_scope is null)),
  check (actual_cost_currency is null or actual_cost_currency ~ '^[A-Z]{3}$'),
  check (cost_scope is distinct from 'differs' or length(btrim(coalesce(cost_scope_note, ''))) > 0),
  -- Dates that cannot be true in this order are refused, not stored.
  check (po_date is null or dispatch_date is null or po_date <= dispatch_date),
  check (po_date is null or on_site_date is null or po_date <= on_site_date),
  check (dispatch_date is null or on_site_date is null or dispatch_date <= on_site_date),
  check (on_site_date is null or install_complete_date is null or on_site_date <= install_complete_date),
  check (on_site_date is null or energised_date is null or on_site_date <= energised_date),
  check (install_complete_date is null or energised_date is null or install_complete_date <= energised_date)
);

create index if not exists supplier_actuals_project_idx
  on public.supplier_actuals (project_id, submitted_at);

-- Exactly one first record per package; a record is replaced at most once (a line, not a tree).
create unique index if not exists supplier_actuals_one_initial
  on public.supplier_actuals (package_id) where supersedes_id is null;
create unique index if not exists supplier_actuals_one_correction
  on public.supplier_actuals (supersedes_id) where supersedes_id is not null;

create table if not exists public.supplier_actual_reviews (
  id uuid primary key default gen_random_uuid(),
  actual_id uuid not null unique references public.supplier_actuals (id),
  project_id uuid not null references public.projects (id),
  decision text not null check (decision in ('verified', 'rejected')),
  -- Which supplied facts the reviewer vouches for. A fact not listed stays unverified.
  verified_fields text[] not null default '{}',
  reviewer text not null check (length(btrim(reviewer)) > 0),
  reason text,
  reviewed_at timestamptz not null default now(),
  check ((decision = 'verified') = (cardinality(verified_fields) > 0)),
  check (verified_fields <@ array['po_date','dispatch_date','on_site_date','install_complete_date',
                                   'energised_date','actual_cost']),
  check (decision <> 'rejected' or length(btrim(coalesce(reason, ''))) > 0)
);

drop trigger if exists supplier_actuals_append_only on public.supplier_actuals;
create trigger supplier_actuals_append_only
  before update or delete on public.supplier_actuals
  for each row execute function public.gf_append_only();

drop trigger if exists supplier_actual_reviews_append_only on public.supplier_actual_reviews;
create trigger supplier_actual_reviews_append_only
  before update or delete on public.supplier_actual_reviews
  for each row execute function public.gf_append_only();

alter table public.supplier_actuals enable row level security;
alter table public.supplier_actual_reviews enable row level security;

-- Submission + history event, one transaction. Quote and supplier come from the selection.
create or replace function public.gf_submit_supplier_actual(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare pk public.procurement_packages; rs public.procurement_responses;
        prev public.supplier_actuals; r public.supplier_actuals; v jsonb;
begin
  select * into pk from public.procurement_packages
   where id = (p->>'package_id')::uuid and project_id = (p->>'project_id')::uuid;
  if not found then
    raise exception 'no such package in this project' using errcode = '23503';
  end if;
  if pk.selected_supplier is null or pk.selected_response_id is null then
    raise exception 'no supplier has been selected for this package' using errcode = '23514';
  end if;
  select * into rs from public.procurement_responses
   where id = pk.selected_response_id and package_id = pk.id;
  if not found then
    raise exception 'the selection does not point at a stored response of this package' using errcode = '23514';
  end if;
  if not exists (select 1 from public.project_evidence
                  where id = (p->>'evidence_id')::uuid and project_id = pk.project_id) then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  if p->>'supersedes_id' is not null then
    select * into prev from public.supplier_actuals
     where id = (p->>'supersedes_id')::uuid and package_id = pk.id;
    if not found then
      raise exception 'no such record to correct on this package' using errcode = '23503';
    end if;
  end if;
  v := coalesce(rs.response->'values', '{}'::jsonb);
  insert into public.supplier_actuals (project_id, package_id, selected_response_id, supplier,
        case_token, case_revision, architecture, quoted_capex_eur, quoted_lead_time_weeks,
        quoted_install_weeks, quoted_snapshot, po_date, dispatch_date, on_site_date,
        install_complete_date, energised_date, actual_cost, actual_cost_currency, cost_scope,
        cost_scope_note, evidence_id, method, submitted_by, submitted_at, supersedes_id, note)
  values (pk.project_id, pk.id, rs.id, rs.supplier, pk.case_token, pk.case_revision, pk.architecture,
          case when jsonb_typeof(v->'capex_eur') = 'number' then (v->>'capex_eur')::numeric end,
          case when jsonb_typeof(v->'lead_time_weeks') = 'number' then (v->>'lead_time_weeks')::numeric end,
          case when jsonb_typeof(v->'install_weeks') = 'number' then (v->>'install_weeks')::numeric end,
          v,
          (p->>'po_date')::date, (p->>'dispatch_date')::date, (p->>'on_site_date')::date,
          (p->>'install_complete_date')::date, (p->>'energised_date')::date,
          (p->>'actual_cost')::numeric, p->>'actual_cost_currency', p->>'cost_scope',
          p->>'cost_scope_note', (p->>'evidence_id')::uuid, p->>'method', p->>'submitted_by',
          coalesce((p->>'submitted_at')::timestamptz, now()), prev.id, p->>'note')
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('actual_id', r.id, 'package_id', r.package_id, 'supplier', r.supplier,
                         'selected_response_id', r.selected_response_id,
                         'evidence_id', r.evidence_id, 'supersedes_id', r.supersedes_id));
  return to_jsonb(r);
end;
$$;

create or replace function public.gf_review_supplier_actual(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare a public.supplier_actuals; r public.supplier_actual_reviews; supplied text[];
begin
  select * into a from public.supplier_actuals where id = (p->>'actual_id')::uuid;
  if not found then
    raise exception 'no such supplier-actual record' using errcode = '23503';
  end if;
  supplied := array_remove(array[
      case when a.po_date is not null then 'po_date' end,
      case when a.dispatch_date is not null then 'dispatch_date' end,
      case when a.on_site_date is not null then 'on_site_date' end,
      case when a.install_complete_date is not null then 'install_complete_date' end,
      case when a.energised_date is not null then 'energised_date' end,
      case when a.actual_cost is not null then 'actual_cost' end], null);
  if not (coalesce(array(select jsonb_array_elements_text(coalesce(p->'verified_fields','[]'::jsonb))), '{}')
          <@ supplied) then
    raise exception 'a reviewer can only verify facts the record actually supplies' using errcode = '23514';
  end if;
  insert into public.supplier_actual_reviews (actual_id, project_id, decision, verified_fields,
        reviewer, reason, reviewed_at)
  values (a.id, a.project_id, p->>'decision',
          coalesce(array(select jsonb_array_elements_text(coalesce(p->'verified_fields','[]'::jsonb))), '{}'),
          p->>'reviewer', p->>'reason', coalesce((p->>'reviewed_at')::timestamptz, now()))
  returning * into r;
  perform public.gf_emit(a.project_id, p_event,
      jsonb_build_object('actual_id', a.id, 'decision', r.decision,
                         'verified_fields', to_jsonb(r.verified_fields)));
  return to_jsonb(r);
end;
$$;

-- Derived, never stored: quoted vs actual, per record. A metric is NULL (with the reason in
-- *_basis) unless both sides are known; cost is compared only for the same scope and EUR.
-- Nothing reads this view except the project record and the review queue.
create or replace view public.supplier_reality with (security_invoker = true) as
select a.id as actual_id, a.project_id, a.package_id, a.supplier, a.supersedes_id,
       a.quoted_lead_time_weeks,
       case when a.po_date is not null and a.on_site_date is not null
            then round(((a.on_site_date - a.po_date)::numeric) / 7, 1) end as actual_lead_time_weeks,
       case when a.quoted_lead_time_weeks is null then 'unknown: the quote gave no lead time'
            when a.po_date is null then 'unknown: PO date not supplied'
            when a.on_site_date is null then 'unknown: on-site date not supplied'
            else 'weeks from PO date to on-site date, against quoted weeks from order to delivered on site'
       end as lead_time_basis,
       a.quoted_install_weeks,
       case when a.on_site_date is not null and a.energised_date is not null
            then round(((a.energised_date - a.on_site_date)::numeric) / 7, 1) end as actual_install_weeks,
       case when a.quoted_install_weeks is null then 'unknown: the quote gave no installation time'
            when a.on_site_date is null then 'unknown: on-site date not supplied'
            when a.energised_date is null then 'unknown: first-energised date not supplied'
            else 'weeks from on-site date to first energised, against quoted weeks from delivery to energised'
       end as install_basis,
       a.quoted_capex_eur,
       a.actual_cost, a.actual_cost_currency, a.cost_scope,
       case when a.cost_scope = 'same_as_quote' and a.actual_cost_currency = 'EUR'
                 and a.quoted_capex_eur is not null
            then a.actual_cost - a.quoted_capex_eur end as cost_delta_eur,
       case when a.actual_cost is null then 'unknown: no actual cost supplied'
            when a.quoted_capex_eur is null then 'unknown: the quote gave no price'
            when a.cost_scope <> 'same_as_quote' then 'not compared: actual-cost scope is ' || a.cost_scope
            when a.actual_cost_currency <> 'EUR' then 'not compared: actual cost is in ' || a.actual_cost_currency || ', quote is EUR'
            else 'EUR, same scope as quote'
       end as cost_basis
from public.supplier_actuals a;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.gf_submit_supplier_actual(jsonb, jsonb) from public;
    grant execute on function public.gf_submit_supplier_actual(jsonb, jsonb) to service_role;
    revoke all on function public.gf_review_supplier_actual(jsonb, jsonb) from public;
    grant execute on function public.gf_review_supplier_actual(jsonb, jsonb) to service_role;
    revoke all on public.supplier_reality from public;
    revoke all on public.supplier_actuals, public.supplier_actual_reviews from public;
    grant select on public.supplier_reality to service_role;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on public.supplier_reality, public.supplier_actuals, public.supplier_actual_reviews from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on public.supplier_reality, public.supplier_actuals, public.supplier_actual_reviews from authenticated;
    end if;
    grant select, insert on public.supplier_actuals, public.supplier_actual_reviews to service_role;
  end if;
end
$$;
