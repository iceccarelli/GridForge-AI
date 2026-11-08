-- 0053_salted_site_ref.sql: the site reference in the calibration ledger is keyed (HMAC under a server secret), no longer a bare hash of the label.
--
-- WRITTEN, NOT APPLIED. Applying a migration to a live project is an operator decision, and the order against the website deploy is the operator's
-- choice: both orders work. It needs 0038 and 0047 applied first (it replaces gf_submit_observation as 0047 left it). It creates no table, no column,
-- no index and no view, and it rewrites no row.
--
-- REPLAY ORDER. This migration holds the FINAL gf_submit_observation. It is 0047's body, read from that file, with ONE change: the handling of
-- site_ref (below). Re-running 0038 or 0047 AFTER this one silently puts back a function that ignores the supplied reference and derives the unsalted
-- hash again. Migrations are applied once, in order (scripts/apply-migration.py gate 2). tests/test_calibration_final_gate.py reads the FINAL function
-- from a database built by the whole chain and fails if the site_ref handling is missing, and fails when 0047 (or 0038) is replayed after 0053.
-- calibration_ledger_rows is NOT touched here (0052 still holds its final definition) and does not recompute site_ref: it exports what was stored.
--
-- Why. Until now site_ref was 'site_' || the first 12 hex of an UNSALTED sha256 of the lower-cased, trimmed site label, derived in
-- gf_submit_observation and exported in the ledger by GET /api/admin/calibration-export. Anyone who can guess a label ("Hall A", "Dublin DC1") can hash
-- it and confirm that a ledger row is from that site. The application (lib/project-observations.ts, lib/site-ref.ts) now computes
--
--     site_ref = 'site_' || first 12 hex of HMAC-SHA256(key, lower(trim(label)))      key = GRIDFORGE_SITE_REF_SECRET, else GRIDFORGE_KEY_SECRET
--
-- and passes it in the payload. The database cannot compute it (it never holds the key), so it takes the value.
--
-- The one change, in gf_submit_observation:
--   * p->>'site_ref' absent (or JSON null)                          -> the unsalted derivation, exactly as 0038/0047: the OLD APP keeps working;
--   * present, 'site_' + 12 lowercase hex, and the project has a site label -> stored as given;
--   * present, well formed, but the project has NO site label       -> ignored: no label, no reference, never exported (the invariant of 0038);
--   * present but not site_ + 12 lowercase hex                      -> refused (SQLSTATE 23514, nothing written), never replaced by the unsalted value.
--
-- BOTH ORDERS WORK. Before 0053 is applied the OLD function ignores the unknown key, so the new application's submissions succeed and the reference
-- they store is the UNSALTED one (the application logs this when it sees that the stored value is not the one it sent). Refs are unsalted until 0053 is applied.
-- After 0053, the OLD application (which sends no site_ref) keeps getting the unsalted derivation. Nothing breaks either way.
--
-- MIXED REFERENCES (read this before counting sites). Existing rows KEEP their unsalted references: nothing here rewrites them, and nothing could
-- (the label is not in the ledger and the key is not in the database). A site that has observations from before and after the boundary therefore
-- appears under TWO different references, and any count of distinct sites across the boundary counts it once per scheme: it OVER-counts independent
-- sites. A reference does not say which scheme made it. The operator, who knows the label, declares the two to be one site with
-- `gridforge calibrate alias --site "NAME"`; `gridforge calibrate import` and the ledger reader then treat both as one site (the chained file is never
-- edited). Until that is done for a site the two ARE counted as two, and the importer says so. The same applies, forever, to a ROTATION of the key: it
-- changes every reference from then on, so treat GRIDFORGE_SITE_REF_SECRET as a long-lived key.
--
-- RESIDUAL, stated plainly. The keyed reference defeats confirming a guessed label by hashing; it does not hide that two rows are from the same site
-- (they share a reference, by design: independence is counted across sites), and it is only as strong as the secrecy and length of the key. The caller of
-- gf_submit_observation is the service role (the application); a holder of that role can choose any well-formed reference, as it can already write any row.
-- Additive and idempotent; no row is touched.

create or replace function public.gf_submit_observation(p jsonb, p_event jsonb) returns jsonb
language plpgsql as $$
declare r public.project_observations; pr public.projects; cs public.power_deployment_cases;
        kind text := p->>'measurement_kind'; site text; dig text; rdate date; label text; supplied text := p->>'site_ref';
begin
  if p->>'evidence_id' is null then
    raise exception 'an observation needs an attached evidence artifact' using errcode = '23502';
  end if;
  if (p->>'installed_attested')::boolean is not true then
    raise exception 'the installed architecture must be attested' using errcode = '23514';
  end if;
  if kind is not null and kind not in ('metered', 'bms_trend', 'commissioning_record') then
    raise exception 'measurement_kind must be metered, bms_trend or commissioning_record: a quote, an assumption or a simulation is not a measurement'
      using errcode = '23514';
  end if;
  if not exists (
       select 1 from public.project_evidence
       where id = (p->>'evidence_id')::uuid and project_id = (p->>'project_id')::uuid) then
    raise exception 'that evidence does not belong to this project' using errcode = '23503';
  end if;
  select * into pr from public.projects where id = (p->>'project_id')::uuid;
  label := lower(regexp_replace(coalesce(pr.site_label, ''), '^\s+|\s+$', '', 'g'));
  site := case when label <> '' then 'site_' || substr(encode(sha256(convert_to(label, 'UTF8')), 'hex'), 1, 12) end;
  -- 0053: the application computes the SALTED reference (HMAC under a server secret; lib/site-ref.ts) and sends it as site_ref. Stored as given when it is
  -- well formed AND the project has a site label (no label, no reference: such an observation is never exported). Absent: the unsalted derivation above,
  -- exactly as before. Present but not site_ + 12 lowercase hex: refused, never silently replaced by the unsalted value.
  if supplied is not null then
    if supplied !~ '^site_[0-9a-f]{12}$' then
      raise exception 'site_ref must be site_ followed by 12 lowercase hex characters' using errcode = '23514';
    end if;
    if label <> '' then site := supplied; end if;
  end if;
  select * into cs from public.power_deployment_cases
   where case_token = p->>'case_token' and revision = (p->>'case_revision')::int;
  if found and cs.engine_provenance is not null then
    dig := cs.engine_provenance->>'digest';
    dig := case when dig ~ '^[0-9a-f]{64}$' then dig end;
    rdate := case when cs.engine_provenance->>'report_date' ~ '^\d{4}-\d{2}-\d{2}$'
                  then (cs.engine_provenance->>'report_date')::date end;
  end if;
  insert into public.project_observations (project_id, prediction_ref, case_token, case_revision,
        architecture, calibration_key, unit, predicted_value, predicted_source, observed_value,
        observed_on, method, evidence_id, installed_attested, installed_basis, note,
        submitted_by, submitted_at, measurement_kind, site_ref, engine_provenance_digest, report_date,
        submitted_by_ref, data_origin)
  values ((p->>'project_id')::uuid, p->>'prediction_ref', p->>'case_token',
          (p->>'case_revision')::int, p->>'architecture', p->>'calibration_key', p->>'unit',
          (p->>'predicted_value')::numeric, p->>'predicted_source', (p->>'observed_value')::numeric,
          (p->>'observed_on')::date, p->>'method', (p->>'evidence_id')::uuid,
          (p->>'installed_attested')::boolean, p->>'installed_basis', p->>'note',
          p->>'submitted_by', coalesce((p->>'submitted_at')::timestamptz, now()),
          kind, site, dig, rdate, p->>'submitted_by_ref',
          coalesce(p->>'data_origin', 'unclassified'))
  returning * into r;
  perform public.gf_emit(r.project_id, p_event,
      jsonb_build_object('observation_id', r.id, 'prediction_ref', r.prediction_ref,
                         'calibration_key', r.calibration_key, 'installed_attested', r.installed_attested,
                         'evidence_id', r.evidence_id, 'predicted_value', r.predicted_value,
                         'observed_value', r.observed_value, 'delta_pct', r.delta_pct,
                         'measurement_kind', r.measurement_kind, 'data_origin', r.data_origin));
  return to_jsonb(r);
end;
$$;

comment on function public.gf_submit_observation(jsonb, jsonb) is
  '0053: stores a well-formed p->>site_ref (the keyed reference computed by the application) when the project has a site label; with none supplied it derives '
  'the old unsalted reference. Present but malformed is refused (23514).';

-- ---------------------------------------------------------------------------
-- Privileges, as 0020/0047 left them: service_role only. (CREATE OR REPLACE keeps the grants; this states them again so the file is correct on its own.)
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  revoke all on function public.gf_submit_observation(jsonb, jsonb) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.gf_submit_observation(jsonb, jsonb) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_submit_observation(jsonb, jsonb) to service_role;
  end if;
end
$$;
