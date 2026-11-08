"""0053: the site reference in the calibration ledger is the application's KEYED value, stored as given - and what that does and does not change.

Real PostgreSQL, the whole chain (0001..0053), plus a database built through 0052 for the boundary. Every name, key and digest is a SYNTHETIC fixture.

  * the function is 0047's body with ONE change (site_ref handling): proved by removing exactly that change and comparing the rest;
  * a well-formed site_ref is stored (project has a label); absent or JSON null -> the old unsalted derivation; malformed -> refused (23514), nothing
    written; well-formed on a project with no label -> ignored (no label, no reference, never exported);
  * calibration_ledger_rows is untouched and exports exactly what was stored;
  * BOTH ORDERS WORK: before 0053 the new application's payload succeeds and the stored reference is the unsalted one; after it the old application's
    payload (no site_ref) still gets the unsalted one;
  * legacy rows keep their unsalted references (no row is rewritten), so one site can appear under two references across the boundary - shown here,
    not hidden - and the operator-declared alias is what makes the CLI importer read them as one site;
  * applying it twice changes nothing, and the function stays closed to public, anon and authenticated.
"""
import hashlib
import importlib.util
import json
import re
import uuid
from pathlib import Path

import pytest
from calibration_pg_rig import (MIGRATIONS, ROOT, export_rows, new_case, new_evidence, new_project, obs_args, record_permission, review, submitted,
                                database_fixture, drop_database, make_database as make_full_database, psql, scalar, skip_without_db)
from registry_pg import make_database as make_database_through

pytestmark = skip_without_db
db = database_fixture()

MIGRATION = next(MIGRATIONS.glob("0053_*.sql"))
KEY = "vector-key-one-0123456789abcdef"
GOOD = '{"event_type": "observation_submitted", "actor": "someone", "payload": {}}'


def keyed(label, key=KEY):
    from gridforge.calibration import siteref
    return siteref.keyed_site_only_ref(label, key)


def unsalted(label):
    return "site_" + hashlib.sha256(label.strip().lower().encode()).hexdigest()[:12]


def function_text(path):
    sql = Path(path).read_text()
    a = sql.index("create or replace function public.gf_submit_observation")
    return sql[a:sql.index("$$;", sql.index("language plpgsql as $$", a)) + 3]


# ---------------------------------------------------------------------------------------------------- the file

def test_the_file_is_written_not_applied_has_a_replay_order_and_passes_the_appliers_destructive_gate():
    sql = MIGRATION.read_text()
    assert "WRITTEN, NOT APPLIED" in sql[:2500] and "REPLAY ORDER" in sql
    assert len(list(MIGRATIONS.glob("0053_*.sql"))) == 1
    spec = importlib.util.spec_from_file_location("apply_migration", ROOT / "scripts" / "apply-migration.py")
    am = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(am)
    assert am.destructive_statements(sql) == []
    # the header says the things an operator must know before applying it
    for needle in ("Refs are unsalted until 0053 is applied", "MIXED REFERENCES", "OVER-counts", "calibrate alias", "BOTH ORDERS WORK", "ROTATION"):
        assert needle in sql, needle


def test_it_creates_nothing_else_and_does_not_touch_the_view():
    sql = MIGRATION.read_text()
    code = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    assert re.findall(r"create or replace (\w+) ", code) == ["function"]
    assert not re.search(r"\b(create table|alter table|create index|create or replace view|drop |delete from|truncate|update\s+public)", code, re.I)
    assert "calibration_ledger_rows" not in code


def test_the_function_is_0047s_body_with_only_the_site_ref_handling_changed():
    old, new = function_text(next(MIGRATIONS.glob("0047_*.sql"))), function_text(MIGRATION)
    assert old != new
    new = new.replace("label text; supplied text := p->>'site_ref';", "label text;")
    start = new.index("  -- 0053: the application computes")
    end = new.index("  select * into cs from public.power_deployment_cases")
    assert new[:start] + new[end:] == old


# ---------------------------------------------------------------------------------------------------- what the function does

def call(db, args, check=True):
    """gf_submit_observation with this payload (the quotes of the JSON doubled for the SQL literal); the SQLSTATE is printed on an error."""
    return psql(db, f"select gf_submit_observation('{json.dumps(args).replace(chr(39), chr(39) * 2)}'::jsonb, '{GOOD}'::jsonb)", check=check, sqlstate=True)


def row_count(db, project):
    return int(scalar(db, f"select count(*) from project_observations where project_id = '{project}'")), int(
        scalar(db, f"select count(*) from project_events where project_id = '{project}' and event_type = 'observation_submitted'"))


def test_a_well_formed_site_ref_is_stored_as_given(db):
    ref = keyed("Cork DC2")
    _, _, o = submitted(db, site="Cork DC2", site_ref=ref)
    assert o["site_ref"] == ref
    assert scalar(db, f"select site_ref from project_observations where id = '{o['id']}'") == ref
    assert ref != unsalted("Cork DC2")


@pytest.mark.parametrize("how", ["absent", "json null"])
def test_absent_or_null_site_ref_is_the_old_unsalted_derivation(db, how):
    """The OLD application sends no site_ref; a JSON null is the same. Both get exactly what 0038/0047 derived."""
    project = new_project(db, "  Cork DC2 ")
    case, ev = new_case(db, created_at="2026-03-02T09:00:00Z"), new_evidence(db, project)
    args = json.loads(obs_args(project, ev, case))
    if how == "json null":
        args["site_ref"] = None
    assert ("site_ref" in args) == (how == "json null")
    assert json.loads(call(db, args).stdout)["site_ref"] == unsalted("Cork DC2")


MALFORMED = ["", "site_", "site_0123456789a", "site_0123456789abc", "site_0123456789AB", "site_0123456789ag", "Site_0123456789ab", " site_0123456789ab",
             "site_0123456789ab ", "site_0123456789ab\n", "site-0123456789ab", "site_0123456789ab-01234567", "abc", "5", "true", "site_000000000000'; drop table x;--"]


@pytest.mark.parametrize("bad", MALFORMED)
def test_a_malformed_site_ref_is_refused_and_nothing_is_written(db, bad):
    project = new_project(db, "Cork DC2")
    case, ev = new_case(db, created_at="2026-03-02T09:00:00Z"), new_evidence(db, project)
    args = json.loads(obs_args(project, ev, case))
    args["site_ref"] = bad
    before = row_count(db, project)
    r = call(db, args, check=False)
    assert r.returncode != 0 and "23514" in r.stderr, r.stderr
    assert row_count(db, project) == before == (0, 0)


@pytest.mark.parametrize("bad", [5, True, [], {}, ["site_0123456789ab"]])
def test_a_site_ref_of_the_wrong_json_type_is_refused_too(db, bad):
    project = new_project(db, "Cork DC2")
    case, ev = new_case(db, created_at="2026-03-02T09:00:00Z"), new_evidence(db, project)
    args = json.loads(obs_args(project, ev, case))
    args["site_ref"] = bad
    r = call(db, args, check=False)
    assert r.returncode != 0 and "23514" in r.stderr, r.stderr
    assert row_count(db, project) == (0, 0)


def test_a_project_with_no_site_label_gets_no_reference_whatever_is_supplied(db):
    for blank in (None, "   "):
        project = new_project(db, blank)
        _, _, o = submitted(db, project=project, site_ref=keyed("Anything"))
        assert o["site_ref"] is None
        assert review(db, o["id"]).returncode == 0
        record_permission(db, project)
        assert export_rows(db, f"id = '{o['id']}'") == []


def test_the_ledger_view_exports_exactly_the_stored_reference_and_never_recomputes_it(db):
    ref = keyed("Galway DC3")
    project, _, o = submitted(db, site="Galway DC3", site_ref=ref)
    assert review(db, o["id"]).returncode == 0
    record_permission(db, project)
    rows = export_rows(db, f"id = '{o['id']}'")
    assert [r["site_ref"] for r in rows] == [ref]
    view = scalar(db, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
    assert "hmac" not in view.lower() and "site_ref IS NOT NULL" in view
    assert not re.search(r"site_ref\s*=|sha256\(convert_to\(o\.", view)
    # a stored value nobody can reproduce from the label is exported as stored: the view is a filter, not a derivation
    scalar(db, f"set session_replication_role = replica; update project_observations set site_ref = 'site_aaaaaaaaaaaa' where id = '{o['id']}' returning 1")
    assert [r["site_ref"] for r in export_rows(db, f"id = '{o['id']}'")] == ["site_aaaaaaaaaaaa"]


def test_two_references_for_one_label_are_two_sites_to_the_database(db):
    """The honest consequence of leaving legacy rows alone: the database cannot know that an unsalted and a keyed reference are the same site."""
    label = f"Boundary {uuid.uuid4().hex[:6]}"
    a = submitted(db, site=label)[2]["site_ref"]
    b = submitted(db, site=label, site_ref=keyed(label))[2]["site_ref"]
    assert (a, b) == (unsalted(label), keyed(label)) and a != b


def test_the_function_is_closed_to_public_anon_and_authenticated_and_open_to_the_service_role(db):
    sig = "public.gf_submit_observation(jsonb, jsonb)"
    got = scalar(db, f"select has_function_privilege('anon', '{sig}', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', '{sig}', 'EXECUTE')::text || ',' "
                     f"|| has_function_privilege('service_role', '{sig}', 'EXECUTE')::text || ',' || exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, '{{}}')) a "
                     f"where p.oid = '{sig}'::regprocedure and a.grantee = 0)::text")
    assert got == "false,false,true,false"
    r = psql(db, "set role anon; select public.gf_submit_observation('{}'::jsonb, '{}'::jsonb)", check=False)
    assert r.returncode != 0 and "permission denied" in r.stderr


# ---------------------------------------------------------------------------------------------------- the boundary: before and after 0053

def fingerprint(name):
    return {
        "function": scalar(name, "select md5(pg_get_functiondef('public.gf_submit_observation(jsonb, jsonb)'::regprocedure))"),
        "acl": scalar(name, "select coalesce(proacl::text, 'null') from pg_proc where oid = 'public.gf_submit_observation(jsonb, jsonb)'::regprocedure"),
        "view": scalar(name, "select md5(pg_get_viewdef('public.calibration_ledger_rows'::regclass))"),
        "view_acl": scalar(name, "select coalesce(relacl::text, 'null') from pg_class where oid = 'public.calibration_ledger_rows'::regclass"),
        "others": scalar(name, "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                               "where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'gf_submit_observation'"),
        "constraints": scalar(name, "select md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '' order by conrelid::regclass::text, conname)) from pg_constraint where connamespace = 'public'::regnamespace"),
    }


def test_before_0053_the_new_applications_payload_works_and_stores_the_unsalted_reference_and_after_it_legacy_rows_are_left_alone():
    name = make_database_through("0052")
    try:
        label = "Cork DC2"
        # BEFORE: the new application sends site_ref; the old function ignores the key and derives the unsalted hash. The submission succeeds.
        project_a, _, a = submitted(name, site=label, site_ref=keyed(label))
        assert a["site_ref"] == unsalted(label), "before 0053 the supplied key is ignored: refs are unsalted until 0053 is applied"
        project_b, _, b = submitted(name, site=label)
        assert b["site_ref"] == unsalted(label)
        before = scalar(name, "select md5(string_agg(to_jsonb(o)::text || o.xmin::text, '|' order by o.id)) from project_observations o")
        view_before = fingerprint(name)

        psql(name, file=MIGRATION)

        # No row was rewritten (not even a no-op update: xmin is part of the digest) and the view and every other function are as they were.
        assert scalar(name, "select md5(string_agg(to_jsonb(o)::text || o.xmin::text, '|' order by o.id)) from project_observations o") == before
        after = fingerprint(name)
        assert after["view"] == view_before["view"] and after["view_acl"] == view_before["view_acl"]
        assert after["others"] == view_before["others"] and after["constraints"] == view_before["constraints"]
        assert after["function"] != view_before["function"]

        # AFTER: the OLD application (no site_ref) still gets the unsalted reference; the NEW one gets its keyed reference. One label, two references.
        _, _, old_app = submitted(name, site=label)
        _, _, new_app = submitted(name, site=label, site_ref=keyed(label))
        assert old_app["site_ref"] == unsalted(label) and new_app["site_ref"] == keyed(label)
        refs = scalar(name, f"select string_agg(distinct site_ref, ',' order by site_ref) from project_observations where project_id in "
                            f"(select id from projects where site_label = '{label}')").split(",")
        assert sorted(refs) == sorted({unsalted(label), keyed(label)}) and len(refs) == 2

        # Idempotent: a second application changes nothing
        first = fingerprint(name)
        psql(name, file=MIGRATION)
        psql(name, file=MIGRATION)
        assert fingerprint(name) == first
    finally:
        drop_database(name)


def test_the_cli_importer_reads_an_unsalted_and_a_keyed_reference_as_one_site_only_once_the_operator_declares_it(tmp_path, monkeypatch):
    """The legacy reference and the keyed one reach the ledger through the real export of a real database. Without an alias the importer
    keeps both (and says so: tests/test_site_ref_hmac.py); with `gridforge calibrate alias` they are one site."""
    from gridforge.calibration import siteref
    from gridforge.calibration.ledger import EXPORT_SCHEMA, import_export, read_chain, load_ledger
    name = make_full_database()
    try:
        label = "Cork DC2"
        exported = []
        for day, ref in (("2026-06-30", None), ("2026-07-01", keyed(label))):
            over = {"site_ref": ref} if ref else {}
            project, _, o = submitted(name, site=label, on=day, **over)
            assert review(name, o["id"]).returncode == 0
            record_permission(name, project)
            exported += export_rows(name, f"id = '{o['id']}'")
        assert {r["site_ref"] for r in exported} == {unsalted(label), keyed(label)}
        doc = {"schema": EXPORT_SCHEMA, "rows": exported}

        plain = tmp_path / "plain.json"
        import_export(doc, plain)
        assert len({o.site for o in read_chain(plain)[0]}) == 2                      # undeclared: two sites, as the database holds them

        aliased = tmp_path / "aliased.json"
        monkeypatch.delenv(siteref.ALIAS_ENV, raising=False)
        siteref.add_alias(siteref.alias_path(private=aliased), unsalted(label), keyed(label))
        out = import_export(doc, aliased)
        assert out["rekeyed"] == 1 and out["distinct_sites_imported"] == 1
        # and the same measurement exported once under each reference is recognised as ONE observation, not counted twice
        dup = {"schema": EXPORT_SCHEMA, "rows": [{**exported[1], "id": str(uuid.uuid4()), "evidence_sha256": "b" * 64, "observed_on": exported[0]["observed_on"]}]}
        with pytest.raises(Exception, match="already recorded"):
            import_export(dup, aliased)
        assert {o.site for o in read_chain(aliased)[0]} == {keyed(label)}
        monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(aliased))
        assert len({o.site for o in load_ledger().observations}) == 1
    finally:
        drop_database(name)
