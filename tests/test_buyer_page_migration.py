"""0024_rate_limit.sql and 0025_project_comparisons_and_shares.sql against a real PostgreSQL.

The site's tests mirror these functions in memory; that mirror cannot run a trigger, a partial unique index or two
connections at once, so it cannot show that a saved comparison is evidence nobody can edit, that a project has one active
buyer link whatever races to issue one, or that the rate limit counts every concurrent hit exactly once. This applies the
real chain of migrations to a throwaway database and attacks it the way a careless or hostile service-role caller would.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none:
a skip is a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import hashlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def parallel(db, statements):
    """Run each statement on its OWN connection at the same moment; return (returncode, stdout, stderr) for each."""
    procs = [subprocess.Popen(_cmd(db) + ["-c", s], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for s in statements]
    out = []
    for p in procs:
        so, se = p.communicate()
        out.append((p.returncode, so.strip(), se))
    return out


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
    if not REQUIRED:
        return
    assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role in ("anon", "authenticated", "service_role"):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin; end if; end $$")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def project(db, token=None):
    token = token or uuid.uuid4().hex
    return psql(db, f"insert into projects (project_token, project_name) values ('{token}', 'Hall') returning id").stdout.strip().splitlines()[0]


def comparison_args(pid=None, digest="d" * 64, prov="p" * 64, grade="indicative"):
    p = {"request": {"intake": {}}, "result": {"schema": "gridforge/ttp-compare/1"}, "schema": "gridforge/ttp-compare/1",
         "request_digest": digest, "provenance_digest": prov, "engine_version": "0.9.0", "grade": grade}
    if pid:
        p["project_id"] = pid
    return p


def save_sql(p, event_type="comparison_saved", new_project=None):
    ev = json.dumps({"event_type": event_type, "actor": "project_token_holder", "payload": {"request_digest": p["request_digest"]}})
    extra = ""
    if new_project:
        extra = f", p_new_project => '{json.dumps(new_project)}'::jsonb, p_new_event => '{json.dumps({'event_type': 'project_created', 'actor': 'x', 'payload': {}})}'::jsonb"
    return f"select public.gf_save_comparison('{json.dumps(p)}'::jsonb, '{ev}'::jsonb{extra})"


# --------------------------------------------------------------------------- 0024: the rate limit

def hit(db, bucket="b", subject=None, limit=3, window=60):
    subject = subject or hashlib.sha256(b"someone").hexdigest()
    return json.loads(psql(db, f"select public.gf_rate_limit_hit('{bucket}', '{subject}', {limit}, {window})").stdout.strip())


def test_the_counter_allows_up_to_the_limit_then_refuses_with_a_retry_time(db):
    s = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    answers = [hit(db, subject=s, limit=3, window=3600) for _ in range(5)]
    assert [a["allowed"] for a in answers] == [True, True, True, False, False]
    assert [a["hits"] for a in answers] == [1, 2, 3, 4, 5]
    assert 1 <= answers[-1]["retry_after_seconds"] <= 3600


def test_concurrent_hits_are_each_counted_exactly_once(db):
    s = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    results = parallel(db, [f"select (public.gf_rate_limit_hit('race', '{s}', 10, 3600)->>'allowed')::boolean"] * 25)
    assert all(rc == 0 for rc, _, _ in results), [e for _, _, e in results if e]
    assert sorted(o for _, o, _ in results).count("t") == 10     # exactly the limit were allowed, not 11 and not 9
    assert psql(db, f"select hits from rate_limit_windows where bucket = 'race' and subject = '{s}'").stdout.strip() == "25"


def test_buckets_subjects_and_windows_are_independent(db):
    a, b = (hashlib.sha256(uuid.uuid4().bytes).hexdigest() for _ in range(2))
    for _ in range(3):
        hit(db, bucket="x", subject=a, limit=2, window=3600)
    assert hit(db, bucket="x", subject=a, limit=2, window=3600)["allowed"] is False
    assert hit(db, bucket="x", subject=b, limit=2, window=3600)["allowed"] is True
    assert hit(db, bucket="y", subject=a, limit=2, window=3600)["allowed"] is True
    assert hit(db, bucket="x", subject=a, limit=2, window=3601)["allowed"] is True   # a different window length is a different window


def test_a_new_window_starts_again(db):
    s = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    for _ in range(3):
        hit(db, bucket="roll", subject=s, limit=2, window=3600)
    psql(db, f"update rate_limit_windows set window_start = window_start - interval '1 hour' where bucket = 'roll' and subject = '{s}'")
    assert hit(db, bucket="roll", subject=s, limit=2, window=3600) == {"allowed": True, "hits": 1, "limit": 2, "retry_after_seconds": pytest.approx(3600, abs=3600)}


def test_arguments_are_bounded_and_the_subject_must_be_an_hmac_not_an_address(db):
    s = hashlib.sha256(b"x").hexdigest()
    for limit, window in ((0, 60), (100001, 60), (3, 0), (3, 86401), ("null", 60)):
        refused(db, f"select public.gf_rate_limit_hit('b', '{s}', {limit}, {window})", "must be between")
    refused(db, "select public.gf_rate_limit_hit('b', '203.0.113.7', 3, 60)", "rate_limit_windows_subject_check")
    refused(db, f"select public.gf_rate_limit_hit('Bad Bucket!', '{s}', 3, 60)", "rate_limit_windows_bucket_check")


def test_the_counter_stores_no_address_and_is_closed_to_the_api_roles(db):
    cols = psql(db, "select column_name from information_schema.columns where table_name = 'rate_limit_windows' order by 1").stdout.split()
    assert cols == ["bucket", "hits", "subject", "window_start"]
    assert psql(db, "select relrowsecurity from pg_class where relname = 'rate_limit_windows'").stdout.strip() == "t"
    for role in ("anon", "authenticated", "public"):
        sig = "public.gf_rate_limit_hit(text, text, int, int)"
        assert psql(db, f"select has_function_privilege('{role}', '{sig}', 'execute')").stdout.strip() == "f", role
    assert psql(db, "select has_function_privilege('service_role', 'public.gf_rate_limit_hit(text, text, int, int)', 'execute')").stdout.strip() == "t"


def test_old_windows_are_swept_so_the_table_holds_no_history(db):
    s = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    psql(db, f"insert into rate_limit_windows values ('old', '{s}', now() - interval '3 days', 5)")
    for _ in range(600):                      # the sweep runs on ~1% of calls; 600 calls make a miss astronomically unlikely
        psql(db, f"select public.gf_rate_limit_hit('sweep', '{s}', 100000, 60)")
        if psql(db, "select count(*) from rate_limit_windows where bucket = 'old'").stdout.strip() == "0":
            return
    pytest.fail("an old window was never swept")


# --------------------------------------------------------------------------- 0025: comparisons

def test_a_saved_comparison_is_evidence_nobody_can_edit_or_delete(db):
    pid = project(db)
    out = json.loads(psql(db, save_sql(comparison_args(pid))).stdout.strip())
    assert out["created"] is True and out["project_id"] == pid
    refused(db, "update project_comparisons set grade = 'screening'", "append-only")
    refused(db, "update project_comparisons set result = '{}'::jsonb", "append-only")
    refused(db, "delete from project_comparisons", "append-only")
    refused(db, "truncate project_comparisons", "append-only")
    refused(db, "truncate project_shares", "append-only")
    ev = psql(db, f"select event_type, payload ? 'comparison_id' from project_events where project_id = '{pid}' order by occurred_at").stdout.split()
    assert ev == ["comparison_saved|t"]


def test_saving_the_same_question_on_the_same_build_is_a_no_op_and_a_different_one_is_not(db):
    pid = project(db)
    first = json.loads(psql(db, save_sql(comparison_args(pid, digest="a" * 64))).stdout.strip())
    again = json.loads(psql(db, save_sql(comparison_args(pid, digest="a" * 64))).stdout.strip())
    assert (first["created"], again["created"]) == (True, False)
    assert again["comparison_id"] == first["comparison_id"]
    other_build = json.loads(psql(db, save_sql(comparison_args(pid, digest="a" * 64, prov="q" * 64))).stdout.strip())
    other_question = json.loads(psql(db, save_sql(comparison_args(pid, digest="b" * 64))).stdout.strip())
    assert other_build["created"] and other_question["created"]
    assert psql(db, f"select count(*) from project_comparisons where project_id = '{pid}'").stdout.strip() == "3"
    assert psql(db, f"select count(*) from project_events where project_id = '{pid}' and event_type = 'comparison_saved'").stdout.strip() == "3"


def test_racing_saves_of_one_question_leave_exactly_one_comparison_and_one_event(db):
    pid = project(db)
    results = parallel(db, [save_sql(comparison_args(pid, digest="c" * 64))] * 12)
    assert all(rc == 0 for rc, _, _ in results), [e for _, _, e in results if e]
    created = [json.loads(o)["created"] for _, o, _ in results]
    assert created.count(True) == 1
    assert psql(db, f"select count(*) from project_comparisons where project_id = '{pid}'").stdout.strip() == "1"
    assert psql(db, f"select count(*) from project_events where project_id = '{pid}' and event_type = 'comparison_saved'").stdout.strip() == "1"


def test_a_project_and_its_first_comparison_are_created_together_or_not_at_all(db):
    before = psql(db, "select (select count(*) from projects), (select count(*) from project_comparisons)").stdout.strip()
    newp = {"project_token": uuid.uuid4().hex, "project_name": "Fresh", "company": None, "status": "draft"}
    # The comparison's event is refused (not a known event type): the project created a moment earlier must roll back with it.
    refused(db, save_sql(comparison_args(), event_type="not_an_event", new_project=newp), "project_events_event_type_check")
    assert psql(db, "select (select count(*) from projects), (select count(*) from project_comparisons)").stdout.strip() == before
    # A comparison the table refuses (grade outside the vocabulary) does the same.
    refused(db, save_sql(comparison_args(grade="great"), new_project=newp), "project_comparisons_grade_check")
    assert psql(db, "select (select count(*) from projects), (select count(*) from project_comparisons)").stdout.strip() == before
    ok = json.loads(psql(db, save_sql(comparison_args(), new_project=newp)).stdout.strip())
    assert ok["created"] is True
    kinds = psql(db, f"select event_type from project_events where project_id = '{ok['project_id']}' order by occurred_at, event_type").stdout.split()
    assert sorted(kinds) == ["comparison_saved", "project_created"]


def test_a_comparison_for_a_project_that_does_not_exist_is_refused(db):
    refused(db, save_sql(comparison_args(str(uuid.uuid4()))), "violates foreign key")


@pytest.mark.parametrize("field,value", [("request_digest", ""), ("provenance_digest", " "), ("engine_version", ""), ("schema", "")])
def test_a_comparison_must_say_what_it_is(db, field, value):
    pid = project(db)
    p = comparison_args(pid)
    p[field] = value
    refused(db, save_sql(p), "violates check constraint")


# --------------------------------------------------------------------------- 0025: share links

def issue_sql(pid, token_hash):
    ev = json.dumps({"event_type": "share_issued", "actor": "project_token_holder", "payload": {}})
    return f"select public.gf_issue_share('{pid}', '{token_hash}', '{ev}'::jsonb)"


def revoke_sql(pid):
    ev = json.dumps({"event_type": "share_revoked", "actor": "project_token_holder", "payload": {}})
    return f"select public.gf_revoke_share('{pid}', '{ev}'::jsonb)"


def h(label):
    return hashlib.sha256(label.encode()).hexdigest()


def test_issuing_a_link_retires_the_previous_one_in_the_same_transaction(db):
    pid = project(db)
    a = json.loads(psql(db, issue_sql(pid, h("a" + pid))).stdout.strip())
    b = json.loads(psql(db, issue_sql(pid, h("b" + pid))).stdout.strip())
    assert (a["replaced_previous"], b["replaced_previous"]) == (False, True)
    rows = psql(db, f"select token_hash = '{h('a' + pid)}', revoked_at is not null from project_shares where project_id = '{pid}' order by created_at").stdout.split()
    assert rows == ["t|t", "f|f"]
    ev = psql(db, f"select payload->>'replaced_previous' from project_events where project_id = '{pid}' and event_type = 'share_issued' order by occurred_at").stdout.split()
    assert ev == ["false", "true"]


def test_racing_issues_leave_exactly_one_active_link_and_no_error(db):
    pid = project(db)
    results = parallel(db, [issue_sql(pid, h(f"race{i}{pid}")) for i in range(10)])
    assert all(rc == 0 for rc, _, _ in results), [e for _, _, e in results if e]
    assert psql(db, f"select count(*) from project_shares where project_id = '{pid}' and revoked_at is null").stdout.strip() == "1"
    assert psql(db, f"select count(*) from project_shares where project_id = '{pid}'").stdout.strip() == "10"


def test_the_database_itself_refuses_a_second_active_link(db):
    pid = project(db)
    psql(db, issue_sql(pid, h("one" + pid)))
    refused(db, f"insert into project_shares (project_id, token_hash) values ('{pid}', '{h('two' + pid)}')", "project_shares_one_active")


def test_a_link_can_only_be_revoked_never_edited_revived_or_deleted(db):
    pid = project(db)
    psql(db, issue_sql(pid, h("x" + pid)))
    refused(db, f"update project_shares set token_hash = '{h('y')}' where project_id = '{pid}'", "can only be revoked")
    refused(db, f"update project_shares set project_id = '{project(db)}' where project_id = '{pid}'", "can only be revoked")
    refused(db, f"update project_shares set revoked_at = null where project_id = '{pid}'", "can only be revoked")
    refused(db, f"delete from project_shares where project_id = '{pid}'", "append-only")
    out = json.loads(psql(db, revoke_sql(pid)).stdout.strip())
    assert out == {"revoked": True}
    assert json.loads(psql(db, revoke_sql(pid)).stdout.strip()) == {"revoked": False}
    refused(db, f"update project_shares set revoked_at = null where project_id = '{pid}'", "stays revoked")
    refused(db, f"update project_shares set revoked_at = now() where project_id = '{pid}'", "stays revoked")


def test_only_a_sha256_can_be_stored_as_a_link_and_the_same_one_cannot_be_issued_twice(db):
    pid = project(db)
    for bad in ("short", "G" * 64, "A" * 64, "a" * 63):
        refused(db, issue_sql(pid, bad), "project_shares_token_hash_check")
    psql(db, issue_sql(pid, h("same")))
    refused(db, issue_sql(project(db), h("same")), "duplicate key")      # one secret opens one project, ever


def test_issuing_or_revoking_for_a_project_that_does_not_exist_is_refused(db):
    refused(db, issue_sql(str(uuid.uuid4()), h("z")), "no such project")
    refused(db, revoke_sql(str(uuid.uuid4())), "no such project")


def test_no_event_carries_a_link_or_its_hash(db):
    pid = project(db)
    tok = "secret-link-value-abcdefghijklmnopqrstuvwxyz0"
    psql(db, issue_sql(pid, h(tok)))
    dump = psql(db, f"select string_agg(payload::text, '') from project_events where project_id = '{pid}'").stdout
    assert tok not in dump and h(tok) not in dump


def test_new_tables_and_functions_are_closed_to_the_api_roles(db):
    for table in ("project_comparisons", "project_shares"):
        assert psql(db, f"select relrowsecurity from pg_class where relname = '{table}'").stdout.strip() == "t"
        assert psql(db, f"select count(*) from pg_policies where tablename = '{table}'").stdout.strip() == "0"
    for sig in ("public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb)", "public.gf_issue_share(uuid, text, jsonb)", "public.gf_revoke_share(uuid, jsonb)"):
        for role in ("anon", "authenticated", "public"):
            assert psql(db, f"select has_function_privilege('{role}', '{sig}', 'execute')").stdout.strip() == "f", (sig, role)
        assert psql(db, f"select has_function_privilege('service_role', '{sig}', 'execute')").stdout.strip() == "t"


def test_the_earlier_event_types_still_pass_and_the_new_ones_do_too(db):
    pid = project(db)
    for t in ("project_created", "paid_product_attached", "cost_evidence_run", "comparison_saved", "share_issued", "share_revoked"):
        psql(db, f"insert into project_events (project_id, event_type, actor) values ('{pid}', '{t}', 'x')")
    refused(db, f"insert into project_events (project_id, event_type, actor) values ('{pid}', 'something_else', 'x')", "project_events_event_type_check")
