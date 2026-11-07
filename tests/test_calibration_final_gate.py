"""The FINAL calibration gate, read back from a database built by the whole migration chain.

0046, 0047 and 0048 each replace calibration_ledger_rows, and 0038, 0047 each define gf_submit_observation. The definition that governs is
whichever ran last, so a reordered migration, a replay of an older one, or a later migration that redefines the view from an old copy would
silently weaken the gate without any behavioural test noticing (those build fixtures that happen to satisfy the missing condition). This
reads what the database ACTUALLY holds at the end of the chain (pg_get_viewdef, pg_get_functiondef, pg_proc, pg_trigger) and fails if any
gate is absent. It also proves the check bites: the same reader, pointed at a database where 0038 was replayed last, reports gaps.
"""
import re

import pytest

from calibration_pg_rig import MIGRATIONS, database_fixture, drop_database, make_database, psql, scalar, skip_without_db

pytestmark = skip_without_db
db = database_fixture()

# Every gate the view must contain, as a regular expression over pg_get_viewdef's normalised text. Each is one line of the policy.
VIEW_GATES = {
    "observation verified by a review": r"r\.decision = 'verified'::text",
    "reviewed as E5 only": r"r\.evidence_class = 'E5'::text",
    "a measurement kind": r"o\.measurement_kind = ANY",
    "the one reconcilable key in MW": r"o\.calibration_key = 'btm\.firm_MW'::text AND o\.unit = 'MW'::text",
    "a site reference": r"o\.site_ref IS NOT NULL",
    "the engine digest of the prediction": r"o\.engine_provenance_digest IS NOT NULL",
    "the review recorded the evidence digest": r"r\.evidence_sha256 IS NOT NULL",
    "file status verified now and unchanged since the review": r"e\.review_status = 'verified'::text AND e\.sha256 = r\.evidence_sha256",
    "a verified decision row whose confirmed digest equals the stored one":
        r"project_evidence_reviews er.*er\.decision = 'verified'::text AND er\.sha256_confirmed = e\.sha256",
    "reviewer is not the submitter": r"lower\(btrim\(r\.reviewer\)\) <> lower\(btrim\(o\.submitted_by\)\)",
    "the forecast has a creation time": r"c\.created_at IS NOT NULL",
    "the forecast predates the outcome": r"c\.created_at < \(o\.observed_on::timestamp without time zone AT TIME ZONE 'UTC'::text\)",
    "the forecast carries a digest": r"c\.case_digest IS NOT NULL",
    "the forecast still matches its digest": r"c\.case_digest = encode\(sha256\(convert_to\(jsonb_build_object\('request', c\.request, 'result', c\.result\)",
    "the prediction is the forecast's own number": r"o\.predicted_value = gf_forecast_predicted_mw\(c\.result, o\.architecture\)",
    "production origin": r"o\.data_origin = 'production'::text",
    "the project's LATEST permission is a grant":
        r"calibration_permissions cp.*cp\.kind = 'granted'::text AND cp\.seq = .*max\(c2\.seq\).*calibration_permissions c2",
}
VIEW_COLUMNS = ["id", "key", "observed_value", "predicted_value", "unit", "site_ref", "measurement_kind", "evidence_sha256",
                "engine_provenance_digest", "report_date", "observed_on", "method", "evidence_class", "reviewed_by", "reviewed_at"]


def final_gaps(name):
    """Everything the FINAL state of database `name` is missing from the gate (empty means complete)."""
    gaps = []
    view = " ".join(scalar(name, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)").split())
    for label, pattern in VIEW_GATES.items():
        if not re.search(pattern, view):
            gaps.append(f"view: {label}")
    cols = scalar(name, "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'calibration_ledger_rows'")
    if cols.split(",") != VIEW_COLUMNS:
        gaps.append("view: the column list or order changed")
    submit = scalar(name, "select pg_get_functiondef('public.gf_submit_observation(jsonb, jsonb)'::regprocedure)")
    if "data_origin" not in submit:
        gaps.append("gf_submit_observation: does not store data_origin")
    review = scalar(name, "select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'gf_review_evidence'")
    if not review.startswith("true|") or "search_path=" not in review:
        gaps.append("gf_review_evidence: not SECURITY DEFINER with a pinned search_path")
    for table, trigger in (("project_observations", "project_observations_forecast_predates"), ("power_deployment_cases", "power_deployment_cases_guard"),
                           ("project_evidence", "project_evidence_guard"), ("project_evidence_reviews", "project_evidence_reviews_guard"),
                           ("calibration_permissions", "calibration_permissions_guard")):
        on = scalar(name, f"select count(*) from pg_trigger where tgrelid = 'public.{table}'::regclass and tgname = '{trigger}' and tgenabled = 'O'")
        if on != "1":
            gaps.append(f"trigger {trigger} on {table} is missing or disabled")
    trig = scalar(name, "select pg_get_functiondef('public.gf_observation_forecast_predates()'::regprocedure)")
    for needle in ("case_digest is null", "future", "gf_forecast_predicted_mw", "created_at >="):
        if needle not in trig:
            gaps.append(f"gf_observation_forecast_predates: lost '{needle}'")
    return gaps


def test_the_final_state_of_the_chain_holds_every_gate(db):
    assert final_gaps(db) == []


def test_the_migrations_that_define_the_view_run_in_the_order_the_header_notes_say():
    """0046 < 0047 < 0048 define the view; the governing one is the last, and it is 0048. A fourth definition in the family would be a new
    deliberate decision that must update this test, not an accident."""
    holders = [f.name[:4] for f in sorted(MIGRATIONS.glob("*.sql")) if "create or replace view public.calibration_ledger_rows" in f.read_text()]
    assert holders == ["0038", "0046", "0047", "0048"], holders
    for f in sorted(MIGRATIONS.glob("004[678]_*.sql")):
        assert "REPLAY ORDER" in f.read_text(), f.name


def test_the_reader_bites_replaying_an_older_migration_last_is_reported_as_gaps():
    """The check is only worth having if it fails when it should: replay 0038 after the chain and it must name what was lost."""
    name = make_database()
    try:
        assert final_gaps(name) == []
        psql(name, file=next(MIGRATIONS.glob("0038_*.sql")))
        gaps = final_gaps(name)
        assert any("production origin" in g for g in gaps) and any("LATEST permission" in g for g in gaps), gaps
        assert any("gf_submit_observation" in g for g in gaps), gaps
    finally:
        drop_database(name)


@pytest.mark.parametrize("older", ["0046", "0047"])
def test_replaying_0046_or_0047_last_is_reported_as_gaps(older):
    name = make_database()
    try:
        psql(name, file=next(MIGRATIONS.glob(f"{older}_*.sql")))
        gaps = final_gaps(name)
        assert any("a verified decision row" in g for g in gaps), gaps          # 0048's condition is gone from the view
    finally:
        drop_database(name)
