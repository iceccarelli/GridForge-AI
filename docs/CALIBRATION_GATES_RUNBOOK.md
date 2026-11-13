# Calibration publication gates (migration 0056): operator runbook

Status: **written, not applied** to any database. The ledger holds 0 real observations. Nothing here is an instruction to apply it; whether and when is the owner's decision.

## What 0056 does

`supabase/migrations/0056_calibration_publication_gates.sql` adds four gates an observation clears *before it is recorded* (a trigger on `project_observations`, so it binds every way a row arrives) and *again before it is published* (the final `calibration_ledger_rows` view, which now holds three more conditions than 0052's):

- **D1 completion milestone.** `project_completion_milestones`: an append-only record that a project reached `energised` on a date, backed by a *verified* file of that project, attested by an owner or editor of its organisation. A production observation is refused without one, when dated before it, or when a supplier record of the project shows delivery still in flight. Error `GF016`.
- **D3 consent.** `calibration_consents`: an append-only log per *organisation* of a grant or withdrawal that names the scope (`aggregate_residual_statistics`), the aggregation floors (at least 10 observations, 3 organisations) and the version and SHA-256 of the consent text. Only an active owner can write it. A production observation needs its project attached to a hall of an organisation whose latest consent is a grant; the organisation is derived from that attachment, never supplied. Errors `GF015`, `GF016`.
- **D5 withdrawal.** A withdrawal writes a tombstone (the SHA-256 of each observation id, nothing else) for every observation recorded under the organisation, marks released snapshots that contained them as superseded, and the view excludes them for ever. Error `GF017` for a tombstoned observation.
- **R4 release registry.** `calibration_release_snapshots` refuses a release that is not a safe group (10 observations, 3 organisations, none above 40%), comes within 30 days of the previous one, or differs from any earlier one by less than a safe group. Error `GF018`. The numbers are `gf_calibration_release_policy()` and `gridforge/calibration/release.py`; a test compares them.

## What applying it does to the site, plainly

From the moment it is applied, **every production calibration submission fails closed** (HTTP 409 from `POST /api/projects/[token]/observations`) until, for that project: it is attached to a hall of an organisation, **that organisation's owner has recorded a consent**, and **the project's completion milestone has been attested**. **The site has no page for either.** Nothing in `app/` or `lib/` calls `gf_record_calibration_consent`, `gf_withdraw_calibration_consent` or `gf_attest_completion_milestone`; they are `service_role`-only functions, so today an operator must call them (PostgREST `rpc`, or SQL as the service role). The customer sees a sentence naming what is missing (`lib/calibration-gate-errors.ts`) that says there is no page yet and points to /contact. Preview and test deployments are unaffected (their rows are not `production`).

## Order of operations

1. **Decide.** Applying changes behaviour customers can see (above) and cannot be undone except by a new migration. The application cannot yet meet the gates by itself.
2. **Prerequisites.** `scripts/apply-migration.py` gate 2 refuses 0056 unless 0055 (the previous file) is in the remote history and nothing higher is. `lib/capability-registry.ts` records 0046-0048 and 0049-0052 as applied on 2026-11-07 (`docs/EXECUTION_STATE.md` itself stops at 0045); the headers of 0053, 0054 and 0055 say written, not applied, so each is its own operator decision first. Read the live history before relying on either record.
3. **Backup gate.** `python3 scripts/export-prod-data.py`, then `python3 scripts/verify-backup-restore.py` (it rehearses pending migrations on the restored rows; it must say RESTORE VERIFIED), then `python3 scripts/apply-migration.py 0056` as a dry run: gate 3 wants an export under `~/gf-backups` newer than 2 hours whose per-table counts equal the live ones.
4. **Apply** with `--yes`. The migration's header asks for `set lock_timeout = '5s'` (it takes a short lock on `project_observations` and rebuilds the `project_events` event-type check); the applier does not set it, so run it where you can, and re-run if it times out (the file is idempotent).
5. **Verify** (read-only; `tests/test_calibration_final_gate.py` and `tests/test_calibration_publication_gates.py` assert the same on a scratch database):
   - Q1 `select to_regclass('public.calibration_consents'), to_regclass('public.project_completion_milestones'), to_regclass('public.calibration_tombstones'), to_regclass('public.calibration_release_snapshots'), to_regclass('public.calibration_snapshot_supersessions');` all non-null.
   - Q2 `select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true);` names `calibration_consents`, `project_completion_milestones` and `calibration_tombstones`.
   - Q3 `select tgname, tgenabled from pg_trigger where tgname in ('project_observations_publication_gates','calibration_consents_guard','calibration_consents_withdrawn','project_completion_milestones_guard','calibration_release_snapshots_guard');` five rows, all `O`.
   - Q4 `select (select count(*) from project_observations), (select count(*) from project_observations where organisation_id is not null), (select count(*) from calibration_ledger_rows);` the first equals the pre-apply count, the others are 0.
   - Q5 `select public.gf_calibration_release_policy();` is `min_cell_observations 10, min_cell_organisations 3, max_organisation_share_permille 400, release_step_observations 10, release_step_organisations 3, min_release_interval_days 30`.
   - Q6 no row for `anon` or `authenticated` in `information_schema.role_table_grants` for the five new tables.
6. **Make a project submittable (per organisation, by hand until there is a page).** The owner's e-mail must be an active owner in `organisation_members`. Consent: `gf_record_calibration_consent(p)` with `organisation_id, publish_scope, min_aggregate_observations (>=10), min_aggregate_organisations (>=3), consent_text_version, consent_text_sha256, document_sha256, recorded_by`. Milestone: `gf_attest_completion_milestone(p, p_event)` with `project_id, milestone 'energised', reached_on, evidence_id (verified file of that project), basis, attested_by (owner or editor)`, and a `completion_milestone_attested` history event.
7. **Admin export.** `GET /api/admin/calibration-export` now also returns `tombstones` (hashes). `gridforge calibrate import` refuses an export containing one.

## Open items

- **R4 is not wired.** `propose_release` is not called by the API's `public_report` (`gridforge/api/server.py` still recomputes it on every request), and nothing registers a snapshot. **No aggregate may be published, and no real observation put in the ledger, until it is** (`publication.py`, HARD PRECONDITION).
- **Pre-0056 rows are not back-filled.** They have no organisation or consent, so they are not in the view, and none is invented for them.
- **No page** to record or withdraw consent, or to attest the milestone. The admin checklist (`/admin/reviews`) reads the six gates and the record's shape, not these three conditions: the view alone applies them.
- **The importer does not write an export's `tombstones` to the side file** (`calibration.local.tombstones.json`; `add_tombstones` has no caller). It refuses a re-import, but rows imported before a withdrawal keep counting until an operator adds their hashes to that file.
- **Unchecked by the database:** the consent text and signed document (digests the owner typed), who is an owner (the registry's say-so), the milestone date (the attester's declaration).
- **Replay order.** Re-running 0038, 0046-0048 or 0052 after 0056 puts an older, weaker view back; `tests/test_calibration_final_gate.py` reports it and 0056 restores it. The calibration export reads the view in one request, which a hosted PostgREST caps (1000 rows by default): not a problem at 0 rows, a truncation to fix before there are more.
