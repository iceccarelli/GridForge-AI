-- 0052_calibration_site_origin_gate.sql: an observation of a project that sits in a test or synthetic site never reaches the shared
-- calibration ledger.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision. It needs 0046-0051 applied first (it reads
-- hall_project_attachments, hall_project_detachments and sites, created by 0049 and 0050, and it replaces the view that 0048 defines).
-- Until it is applied nothing changes: calibration_ledger_rows keeps its 0048 definition.
--
-- REPLAY ORDER. This migration holds the FINAL calibration_ledger_rows. It is 0048's definition, read from that file, plus ONE more
-- condition (below). Re-running 0038, 0046, 0047 or 0048 AFTER this one silently replaces the view with an older and weaker definition
-- (0048 replaces it with a view that has no site-origin gate; 0038/0046/0047 lose more than that). Migrations are applied once, in order
-- (scripts/apply-migration.py gate 2). tests/test_calibration_final_gate.py reads the FINAL view from a database built by the whole chain and
-- fails if any gate is missing, this one included, and fails when 0048 (or any older view definition) is replayed after 0052.
--
-- Why. Since 0049 an organisation can declare a site 'production', 'test' or 'synthetic' (sites.data_origin, fixed once written), and since
-- 0050 a project can be attached to a hall of a site (hall_project_attachments, closed by hall_project_detachments). The calibration gate of
-- 0047 reads only the OBSERVATION's own data_origin, which the server sets from the deployment. A rehearsal run on a production deployment, in
-- a project the organisation has itself filed under a test or synthetic site, would therefore still carry data_origin = 'production' and, with
-- a verified file and a reviewer, reach the ledger that `gridforge calibrate import` publishes. The organisation has said, in the registry,
-- that this place is not a real asset; the ledger must not contradict it.
--
-- The one added condition. An observation is NOT eligible when its project has an OPEN attachment (no row in hall_project_detachments for that
-- attachment) to a site whose data_origin is anything but 'production'. So:
--   * attached to a production site                 -> unchanged (eligible if every other gate holds);
--   * attached to a test or a synthetic site        -> not eligible;
--   * attached to such a site and then detached     -> eligible again (the gate follows the CURRENT state of the registry);
--   * never attached to any hall                    -> unchanged: every project that exists today, and every project of 0001-0045.
-- The view is evaluated whenever the ledger is read, so it also covers an observation that was stored BEFORE its project was attached.
--
-- WHERE IT IS ENFORCED, and where it is not. In the VIEW ONLY, deliberately. The importer trusts the view (0047), so the view is the single
-- gate. It is not also enforced when an observation is inserted (gf_submit_observation or a trigger) because (a) the attachment can happen after
-- the observation is stored, so an insert-time check would not close the case, and the view has to carry it anyway; (b) refusing the insert would
-- turn "this row will not be exported" into a failed submission for a person who did nothing wrong, and would change what
-- lib/project-observations.ts must handle; (c) it would put a third copy of gf_submit_observation in the chain. Nothing is lost by this: the
-- observation is still stored, still reviewable, and simply not exported.
--
-- RESIDUAL, stated plainly. The gate follows the registry's CURRENT state. An owner of the organisation can detach a project from a test site
-- (recorded, with a project event, and the attachment stays) and the project's observations then qualify again if every other gate holds
-- (reviewer who is not the submitter, a verified file, a frozen forecast, a production data origin, a standing permission). The site's
-- origin is the organisation's declaration, never verified (0049). Neither is a defence against a determined insider; both are a guard against
-- a rehearsal being mistaken for a measurement.
--
-- Every column, the column order and the privileges of the view are exactly 0048's. Additive and idempotent; no row is touched.

-- ---------------------------------------------------------------------------
-- The FINAL ledger view: 0048's definition plus the site-origin condition
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
  -- 0052: the project is not sitting, now, in a site its organisation declared anything but production.
  and not exists (
    select 1 from public.hall_project_attachments hpa
    join public.sites st on st.id = hpa.site_id
    where hpa.project_id = o.project_id
      and st.data_origin <> 'production'
      and not exists (select 1 from public.hall_project_detachments hpd where hpd.attachment_id = hpa.id));

-- ---------------------------------------------------------------------------
-- Privileges, as 0048 left them: readable by service_role alone. (CREATE OR REPLACE keeps the grants; this states them again so the file
-- is correct on its own.)
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  revoke all on public.calibration_ledger_rows from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.calibration_ledger_rows from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.calibration_ledger_rows to service_role;
  end if;
end
$$;
