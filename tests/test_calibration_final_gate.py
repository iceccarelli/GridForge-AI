"""The FINAL calibration gate, read back from a database built by the whole migration chain.

0046, 0047, 0048 and 0052 each replace calibration_ledger_rows, and 0038, 0047 each define gf_submit_observation. The definition that governs is
whichever ran last, so a reordered migration, a replay of an older one, or a later migration that redefines the view from an old copy would
silently weaken the gate without any behavioural test noticing (those build fixtures that happen to satisfy the missing condition). This
reads what the database ACTUALLY holds at the end of the chain (pg_get_viewdef, pg_get_functiondef, pg_proc, pg_trigger) and fails if any
gate is absent. It also proves the check bites: the same reader, pointed at a database where 0038 was replayed last, reports gaps.
"""
import re

import pytest

from calibration_pg_rig import MIGRATIONS, ROOT, database_fixture, drop_database, make_database, psql, scalar, skip_without_db

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
        r"calibration_permissions cp.*cp\.scope_id = o\.project_id AND cp\.kind = 'granted'::text AND cp\.seq = .*max\(c2\.seq\).*"
        r"calibration_permissions c2.*c2\.scope_id = o\.project_id",
    # 0052: ever having been attached to a site that is anything but production keeps the observation out (a detachment does not undo it)
    "the project was never filed under a non-production site":
        r"NOT \(EXISTS \( SELECT 1 FROM hall_project_attachments hpa JOIN sites st ON st\.id = hpa\.site_id "
        r"WHERE hpa\.project_id = o\.project_id AND st\.data_origin <> 'production'::text\)\)",
}
VIEW_COLUMNS = ["id", "key", "observed_value", "predicted_value", "unit", "site_ref", "measurement_kind", "evidence_sha256",
                "engine_provenance_digest", "report_date", "observed_on", "method", "evidence_class", "reviewed_by", "reviewed_at"]


def top_level_and_terms(viewdef):
    """The top-level AND terms of a view definition's WHERE clause: paren- and quote-aware, so the ANDs inside EXISTS (...) subqueries, the
    JOIN ... ON conditions and string literals are not counted."""
    text = " ".join(viewdef.split())
    depth, quote, where = 0, False, -1
    for i, ch in enumerate(text):
        if ch == "'":
            quote = not quote
        elif quote:
            continue
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and text.startswith(" WHERE ", i):
            where = i + 7
            break
    assert where > 0, "no top-level WHERE in the view definition"
    clause, terms, last, depth, quote = text[where:].rstrip(";"), [], 0, 0, False
    for i, ch in enumerate(clause):
        if ch == "'":
            quote = not quote
        elif quote:
            continue
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0 and clause.startswith(" AND ", i):
            terms.append(clause[last:i].strip())
            last = i + 5
    terms.append(clause[last:].strip())
    return [t for t in terms if t]


def listed_where_terms():
    """How many top-level AND terms lib/calibration-gates.ts accounts for: one per condition in VIEW_CONDITIONS, plus the extra terms a
    condition says it covers (`terms: N`)."""
    src = (ROOT / "lib" / "calibration-gates.ts").read_text()
    block = src[src.index("export const VIEW_CONDITIONS"):src.index("export interface LedgerGate")]
    labels = re.findall(r'^\s*(?:\{\s*)?label: "', block, flags=re.M)
    extra = sum(int(n) - 1 for n in re.findall(r"terms: (\d+)", block))
    return len(labels) + extra


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


def test_the_final_view_applies_no_condition_beyond_the_listed_ones(db):
    """final_gaps proves every listed condition is present; this proves nothing ELSE is: the WHERE clause has exactly as many top-level AND
    terms as lib/calibration-gates.ts accounts for, so a condition added to the view (which would silently narrow what the public page and
    the admin checklist say) fails here until the list, and the page, are updated."""
    view = scalar(db, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
    terms = top_level_and_terms(view)
    assert len(terms) == listed_where_terms(), "\n".join(terms)
    assert len(VIEW_GATES) == len(re.findall(r'label: "', (ROOT / "lib" / "calibration-gates.ts").read_text().split("export interface LedgerGate")[0].split("export const VIEW_CONDITIONS")[1]))


def test_the_term_counter_bites():
    sample = "SELECT 1 FROM t a JOIN u b ON a.x = b.x AND a.y = b.y WHERE a.z = 'p AND q' AND (a.w = 1 AND a.v = 2) AND NOT (EXISTS ( SELECT 1 FROM w WHERE w.a = 1 AND w.b = 2))"
    assert len(top_level_and_terms(sample)) == 3
    assert len(top_level_and_terms(sample + " AND o.observed_value < 9000")) == 4


def test_the_migrations_that_define_the_view_run_in_the_order_the_header_notes_say():
    """0046 < 0047 < 0048 < 0052 define the view; the governing one is the last, and it is 0052. A further definition in the family would be a
    new deliberate decision that must update this test, not an accident."""
    holders = [f.name[:4] for f in sorted(MIGRATIONS.glob("*.sql")) if "create or replace view public.calibration_ledger_rows" in f.read_text()]
    assert holders == ["0038", "0046", "0047", "0048", "0052"], holders
    for f in [*sorted(MIGRATIONS.glob("004[678]_*.sql")), *sorted(MIGRATIONS.glob("0052_*.sql"))]:
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


def test_replaying_0048_after_0052_drops_the_site_origin_gate_and_is_reported():
    """0052 replaced 0048's view with 0048's text plus one condition. Replay order matters: 0048 run AFTER 0052 puts the older definition back, and the
    reader must name exactly that gap (and no other), so the order cannot be broken without a test failing."""
    name = make_database()
    try:
        assert final_gaps(name) == []
        psql(name, file=next(MIGRATIONS.glob("0048_*.sql")))
        assert final_gaps(name) == ["view: the project was never filed under a non-production site"]
        psql(name, file=next(MIGRATIONS.glob("0052_*.sql")))          # and replaying 0052 afterwards restores it
        assert final_gaps(name) == []
    finally:
        drop_database(name)


def test_the_gate_reader_reports_the_site_origin_gate_when_an_older_view_is_replayed_last():
    for older in ("0038", "0046", "0047"):
        name = make_database()
        try:
            psql(name, file=next(MIGRATIONS.glob(f"{older}_*.sql")))
            assert any("non-production site" in g for g in final_gaps(name)), older
        finally:
            drop_database(name)
