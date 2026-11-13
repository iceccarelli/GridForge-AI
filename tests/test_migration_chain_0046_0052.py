"""The whole chain, 0001..0053, as one thing: what the families added together (L1 0046-0048, L2 0049-0051, the site-origin gate 0052, the salted site
reference 0053) must leave true, which no single family's tests can see. (The file keeps its name; 0053's own behaviour is in tests/test_salted_site_ref_migration.py.)

  * every function the later migrations add is closed to PUBLIC, anon and authenticated (a Supabase project's default privileges hand a new
    function to the API roles; each migration has to take it back);
  * project_events_event_type_check allows every event type any code writes (lib/ and app/ via ev("..."), the database functions that
    emit, and the types the migrations themselves add), so no migration's rebuild of that list dropped another's type;
  * replaying 0049-0053 a second time changes nothing (0056 is replayed last, in each round: 0056 holds the FINAL ledger view, 0052's replay puts the
    older definition back and only a later 0056 restores it, which is the replay order those migrations' headers state);
  * applying 0046-0053 and then 0056 over a database that already holds rows from 0001-0045 succeeds and rewrites nothing (0053 holds no table, column
    or row change: an existing observation keeps its unsalted site_ref, which is why one site can carry two references across the boundary; 0056 adds two
    nullable columns to the observations and back-fills neither: a legacy row has no organisation and no consent, so it is never in the ledger view).

Real PostgreSQL. Skipped, loudly, where there is none; GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure. Every value is synthetic.
"""
import json
import re
import uuid
from pathlib import Path

import pytest
from calibration_pg_rig import satisfy_publication_gates
from registry_pg import (MIGRATIONS, ROOT, add_member, drop_database, make_database, needs_db, new_hall, new_org, new_site, ok, psql, q, scalar,
                         seed_evidence, seed_observation, seed_project)

pytestmark = needs_db


def migration(number):
    return next(MIGRATIONS.glob(f"{number}_*.sql"))


@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


def allowed_event_types(db):
    definition = scalar(db, "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.project_events'::regclass and conname = 'project_events_event_type_check'")
    return set(re.findall(r"'([a-z_]+)'", definition))


# ---------------------------------------------------------------------------------------------------- function privileges

def test_every_function_the_later_migrations_add_is_closed_to_public_anon_and_authenticated():
    old = make_database(through="0045")
    new = make_database()
    try:
        before = set(scalar(old, "select string_agg(p.oid::regprocedure::text, '~') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'").split("~"))
        rows = scalar(new, "select string_agg(p.oid::regprocedure::text || '|' || (p.proacl is null)::text || '|' || "
                           "exists (select 1 from aclexplode(coalesce(p.proacl, '{}')) a where a.grantee = 0)::text || '|' || "
                           "has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text, E'\\n') "
                           "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'").splitlines()
        added = [r.split("|") for r in rows if r.split("|")[0] not in before]
        names = {a[0] for a in added}
        # the ones this chain is known to add: if a rename or a missing function shrank the set, this stops being a check of anything
        for expected in ("gf_record_calibration_permission(jsonb,jsonb)", "gf_review_evidence(jsonb,jsonb)", "gf_forecast_predicted_mw(jsonb,text)",
                         "gf_create_org(text,text)", "gf_record_hall_input(text,uuid,text,jsonb,text,text,text,uuid,uuid,date,uuid)",
                         "gf_attach_project_to_hall(text,uuid,text)", "gf_detach_project_from_hall(text,uuid,uuid)", "gf_hall_timeline"):
            assert any(n.startswith(expected.split("(")[0] + "(") for n in names), (expected, sorted(names))
        assert len(added) >= 30, len(added)
        for name, acl_is_null, public_grant, anon, authenticated in added:
            assert (acl_is_null, public_grant, anon, authenticated) == ("false", "false", "false", "false"), name
    finally:
        drop_database(old)
        drop_database(new)


# ---------------------------------------------------------------------------------------------------- event types

def code_event_types():
    """Every event type code writes: ev("...") and event_type: "..." under lib/ and app/, and the ProjectEventType union."""
    found = set()
    for base in (ROOT / "lib", ROOT / "app"):
        for f in list(base.rglob("*.ts")) + list(base.rglob("*.tsx")):
            text = f.read_text()
            found |= set(re.findall(r'\bev\(\s*"([a-z_]+)"', text))
            found |= set(re.findall(r'\bevent_type:\s*"([a-z_]+)"', text))
    union = re.search(r"export type ProjectEventType =(.*?);", (ROOT / "lib" / "projects.ts").read_text(), re.S).group(1)
    return found | set(re.findall(r'"([a-z_]+)"', union))


def migration_event_types():
    """The types the migrations of this family add ('want' arrays) and the base list they carry, read from their text; plus the literals the
    database functions of 0050 emit."""
    types = set()
    for n in ("0047", "0048", "0050"):
        text = migration(n).read_text()
        for arr in re.findall(r"(?:want|base) text\[\] := array\[(.*?)\]", text, re.S):
            types |= set(re.findall(r"'([a-z_]+)'", arr))
    types |= set(re.findall(r"'event_type', '([a-z_]+)'", migration("0050").read_text()))
    return types


def test_the_event_type_check_allows_every_type_code_and_the_migrations_write(db):
    allowed = allowed_event_types(db)
    code, mig = code_event_types(), migration_event_types()
    assert {"evidence_reviewed", "calibration_permission_recorded", "project_attached_to_hall", "project_detached_from_hall", "btm_case_revised"} <= mig | code
    assert len(code) >= 20 and len(mig) >= 20, (code, mig)          # the regexes found something: a path or a pattern change would empty them
    assert code <= allowed, sorted(code - allowed)
    assert mig <= allowed, sorted(mig - allowed)
    # and every type 0045 allowed is still allowed
    old = make_database(through="0045")
    try:
        assert allowed_event_types(old) <= allowed
    finally:
        drop_database(old)


def test_every_allowed_type_can_actually_be_written(db):
    pid, _ = seed_project(db)
    for t in sorted(allowed_event_types(db)):
        psql(db, f"insert into project_events (project_id, event_type, actor) values ('{pid}', {q(t)}, 'x')")
    psql(db, "select 1")
    r = psql(db, f"insert into project_events (project_id, event_type, actor) values ('{pid}', 'made_up', 'x')", check=False)
    assert r.returncode != 0 and "project_events_event_type_check" in r.stderr


# ---------------------------------------------------------------------------------------------------- replay twice

def fingerprint(db):
    """Everything 0049-0053 define or constrain, plus the rows in their tables, as one digest per kind."""
    return {
        "functions": scalar(db, "select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                                "where n.nspname = 'public' and p.proname like 'gf\\_%' and p.prokind = 'f'"),
        "function_acls": scalar(db, "select md5(string_agg(p.oid::regprocedure::text || coalesce(p.proacl::text, 'null'), '' order by p.oid::regprocedure::text)) from pg_proc p "
                                    "join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'gf\\_%'"),
        "constraints": scalar(db, "select md5(string_agg(conrelid::regclass::text || conname || pg_get_constraintdef(oid), '' order by conrelid::regclass::text, conname)) from pg_constraint "
                                  "where connamespace = 'public'::regnamespace"),
        "triggers": scalar(db, "select md5(string_agg(tgrelid::regclass::text || tgname || tgenabled::text || pg_get_triggerdef(oid), '' order by tgrelid::regclass::text, tgname)) from pg_trigger where not tgisinternal"),
        "views": scalar(db, "select md5(string_agg(viewname || pg_get_viewdef((schemaname || '.' || viewname)::regclass), '' order by viewname)) from pg_views where schemaname = 'public'"),
        "table_acls": scalar(db, "select md5(string_agg(c.oid::regclass::text || coalesce(c.relacl::text, 'null'), '' order by c.oid::regclass::text)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')"),
        "indexes": scalar(db, "select md5(string_agg(indexdef, '' order by indexname)) from pg_indexes where schemaname = 'public'"),
        "rows": scalar(db, "select (select count(*) from organisations) || '/' || (select count(*) from organisation_members) || '/' || (select count(*) from sites) || '/' || "
                           "(select count(*) from halls) || '/' || (select count(*) from hall_inputs) || '/' || (select count(*) from hall_project_attachments) || '/' || "
                           "(select count(*) from hall_project_detachments) || '/' || (select count(*) from project_events) || '/' || (select count(*) from calibration_ledger_rows)"),
    }


def test_replaying_0049_to_0053_twice_is_harmless():
    name = make_database()
    try:
        owner, editor = "owner-a@a.example", "editor-a@a.example"
        org = new_org(name, owner)
        add_member(name, org, owner, editor, "editor")
        site = new_site(name, owner, org, origin="test")
        hall = new_hall(name, owner, site)
        pid, token = seed_project(name)
        ok(name, "gf_attach_project_to_hall", p_actor=editor, p_hall=hall, p_project_token=token)
        ok(name, "gf_record_hall_input", p_actor=editor, p_hall=hall, p_field_path="grid.firm_capacity_mva", p_value=40, p_unit="MVA", p_evidence_class="E1",
           p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-15")
        # the observation is PRODUCTION (seed_observation's default), so from 0056 on it needs what a real submission has before it: the project is already
        # in the organisation's hall, and the organisation records its consent and the project attests its completion milestone (the same rig helper
        # the other calibration tests use). The fingerprint then covers those tables' rows and definitions too.
        satisfy_publication_gates(name, pid)
        ev = seed_evidence(name, pid)
        seed_observation(name, pid, ev, review_class="E5")
        first = fingerprint(name)
        assert first["rows"].split("/")[5] == "1"
        assert scalar(name, "select count(*) from calibration_consents") == "1" and scalar(name, "select count(*) from project_completion_milestones") == "1"
        for _ in range(2):
            for n in ("0049", "0050", "0051", "0052", "0053", "0056"):
                psql(name, file=migration(n))
        assert fingerprint(name) == first
        # and it still works afterwards: the registry's guard on the attached project holds, a new site can be made
        assert ok(name, "gf_create_site", p_actor=owner, p_org=org, p_name="Another", p_country="DE", p_data_origin="production")["site"]["data_origin"] == "production"
    finally:
        drop_database(name)


# ---------------------------------------------------------------------------------------------------- applying over legacy rows

# the unsalted reference 0038 derived for the label 'Cork DC2': sha256('cork dc2')
LEGACY_SITE_REF = "site_4f244bf6344d"
LEGACY_TABLES = ["projects", "project_events", "project_evidence", "project_observations", "project_observation_reviews", "power_deployment_cases",
                 "project_links"]


def snapshot(db):
    """Each legacy table's rows as JSON with the system column xmin (the id of the transaction that last WROTE the row: an UPDATE changes it) and
    the table's file node (a rewrite changes it)."""
    out = {}
    for t in LEGACY_TABLES:
        rows = json.loads(scalar(db, f"select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('_xmin', t.xmin::text) order by to_jsonb(t)->>'id'), '[]') from public.{t} t"))
        out[t] = {"rows": rows, "filenode": scalar(db, f"select pg_relation_filenode('public.{t}'::regclass)")}
    return out


def test_applying_0046_to_0053_and_0056_over_legacy_rows_succeeds_and_rewrites_nothing():
    name = make_database(through="0045")
    try:
        old_types = allowed_event_types(name)
        owner_project = scalar(name, "select (public.gf_create_project(jsonb_build_object('project_token', 'legacy-" + uuid.uuid4().hex + "', 'project_name', 'Legacy hall', 'site_label', 'Cork DC2'),"
                                     " '{\"event_type\": \"project_created\", \"actor\": \"x\", \"payload\": {}}'::jsonb))->>'id'")
        other_project = seed_project(name, "Legacy two")[0]
        files = {}
        for status in ("verified", "rejected", "unverified"):
            files[status] = scalar(name, "insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref, review_status) "
                                         f"values ('{owner_project}', '{status}.pdf', 'application/pdf', '{uuid.uuid4().hex * 2}', 100, 'project-evidence/x/{status}', '{status}') returning id")
        psql(name, "select public.gf_append_case_revision(jsonb_build_object('case_token', 'legacy-case', 'revision', 1, 'request', '{\"it_mw\": 10}'::jsonb, "
                   "'result', '{\"architectures\": [{\"label\": \"A\", \"available_MW\": 12.5}]}'::jsonb, 'changed_fields', '[]'::jsonb), "
                   "'{\"event_type\": \"btm_case_revised\", \"actor\": \"x\", \"payload\": {}}'::jsonb)")
        obs = scalar(name, "insert into project_observations (project_id, prediction_ref, case_token, case_revision, architecture, calibration_key, unit, predicted_value, predicted_source, "
                           "observed_value, observed_on, method, evidence_id, installed_attested, installed_basis, submitted_by, site_ref) values "
                           f"('{owner_project}', 'power_deployment_case:legacy-case:r1:A', 'legacy-case', 1, 'A', 'btm.firm_MW', 'MW', 12.5, 'engine', 11, '2026-03-01', 'meter', "
                           f"'{files['verified']}', true, 'commissioning sheet', 'x@a.example', '{LEGACY_SITE_REF}') returning id")
        psql(name, "insert into project_observation_reviews (observation_id, project_id, decision, evidence_class, reviewer) "
                   f"values ('{obs}', '{owner_project}', 'verified', 'E5', 'reviewer@desk.example')")
        assert other_project
        before = snapshot(name)
        assert all(before[t]["rows"] for t in LEGACY_TABLES if t != "project_links"), {t: len(v["rows"]) for t, v in before.items()}

        for n in ("0046", "0047", "0048", "0049", "0050", "0051", "0052", "0053", "0056"):
            r = psql(name, file=migration(n), check=False)
            assert r.returncode == 0, (n, r.stderr)

        after = snapshot(name)
        for t in LEGACY_TABLES:
            assert after[t]["filenode"] == before[t]["filenode"], f"{t} was rewritten"
            assert len(after[t]["rows"]) == len(before[t]["rows"]), t
            for old_row, new_row in zip(before[t]["rows"], after[t]["rows"]):
                # same row, same writing transaction; the only difference allowed is a column a migration added (a default or null)
                assert {k: new_row[k] for k in old_row} == old_row, (t, old_row["id"])
        # the added columns hold what 'not stated' means, not an invention
        new_obs = after["project_observations"]["rows"][0]
        assert new_obs["data_origin"] == "unclassified"
        assert new_obs["site_ref"] == LEGACY_SITE_REF == before["project_observations"]["rows"][0]["site_ref"]       # 0053 leaves the legacy (unsalted) reference exactly as it was
        assert after["power_deployment_cases"]["rows"][0]["case_digest"] is None
        # 0056 adds the organisation and the consent a row was recorded under, and invents neither for a row recorded before it: such a row names no
        # organisation, so no consent can cover it, and it stays out of the ledger however it is reviewed
        assert new_obs["organisation_id"] is None and new_obs["consent_id"] is None
        for table in ("calibration_consents", "project_completion_milestones", "calibration_tombstones", "calibration_release_snapshots",
                      "calibration_snapshot_supersessions"):
            assert scalar(name, f"select count(*) from {table}") == "0", table
        assert {r["review_status"] for r in after["project_evidence"]["rows"]} == {"verified", "rejected", "unverified"}
        assert all(r.get("site_id") is None and r.get("hall_id") is None for r in after["projects"]["rows"])
        # nothing legacy reaches the ledger (unclassified, no forecast digest, no decision row, no permission) and nothing was invented
        assert scalar(name, "select count(*) from calibration_ledger_rows") == "0"
        assert scalar(name, "select count(*) from project_evidence_reviews") == "0" and scalar(name, "select count(*) from calibration_permissions") == "0"
        assert scalar(name, "select count(*) from organisations") == "0" and scalar(name, "select count(*) from hall_project_attachments") == "0"
        assert allowed_event_types(name) >= old_types
        # the new rules apply from now on: a file can no longer arrive verified, and the legacy verified file cannot be re-reviewed
        r = psql(name, f"insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref, review_status) values ('{owner_project}', 'n.pdf', 'application/pdf', '{'a' * 64}', 1, 'x/y', 'verified')", check=False)
        assert r.returncode != 0 and "arrives unverified" in r.stderr
    finally:
        drop_database(name)
