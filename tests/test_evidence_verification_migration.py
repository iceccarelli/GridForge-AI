"""0048_evidence_verification.sql against a REAL PostgreSQL.

Before 0048 nothing in the system ever set project_evidence.review_status to 'verified' (the server writes 'unverified'; only raw SQL in
tests did), so no observation could ever clear the ledger gate and the review screen could only Reject; and nothing stopped a service-role
caller editing a file's digest, name, storage path or project, or flipping its status, behind the reviewers' back. This attacks those
doors: a status change that does not go through the review function, a confirmation of the wrong digest, a second decision, an edit of the
identity of a file a reviewer vouched for. Every value is a SYNTHETIC fixture.

See tests/calibration_pg_rig.py for how the database is built and for GRIDFORGE_MIGRATIONS_UPTO (set to 0047 to watch these fail on the base).
"""
import json
import uuid

import pytest

from calibration_pg_rig import (
    GOOD, HEX, as_service_role, count, database_fixture, new_evidence, new_project, psql, review, review_evidence, scalar, skip_without_db,
    submitted,
)

pytestmark = skip_without_db
db = database_fixture()


def unverified_file(db, sha="a"):
    project = new_project(db)
    return project, new_evidence(db, project, verified=False, sha=sha)


def status(db, eid):
    return scalar(db, f"select review_status from project_evidence where id = '{eid}'")


def call(db, p, event="evidence_reviewed", runner=psql):
    return runner(db, f"select gf_review_evidence('{json.dumps(p)}'::jsonb, '{GOOD % event}'::jsonb)", check=False)


def good(eid, **over):
    p = {"evidence_id": eid, "decision": "verified", "reviewer": "F. Keane", "reason": "opened the file, digest matches",
         "sha256_confirmed": HEX("a")}
    p.update(over)
    return {k: v for k, v in p.items() if v is not None}


# ---------------------------------------------------------------------------------------------- A. the review function

def test_a_matching_digest_verifies_the_file_and_records_who_why_and_which_digest(db):
    project, eid = unverified_file(db)
    r = call(db, good(eid), runner=as_service_role)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["decision"] == "verified" and out["reviewer"] == "F. Keane" and out["sha256_confirmed"] == HEX("a") and out["reviewed_at"]
    assert status(db, eid) == "verified"
    assert count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 1
    assert scalar(db, f"select count(*) from project_events where project_id = '{project}' and event_type = 'evidence_reviewed'") == "1"


def test_a_confirmation_of_a_different_digest_is_refused_and_changes_nothing(db):
    project, eid = unverified_file(db)
    r = call(db, good(eid, sha256_confirmed=HEX("b")))
    assert r.returncode != 0 and "does not match" in r.stderr, r.stderr
    assert status(db, eid) == "unverified" and count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 0
    assert scalar(db, f"select count(*) from project_events where project_id = '{project}' and event_type = 'evidence_reviewed'") == "0"
    # and the file can still be reviewed correctly afterwards: the failed attempt consumed nothing
    assert call(db, good(eid)).returncode == 0 and status(db, eid) == "verified"


def test_the_refusal_of_a_digest_mismatch_carries_the_stable_code(db):
    _, eid = unverified_file(db)
    r = psql(db, f"select gf_review_evidence('{json.dumps(good(eid, sha256_confirmed=HEX('b')))}'::jsonb, '{GOOD % 'evidence_reviewed'}'::jsonb)",
             check=False, sqlstate=True)
    assert "GF007" in r.stderr, r.stderr


@pytest.mark.parametrize("sha", [None, "", "xyz", "A" * 64, "a" * 63, "a" * 65])
def test_a_verification_needs_a_well_formed_digest(db, sha):
    _, eid = unverified_file(db)
    r = call(db, good(eid, sha256_confirmed=sha))
    assert r.returncode != 0, sha
    assert status(db, eid) == "unverified"


def test_a_rejection_needs_no_digest_and_marks_the_file_rejected(db):
    _, eid = unverified_file(db)
    r = call(db, good(eid, decision="rejected", sha256_confirmed=None, reason="not a meter export"))
    assert r.returncode == 0, r.stderr
    assert status(db, eid) == "rejected"
    assert scalar(db, f"select coalesce(sha256_confirmed, 'none') from project_evidence_reviews where evidence_id = '{eid}'") == "none"


@pytest.mark.parametrize("first,second", [("verified", "verified"), ("verified", "rejected"), ("rejected", "verified"), ("rejected", "rejected")])
def test_one_decision_per_file_and_it_is_final(db, first, second):
    _, eid = unverified_file(db)
    assert call(db, good(eid, decision=first, sha256_confirmed=HEX("a") if first == "verified" else None)).returncode == 0
    r = call(db, good(eid, decision=second, sha256_confirmed=HEX("a") if second == "verified" else None, reviewer="Someone Else"))
    assert r.returncode != 0 and "already been reviewed" in r.stderr, r.stderr
    assert status(db, eid) == first and count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 1
    assert scalar(db, f"select reviewer from project_evidence_reviews where evidence_id = '{eid}'") == "F. Keane"


@pytest.mark.parametrize("over", [{"reviewer": ""}, {"reviewer": "   "}, {"reviewer": None}, {"reason": ""}, {"reason": "  "}, {"reason": None},
                                  {"reviewer": "x" * 121}, {"reason": "x" * 501}, {"decision": "maybe"}, {"decision": None}])
def test_a_named_reviewer_and_a_reason_are_mandatory(db, over):
    _, eid = unverified_file(db)
    assert call(db, good(eid, **over)).returncode != 0, over
    assert status(db, eid) == "unverified" and count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 0


def test_a_file_that_does_not_exist_is_refused(db):
    r = call(db, good(str(uuid.uuid4())))
    assert r.returncode != 0 and "no such evidence" in r.stderr


def test_only_the_service_role_can_call_it(db):
    _, eid = unverified_file(db)
    for role in ("anon", "authenticated"):
        r = psql(db, f"set role {role}; select gf_review_evidence('{json.dumps(good(eid))}'::jsonb, '{GOOD % 'evidence_reviewed'}'::jsonb)", check=False)
        assert r.returncode != 0 and "permission denied" in r.stderr, role
        assert psql(db, f"set role {role}; select count(*) from project_evidence_reviews", check=False).returncode != 0, role
    assert scalar(db, "select relrowsecurity from pg_class where oid = 'public.project_evidence_reviews'::regclass") == "t"
    assert scalar(db, "select count(*) from pg_policies where tablename = 'project_evidence_reviews'") == "0"


# ---------------------------------------------------------------------------------------------- B. the status moves only through it

@pytest.mark.parametrize("to", ["verified", "rejected"])
@pytest.mark.parametrize("runner", ["postgres", "service_role"])
def test_a_raw_update_cannot_change_the_review_status(db, to, runner):
    _, eid = unverified_file(db)
    sql = f"update project_evidence set review_status = '{to}' where id = '{eid}'"
    r = as_service_role(db, sql) if runner == "service_role" else psql(db, sql, check=False)
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr, r.stderr
    assert status(db, eid) == "unverified"


def test_a_status_set_after_a_forged_flag_is_still_refused_without_a_review_row(db):
    """Even a caller that knows the transaction-local flag the function sets cannot use it: the guard also needs a stored decision."""
    _, eid = unverified_file(db)
    r = psql(db, f"begin; select set_config('gridforge.evidence_review', '{eid}', true); update project_evidence set review_status = 'verified' where id = '{eid}'; commit",
             check=False)
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr
    assert status(db, eid) == "unverified"


def test_a_decision_row_written_directly_with_the_wrong_digest_is_refused_by_the_table_itself(db):
    project, eid = unverified_file(db)
    r = psql(db, "insert into project_evidence_reviews (evidence_id, project_id, decision, reviewer, reason, sha256_confirmed)"
                 f" values ('{eid}', '{project}', 'verified', 'x', 'y', '{HEX('b')}')", check=False)
    assert r.returncode != 0 and "does not match" in r.stderr
    assert status(db, eid) == "unverified"


def test_a_decision_row_written_directly_does_not_by_itself_verify_the_file(db):
    project, eid = unverified_file(db)
    psql(db, "insert into project_evidence_reviews (evidence_id, project_id, decision, reviewer, reason, sha256_confirmed)"
             f" values ('{eid}', '{project}', 'verified', 'x', 'y', '{HEX('a')}')")
    assert status(db, eid) == "unverified"          # the ledger view reads the file's status, which only the function moves
    # ...and the function refuses that file now (a decision is on record), rather than quietly verifying it
    assert call(db, good(eid)).returncode != 0


def test_a_stored_decision_is_not_enough_either_the_update_must_come_from_the_function(db):
    """The other half of the guard: a decision row exists (written directly, with the right digest), yet a raw status update is still refused
    because it did not come through gf_review_evidence."""
    project, eid = unverified_file(db)
    psql(db, "insert into project_evidence_reviews (evidence_id, project_id, decision, reviewer, reason, sha256_confirmed)"
             f" values ('{eid}', '{project}', 'verified', 'x', 'y', '{HEX('a')}')")
    for runner in (psql, as_service_role):
        r = runner(db, f"update project_evidence set review_status = 'verified' where id = '{eid}'", check=False)
        assert r.returncode != 0 and "gf_review_evidence" in r.stderr, runner.__name__
    assert status(db, eid) == "unverified"


def test_the_status_cannot_move_a_second_time_even_through_the_function_flag(db):
    """A decided file stays decided: the function's own flag does not let a verified file become rejected."""
    _, eid = unverified_file(db)
    assert call(db, good(eid)).returncode == 0
    r = psql(db, f"begin; select set_config('gridforge.evidence_review', '{eid}', true); update project_evidence set review_status = 'rejected' where id = '{eid}'; commit",
             check=False)
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr
    assert status(db, eid) == "verified"


INSERT_REVIEW = ("insert into project_evidence_reviews (evidence_id, project_id, decision, reviewer, reason, sha256_confirmed)"
                 " values ('{eid}', '{project}', 'verified', 'x', 'y', '{sha}')")


def test_a_service_role_caller_cannot_write_a_decision_row_even_with_the_right_digest(db):
    """gf_review_evidence is the sole writer: a forged or pre-seeded decision row is refused for the API role, whatever privileges it holds."""
    project, eid = unverified_file(db)
    r = as_service_role(db, INSERT_REVIEW.format(eid=eid, project=project, sha=HEX("a")))
    assert r.returncode != 0 and "written only by gf_review_evidence" in r.stderr, r.stderr
    assert count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 0


def test_a_decision_row_seeded_by_the_owner_still_cannot_be_turned_into_a_status_by_the_api_role(db):
    project, eid = unverified_file(db)
    psql(db, INSERT_REVIEW.format(eid=eid, project=project, sha=HEX("a")))                  # the owner connection: the stated bypass
    r = as_service_role(db, f"select set_config('gridforge.evidence_review', '{eid}', true); update project_evidence set review_status = 'verified' where id = '{eid}'")
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr, r.stderr
    assert status(db, eid) == "unverified"


def test_the_decision_function_is_security_definer_with_a_pinned_search_path_and_only_the_service_role_may_run_it(db):
    row = scalar(db, "select prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where proname = 'gf_review_evidence'")
    assert row.startswith("true|") and "search_path=public, pg_temp" in row, row
    assert scalar(db, "select has_function_privilege('service_role', 'public.gf_review_evidence(jsonb, jsonb)', 'execute')") == "t"
    for role in ("anon", "authenticated"):
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_review_evidence(jsonb, jsonb)', 'execute')") == "f", role


def test_direct_insert_on_the_decision_table_is_revoked_from_every_api_role_by_the_migration_itself():
    """Checked on a database built by the chain ALONE, with Supabase's default ACLs in place beforehand (so the revoke has a grant to take away)
    and without the rig's blanket grant afterwards (what scripts/realdb-up.sh does)."""
    from calibration_pg_rig import drop_database, make_database
    name = make_database(regrant=False, supabase_default_acls=True)
    try:
        for role in ("service_role", "anon", "authenticated"):
            for priv in ("insert", "update", "delete", "truncate"):
                assert scalar(name, f"select has_table_privilege('{role}', 'public.project_evidence_reviews', '{priv}')") == "f", (role, priv)
        assert scalar(name, "select has_table_privilege('service_role', 'public.project_evidence_reviews', 'select')") == "t"
        project, eid = unverified_file(name)
        r = as_service_role(name, INSERT_REVIEW.format(eid=eid, project=project, sha=HEX("a")))
        assert r.returncode != 0 and "permission denied" in r.stderr
        assert call(name, good(eid), runner=as_service_role).returncode == 0                  # ...while the function works for the same role
        assert status(name, eid) == "verified"
    finally:
        drop_database(name)


def test_the_evidence_table_has_a_truncate_guard_and_cannot_be_truncated(db):
    unverified_file(db)
    assert scalar(db, "select count(*) from pg_trigger where tgrelid = 'public.project_evidence'::regclass and tgname = 'project_evidence_no_truncate'"
                      " and tgenabled = 'O' and (tgtype & 32) = 32") == "1"                       # a statement-level BEFORE TRUNCATE trigger
    for sql in ("truncate public.project_evidence", "truncate public.project_evidence cascade"):
        assert psql(db, sql, check=False).returncode != 0, sql
    r = psql(db, "truncate public.project_evidence cascade", check=False)
    assert "append-only" in r.stderr
    assert count(db, "project_evidence") >= 1


@pytest.mark.parametrize("assignment", ["sha256 = repeat('e', 64)", "filename = 'other.csv'", "storage_ref = 'b/elsewhere'",
                                        "project_id = (select id from projects where id <> project_evidence.project_id limit 1)",
                                        "media_type = 'application/pdf'", "byte_size = 11", "uploaded_at = now() - interval '1 day'",
                                        "evidence_class = 'E5'", "id = gen_random_uuid()"])
def test_the_identity_of_a_file_cannot_be_edited(db, assignment):
    new_project(db)
    _, eid = unverified_file(db)
    for runner in (psql, as_service_role):
        r = runner(db, f"update project_evidence set {assignment} where id = '{eid}'", check=False)
        assert r.returncode != 0 and "immutable" in r.stderr, (runner.__name__, assignment, r.stderr)


def test_the_identity_of_a_verified_file_cannot_be_edited_either(db):
    _, eid = unverified_file(db)
    call(db, good(eid))
    r = psql(db, f"update project_evidence set sha256 = repeat('e', 64) where id = '{eid}'", check=False)
    assert r.returncode != 0 and "immutable" in r.stderr
    assert scalar(db, f"select sha256 from project_evidence where id = '{eid}'") == HEX("a")


def test_the_note_and_the_source_category_may_still_be_corrected(db):
    _, eid = unverified_file(db)
    psql(db, f"update project_evidence set note = 'typo fixed', source_category = 'load_data' where id = '{eid}'")
    assert scalar(db, f"select note || '/' || source_category from project_evidence where id = '{eid}'") == "typo fixed/load_data"


def test_a_file_cannot_arrive_already_verified(db):
    project = new_project(db)
    r = psql(db, f"select gf_add_evidence(jsonb_build_object('project_id', '{project}', 'filename', 'f.csv', 'media_type', 'text/csv',"
                 f" 'sha256', repeat('a', 64), 'byte_size', 10, 'storage_ref', 'b/x', 'review_status', 'verified'), '{GOOD % 'evidence_attached'}'::jsonb)", check=False)
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr
    r = psql(db, "insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref, review_status)"
                 f" values ('{project}', 'f.csv', 'text/csv', repeat('b', 64), 10, 'b/y', 'rejected')", check=False)
    assert r.returncode != 0 and "gf_review_evidence" in r.stderr
    assert count(db, "project_evidence", f"project_id = '{project}'") == 0


def test_a_reviewed_file_cannot_be_deleted_and_the_decisions_cannot_be_edited(db):
    _, eid = unverified_file(db)
    call(db, good(eid))
    for sql in (f"delete from project_evidence where id = '{eid}'", "update project_evidence_reviews set decision = 'rejected'",
                "delete from project_evidence_reviews", "update project_evidence_reviews set sha256_confirmed = repeat('b', 64)"):
        for runner in (psql, as_service_role):
            assert runner(db, sql, check=False).returncode != 0, (runner.__name__, sql)
    for sql in ("truncate public.project_evidence_reviews", "truncate public.project_evidence_reviews cascade"):
        r = psql(db, sql, check=False)
        assert r.returncode != 0 and "append-only" in r.stderr, sql
    assert status(db, eid) == "verified" and count(db, "project_evidence_reviews", f"evidence_id = '{eid}'") == 1


def test_an_unreviewed_file_can_still_be_removed(db):
    """Nothing here blocks the existing clean-up of a file nobody has decided on."""
    _, eid = unverified_file(db)
    assert psql(db, f"delete from project_evidence where id = '{eid}'", check=False).returncode == 0


# ---------------------------------------------------------------------------------------------- C. what it unlocks

def test_an_observation_can_be_verified_once_its_file_has_been(db):
    project, ev, o = submitted(db, evidence_verified=False)
    refused = review(db, o["id"])
    assert refused.returncode != 0 and "evidence artifact is not verified" in refused.stderr
    assert review_evidence(db, ev).returncode == 0
    assert review(db, o["id"]).returncode == 0


def test_a_rejected_file_never_verifies_an_observation(db):
    project, ev, o = submitted(db, evidence_verified=False)
    assert review_evidence(db, ev, decision="rejected").returncode == 0
    assert "not verified" in review(db, o["id"]).stderr


def test_the_migration_says_it_is_not_applied_and_has_no_destructive_statement():
    import glob
    import importlib.util
    from calibration_pg_rig import ROOT
    sql = open(glob.glob(str(ROOT / "supabase" / "migrations" / "0048_*.sql"))[0]).read()
    assert "WRITTEN, NOT APPLIED" in sql
    spec = importlib.util.spec_from_file_location("am", ROOT / "scripts" / "apply-migration.py")
    am = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(am)
    assert am.destructive_statements(sql) == []


def test_the_migration_is_idempotent(db):
    from calibration_pg_rig import MIGRATIONS
    f = next(MIGRATIONS.glob("0048_*.sql"))
    psql(db, file=f)
    psql(db, file=f)
    _, eid = unverified_file(db)
    assert call(db, good(eid)).returncode == 0
