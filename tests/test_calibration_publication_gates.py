"""0056_calibration_publication_gates.sql against a REAL PostgreSQL: the completion-milestone gate (D1), the consent-path gates (D3), withdrawal
tombstones (D5) and the release-snapshot registry (R4, the database half).

Before 0056 an observation could be recorded for a project that was still being built, for an organisation that had never said what may be published
or at what aggregation, and nothing remembered a withdrawal except the absence of a row: the view simply stopped listing it, and a later grant (or a
re-import) listed it again. This attacks the gates the way a careless or hostile service-role caller would, and for each gate checks BOTH places it is
enforced: at INSERT (a trigger, so it binds every way a row can arrive) and at PUBLICATION (the view the importer trusts), the second with the first
switched off (session_replication_role = replica) so a row the trigger would have refused is shown still not to be listed.

Every value is SYNTHETIC. The pure half of R4 is tests/test_release_differencing.py. See tests/calibration_pg_rig.py for how the database is built;
GRIDFORGE_MIGRATIONS_DIR replays a mutated copy of the migrations, which is how each guard is shown to matter (the guard commented out, the test red).
"""
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import calibration_pg_rig as rig
import registry_pg as reg
from calibration_pg_rig import (
    DOC, GOOD, MIGRATIONS, as_anon, as_service_role, bypassing_triggers, count, database_fixture, drop_database, export_rows, make_database, new_evidence,
    new_project, psql, record_permission, review, scalar, skip_without_db,
)
from gridforge.calibration import release as R

pytestmark = skip_without_db
db = database_fixture()

TEXT_SHA = "7" * 63 + "1"
#: organisation id -> its context, so the writers below know who the owner is without every test passing it
CONTEXTS = {}


@pytest.fixture()
def fresh():
    """A database of its own: the snapshot registry is global, so each release test starts from an empty one."""
    name = make_database()
    yield name
    drop_database(name)


# ---------------------------------------------------------------------------------------------- builders

def org_context(db, origin="production"):
    """An organisation with an owner, an editor and a viewer (addresses of its own: one person may create only so many organisations), one site of the
    given origin and one hall."""
    tag = uuid.uuid4().hex[:8]
    owner, editor, viewer = (f"{who}-{tag}@org.example" for who in ("owner", "editor", "viewer"))
    org = reg.new_org(db, owner)
    reg.add_member(db, org, owner, editor, "editor")
    reg.add_member(db, org, owner, viewer, "viewer")
    site = reg.new_site(db, owner, org, origin=origin)
    c = SimpleNamespace(org=org, site=site, hall=reg.new_hall(db, owner, site), owner=owner, editor=editor, viewer=viewer)
    CONTEXTS[org] = c
    return c


def submit(db, *args, **kw):
    """The rig's submit WITHOUT its help: here the gates are the subject, so what an organisation must do first (a hall, a consent, a milestone) is done, or
    left undone, by the test itself."""
    kw.setdefault("gates", False)
    return rig.submit(db, *args, **kw)


def attach(db, project, hall, actor):
    token = scalar(db, f"select project_token from projects where id = '{project}'")
    reg.ok(db, "gf_attach_project_to_hall", p_actor=actor, p_hall=hall, p_project_token=token)


def call(db, fn, payload, check=False, sqlstate=False):
    """A gf_* function called as the service role with one jsonb argument (and the history event where the function wants one)."""
    ev = f", '{GOOD % 'completion_milestone_attested'}'::jsonb" if fn == "gf_attest_completion_milestone" else ""
    return psql(db, f"set role service_role; select public.{fn}({reg.q(json.dumps(payload))}::jsonb{ev})", check=check, sqlstate=sqlstate)


def result(r):
    return json.loads(r.stdout.strip().splitlines()[-1])


def consent_payload(org, actor=None, **over):
    actor = CONTEXTS[org].owner if actor is None else actor
    p = {"organisation_id": org, "publish_scope": "aggregate_residual_statistics", "min_aggregate_observations": 10, "min_aggregate_organisations": 3,
         "consent_text_version": "2026-11", "consent_text_sha256": TEXT_SHA, "document_sha256": DOC("consent-" + org), "recorded_by": actor,
         "note": "signed"}
    p.update(over)
    return {k: v for k, v in p.items() if v is not None}


def grant(db, org, actor=None, check=True, **over):
    return call(db, "gf_record_calibration_consent", consent_payload(org, actor, **over), check=check)


def withdraw(db, org, actor=None, check=True, doc=None):
    return call(db, "gf_withdraw_calibration_consent",
                {"organisation_id": org, "recorded_by": CONTEXTS[org].owner if actor is None else actor, "document_sha256": doc or DOC("withdrawal-" + uuid.uuid4().hex),
                 "note": "withdrawn"}, check=check)


def attest(db, project, evidence, actor, reached_on="2026-05-01", check=True, **over):
    p = {"project_id": project, "milestone": "energised", "reached_on": reached_on, "evidence_id": evidence, "basis": "energisation certificate, hall A",
         "attested_by": actor}
    p.update(over)
    return call(db, "gf_attest_completion_milestone", {k: v for k, v in p.items() if v is not None}, check=check)


def prepared(db, ctx, *, milestone=True, reached_on="2026-05-01", site=None):
    """A project attached to the context's hall, with a verified file; with `milestone` it has attested that it reached its completion milestone."""
    project = new_project(db, site or f"Site {uuid.uuid4().hex[:8]}")
    attach(db, project, ctx.hall, ctx.owner)
    proof = new_evidence(db, project, verified=True, sha="b")
    if milestone:
        attest(db, project, proof, ctx.owner, reached_on=reached_on)
    return project, proof


def eligible(db, ctx, *, on="2026-06-30", **kw):
    """A production observation of a project of `ctx` that clears every gate: consent standing, milestone attested, reviewed, the project's own permission."""
    project, _ = prepared(db, ctx, **kw)
    _, ev, r = submit(db, project=project, on=on)
    assert r.returncode == 0, r.stderr
    oid = json.loads(r.stdout)["id"]
    assert review(db, oid).returncode == 0
    record_permission(db, project)
    return project, oid


#: What a copy of an observation row carries (the generated columns, delta_value and delta_pct, cannot be inserted).
OBS_COLUMNS = ("project_id, prediction_ref, case_token, case_revision, architecture, calibration_key, unit, predicted_value, predicted_source, observed_value, "
               "observed_on, method, evidence_id, installed_attested, installed_basis, submitted_by, measurement_kind, site_ref, engine_provenance_digest, "
               "report_date, data_origin")
REINSERT = f"insert into project_observations (id, {OBS_COLUMNS}) select id, {OBS_COLUMNS} from project_observations where id = "


def exported(db, oid):
    return len(export_rows(db, f"id = '{oid}'")) == 1


def refused(r, needle):
    assert r.returncode != 0, "the statement was accepted"
    assert needle in r.stderr, r.stderr


def stored(db, oid, column):
    return scalar(db, f"select {column} from project_observations where id = '{oid}'")


@pytest.fixture(scope="module")
def ctx(db):
    c = org_context(db)
    grant(db, c.org)
    return c


# =============================================================================================== D3: consent, at insert

def test_a_production_observation_needs_a_project_that_belongs_to_an_organisation(db):
    project = new_project(db)                                            # never attached to a hall: no organisation to name
    _, _, r = submit(db, project=project)
    refused(r, "attached to a hall of an organisation")
    assert count(db, "project_observations", f"project_id = '{project}'") == 0
    assert "GF015" in psql(db, f"select gf_submit_observation('{rig.obs_args(project, new_evidence(db, project), rig.new_case(db, created_at='2026-03-02T09:00:00Z'))}'::jsonb,"
                               f" '{GOOD % 'observation_submitted'}'::jsonb)", check=False, sqlstate=True).stderr


def test_a_production_observation_is_refused_until_the_organisation_has_consented(db):
    fresh_ctx = org_context(db)
    project, _ = prepared(db, fresh_ctx)
    r = submit(db, project=project)[2]
    refused(r, "no standing calibration consent")
    assert count(db, "project_observations", f"project_id = '{project}'") == 0
    grant(db, fresh_ctx.org)
    assert submit(db, project=project)[2].returncode == 0


def test_the_organisation_and_the_consent_that_covered_the_row_are_derived_and_stored(db, ctx):
    project, _ = prepared(db, ctx)
    consent_id = scalar(db, f"select id from calibration_consents where organisation_id = '{ctx.org}' order by seq desc limit 1")
    other = reg.new_org(db, "someone@else.example")
    # a payload that tries to name another organisation: the function does not read the key
    _, _, r = submit(db, project=project, organisation_id=other, consent_id=str(uuid.uuid4()))
    assert r.returncode == 0, r.stderr
    oid = json.loads(r.stdout)["id"]
    assert stored(db, oid, "organisation_id") == ctx.org and stored(db, oid, "consent_id") == consent_id
    # and a direct insert that names another organisation and another consent: the trigger overwrites both with what the database derives
    copy = (f"insert into project_observations ({OBS_COLUMNS}, organisation_id, consent_id) "
            f"select {OBS_COLUMNS.replace('observed_on', 'observed_on - 1')}, '{other}', '{uuid.uuid4()}' from project_observations where id = '{oid}' "
            "returning organisation_id, consent_id")
    r = psql(db, copy, check=False)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[0] == f"{ctx.org}|{consent_id}"


def test_a_withdrawn_consent_stops_new_observations_and_a_later_grant_lets_new_ones_in(db):
    c = org_context(db)
    grant(db, c.org)
    project, _ = prepared(db, c)
    assert submit(db, project=project, on="2026-06-29")[2].returncode == 0
    withdraw(db, c.org)
    refused(submit(db, project=project, on="2026-06-30")[2], "no standing calibration consent")
    grant(db, c.org, consent_text_version="2026-12", document_sha256=DOC("regrant-" + c.org))
    assert submit(db, project=project, on="2026-07-01")[2].returncode == 0


@pytest.mark.parametrize("origin", ["test", "synthetic", "unclassified"])
def test_an_observation_that_cannot_be_published_is_not_held_to_the_consent_gate_and_never_reaches_the_ledger(db, origin):
    """The deviation, stated in the migration: only a production row can ever be exported (0047), so a rehearsal needs no organisation's consent."""
    project = new_project(db)
    _, _, r = submit(db, project=project, data_origin=origin)
    assert r.returncode == 0, r.stderr
    oid = json.loads(r.stdout)["id"]
    assert stored(db, oid, "organisation_id") == "" and stored(db, oid, "consent_id") == ""
    assert review(db, oid).returncode == 0
    record_permission(db, project)
    assert not exported(db, oid)


@pytest.mark.parametrize("over,needle", [
    ({"publish_scope": None}, "publish_scope"), ({"publish_scope": "everything"}, "publish_scope"),
    ({"min_aggregate_observations": None}, "min_aggregate_observations"), ({"min_aggregate_observations": 9}, "min_aggregate_observations"),
    ({"min_aggregate_organisations": 2}, "min_aggregate_organisations"), ({"min_aggregate_organisations": None}, "min_aggregate_organisations"),
    ({"consent_text_version": None}, "consent_text_version"), ({"consent_text_version": " v1"}, "consent_text_version"),
    ({"consent_text_sha256": None}, "consent_text_sha256"), ({"consent_text_sha256": "a" * 64}, "consent_text_sha256"),
    ({"consent_text_sha256": "abc"}, "consent_text_sha256"), ({"document_sha256": None}, "document_sha256"),
    ({"document_sha256": "0" * 64}, "document_sha256"), ({"recorded_by": None}, "active owner"), ({"note": "x" * 1001}, "note"),
])
def test_a_consent_that_does_not_name_its_scope_floors_and_text_version_is_refused(db, over, needle):
    c = org_context(db)
    r = grant(db, c.org, check=False, **over)
    assert r.returncode != 0 and needle in r.stderr, r.stderr
    assert count(db, "calibration_consents", f"organisation_id = '{c.org}'") == 0


@pytest.mark.parametrize("role", ["editor", "viewer", "stranger", "malformed", "blank"])
def test_only_an_active_owner_of_the_organisation_can_record_or_withdraw_its_consent(db, role):
    c = org_context(db)
    who = {"editor": c.editor, "viewer": c.viewer, "stranger": "stranger@nowhere.example", "malformed": "not an address", "blank": ""}[role]
    r = grant(db, c.org, actor=who, check=False)
    assert r.returncode != 0 and "active owner" in r.stderr, r.stderr
    grant(db, c.org)
    r = withdraw(db, c.org, actor=who, check=False)
    assert r.returncode != 0 and "active owner" in r.stderr, r.stderr
    assert scalar(db, f"select count(*) from calibration_consents where organisation_id = '{c.org}'") == "1"


def test_a_consent_for_an_organisation_that_does_not_exist_is_refused(db):
    p = consent_payload(str(uuid.uuid4()), actor="someone@nowhere.example")
    refused(call(db, "gf_record_calibration_consent", p), "active owner")


def test_a_withdrawal_needs_a_standing_grant_and_is_a_new_row_not_an_edit(db):
    c = org_context(db)
    refused(withdraw(db, c.org, check=False), "no standing consent to withdraw")
    grant(db, c.org)
    out = result(withdraw(db, c.org))
    assert out["consent"]["kind"] == "withdrawn" and out["consent"]["consent_text_version"] == "2026-11"
    refused(withdraw(db, c.org, check=False), "no standing consent to withdraw")                # already withdrawn
    grant(db, c.org, document_sha256=DOC("again-" + c.org))                                      # a new grant after a withdrawal is a new row
    assert scalar(db, f"select string_agg(kind, ',' order by seq) from calibration_consents where organisation_id = '{c.org}'") == "granted,withdrawn,granted"


def test_a_withdrawal_row_needs_a_standing_grant_however_it_is_inserted(db):
    """The table's own trigger, not only the function: a direct insert of a withdrawal for an organisation that never consented is refused, and so is one by a
    person who is not an owner; neither leaves a tombstone or a row."""
    c = org_context(db)
    row = ("insert into calibration_consents (organisation_id, kind, publish_scope, min_aggregate_observations, min_aggregate_organisations, consent_text_version,"
           f" consent_text_sha256, document_sha256, recorded_by) values ('{c.org}', 'withdrawn', 'aggregate_residual_statistics', 10, 3, '2026-11', '{TEXT_SHA}',"
           " '%s', '%s')")
    r = as_service_role(db, row % (DOC("direct-1"), c.owner))
    refused(r, "no standing consent to withdraw")
    grant(db, c.org)
    refused(as_service_role(db, row % (DOC("direct-2"), c.editor)), "active owner")
    assert as_service_role(db, row % (DOC("direct-3"), c.owner)).returncode == 0
    refused(as_service_role(db, row % (DOC("direct-4"), c.owner)), "no standing consent to withdraw")           # already withdrawn
    assert scalar(db, f"select string_agg(kind, ',' order by seq) from calibration_consents where organisation_id = '{c.org}'") == "granted,withdrawn"


def append_only(db, table, update):
    """Neither the owner nor the service role can change, remove or empty the table. A row must exist, or an UPDATE or DELETE matches nothing and is not stopped."""
    assert int(count(db, table)) >= 1, f"{table} has no row to protect"
    for sql in (update, f"delete from {table}"):
        for runner in (psql, as_service_role):
            r = runner(db, sql, check=False)
            assert r.returncode != 0 and "append-only" in r.stderr, (runner.__name__, sql, r.stderr)
    r = psql(db, f"truncate public.{table} cascade", check=False)             # CASCADE so that a foreign key is not what stops it
    assert r.returncode != 0 and "append-only" in r.stderr, r.stderr
    r = psql(db, f"truncate public.{table}", check=False)
    assert r.returncode != 0 and ("append-only" in r.stderr or "referenced in a foreign key" in r.stderr), r.stderr
    r = as_service_role(db, f"truncate public.{table}", check=False)           # 0040 withholds TRUNCATE from the service role altogether
    assert r.returncode != 0 and ("permission denied" in r.stderr or "append-only" in r.stderr), r.stderr
    assert int(count(db, table)) >= 1


def test_the_consent_log_is_append_only(db, ctx):
    append_only(db, "calibration_consents", "update calibration_consents set kind = 'withdrawn'")
    append_only(db, "calibration_consents", "update calibration_consents set publish_scope = 'aggregate_residual_statistics'")


# =============================================================================================== D3: consent, at publication

def test_an_observation_that_clears_every_gate_is_in_the_ledger_view_and_its_publication_inputs(db, ctx):
    project, oid = eligible(db, ctx)
    assert exported(db, oid)
    row = json.loads(scalar(db, f"select to_json(i) from gf_calibration_publication_inputs() i where i.observation_hash = gf_calibration_observation_hash('{oid}')"))
    assert row == {"observation_hash": R.observation_hash(oid), "organisation_hash": R.organisation_hash(ctx.org), "min_observations": 10, "min_organisations": 3}
    assert scalar(db, f"select gf_calibration_organisation_hash('{ctx.org}')") == R.organisation_hash(ctx.org)


def test_the_floors_of_the_stricter_of_the_two_consents_ride_on_the_publication_inputs(db):
    c = org_context(db)
    grant(db, c.org, min_aggregate_observations=25, min_aggregate_organisations=4)
    _, oid = eligible(db, c)
    grant(db, c.org, min_aggregate_observations=12, min_aggregate_organisations=5, document_sha256=DOC("second-" + c.org))
    row = json.loads(scalar(db, f"select to_json(i) from gf_calibration_publication_inputs() i where i.observation_hash = '{R.observation_hash(oid)}'"))
    assert (row["min_observations"], row["min_organisations"]) == (25, 5)                       # the greater of what it was recorded under and what stands now


def test_the_view_applies_the_consent_condition_by_itself_when_the_insert_gate_is_bypassed(db):
    """A withdrawn row inserted with the row triggers OFF (so no tombstone): only the view's own consent condition can keep the observation out."""
    c = org_context(db)
    grant(db, c.org)
    _, oid = eligible(db, c)
    assert exported(db, oid)
    bypassing_triggers(db, "insert into calibration_consents (organisation_id, kind, publish_scope, min_aggregate_observations, min_aggregate_organisations,"
                           " consent_text_version, consent_text_sha256, document_sha256, recorded_by) values "
                           f"('{c.org}', 'withdrawn', 'aggregate_residual_statistics', 10, 3, '2026-11', '{TEXT_SHA}', '{DOC('bypass-' + c.org)}', '{c.owner}')")
    assert scalar(db, f"select count(*) from calibration_tombstones t where t.observation_hash = '{R.observation_hash(oid)}'") == "0"
    assert not exported(db, oid)


def test_a_row_recorded_with_the_insert_gates_off_has_no_organisation_and_is_not_listed(db, ctx):
    project, _ = prepared(db, ctx)
    ev = new_evidence(db, project, verified=True, sha="c")
    case = rig.new_case(db, created_at="2026-03-02T09:00:00Z")
    r = bypassing_triggers(db, f"select gf_submit_observation('{rig.obs_args(project, ev, case, observed_on='2026-06-30')}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)")
    oid = json.loads(r.stdout.strip().splitlines()[-1])["id"]
    assert stored(db, oid, "organisation_id") == ""
    assert review(db, oid).returncode == 0
    record_permission(db, project)
    assert not exported(db, oid)


# =============================================================================================== D1: the completion milestone

def test_a_production_observation_needs_an_attested_completion_milestone(db, ctx):
    project, _ = prepared(db, ctx, milestone=False)
    r = submit(db, project=project)[2]
    refused(r, "has not attested that it reached its completion milestone")
    assert "GF016" in psql(db, f"select gf_submit_observation('{rig.obs_args(project, new_evidence(db, project), rig.new_case(db, created_at='2026-03-02T09:00:00Z'))}'::jsonb,"
                               f" '{GOOD % 'observation_submitted'}'::jsonb)", check=False, sqlstate=True).stderr
    assert count(db, "project_observations", f"project_id = '{project}'") == 0


def test_data_from_before_the_milestone_is_not_recorded_and_the_day_itself_is(db, ctx):
    project, _ = prepared(db, ctx, reached_on="2026-06-15")
    refused(submit(db, project=project, on="2026-06-14")[2], "data from before completion is not recorded")
    assert submit(db, project=project, on="2026-06-15")[2].returncode == 0


def test_a_supplier_record_that_shows_delivery_in_flight_blocks_the_observation(db, ctx):
    project, proof = prepared(db, ctx)
    pkg, resp = reg.seed_package(db, project)
    actual = reg.seed_supplier_actual(db, project, pkg, resp, proof, po_date="2026-02-01", on_site_date="2026-04-01")      # no energised date
    refused(submit(db, project=project)[2], "delivery still in flight")
    assert count(db, "project_observations", f"project_id = '{project}'") == 0
    # the supplier's correction supersedes it with an energised date before the observed date: the project is no longer in flight
    reg.seed_supplier_actual(db, project, pkg, resp, proof, supersedes=actual, po_date="2026-02-01", on_site_date="2026-04-01", energised_date="2026-05-01")
    assert submit(db, project=project)[2].returncode == 0


def test_an_energisation_dated_after_the_observation_is_in_flight_and_a_rejected_record_is_ignored(db, ctx):
    project, proof = prepared(db, ctx)
    pkg, resp = reg.seed_package(db, project)
    late = reg.seed_supplier_actual(db, project, pkg, resp, proof, on_site_date="2026-05-01", energised_date="2026-07-15")
    refused(submit(db, project=project, on="2026-06-30")[2], "delivery still in flight")
    psql(db, f"insert into supplier_actual_reviews (actual_id, project_id, decision, verified_fields, reviewer, reason) values "
             f"('{late}', '{project}', 'rejected', '{{}}', 'r@desk.example', 'wrong hall')")
    assert submit(db, project=project, on="2026-06-30")[2].returncode == 0


def test_the_view_applies_the_milestone_condition_by_itself(db, ctx):
    """Triggers off, organisation and consent set by hand: the row is recorded for a project with no milestone, and the view keeps it out until one is attested."""
    project, proof = prepared(db, ctx, milestone=False)
    ev = new_evidence(db, project, verified=True, sha="d")
    case = rig.new_case(db, created_at="2026-03-02T09:00:00Z")
    r = bypassing_triggers(db, f"select gf_submit_observation('{rig.obs_args(project, ev, case, observed_on='2026-06-30')}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)")
    oid = json.loads(r.stdout.strip().splitlines()[-1])["id"]
    consent_id = scalar(db, f"select id from calibration_consents where organisation_id = '{ctx.org}' order by seq desc limit 1")
    bypassing_triggers(db, f"update project_observations set organisation_id = '{ctx.org}', consent_id = '{consent_id}' where id = '{oid}'")
    assert review(db, oid).returncode == 0
    record_permission(db, project)
    assert not exported(db, oid)
    attest(db, project, proof, ctx.owner)
    assert exported(db, oid)


def test_the_view_notices_delivery_in_flight_reported_after_the_observation(db, ctx):
    project, oid = eligible(db, ctx)
    assert exported(db, oid)
    pkg, resp = reg.seed_package(db, project)
    reg.seed_supplier_actual(db, project, pkg, resp, new_evidence(db, project, verified=True, sha="e"), po_date="2026-06-01")
    assert not exported(db, oid)


def test_a_milestone_is_attested_only_for_an_attached_project_by_an_editor_with_verified_evidence_for_a_date_that_has_passed(db, ctx):
    loose = new_project(db)                                              # not attached to any hall
    refused(attest(db, loose, new_evidence(db, loose, verified=True, sha="b"), ctx.owner, check=False), "attached to a hall of an organisation")
    project = new_project(db, f"Site {uuid.uuid4().hex[:8]}")
    attach(db, project, ctx.hall, ctx.owner)
    verified = new_evidence(db, project, verified=True, sha="b")
    unverified = new_evidence(db, project, verified=False, sha="c")
    elsewhere = new_evidence(db, new_project(db), verified=True, sha="d")
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
    refused(attest(db, project, unverified, ctx.owner, check=False), "must be verified by a reviewer")
    refused(attest(db, project, elsewhere, ctx.owner, check=False), "does not belong to this project")
    refused(attest(db, project, verified, ctx.owner, reached_on=tomorrow, check=False), "a plan, not a milestone")
    refused(attest(db, project, verified, ctx.viewer, check=False), "owner or editor")
    refused(attest(db, project, verified, "stranger@nowhere.example", check=False), "owner or editor")
    refused(attest(db, project, verified, ctx.owner, milestone="topped_out", check=False), "milestone")
    refused(attest(db, project, verified, ctx.owner, basis="  ", check=False), "basis")
    assert count(db, "project_completion_milestones", f"project_id = '{project}'") == 0
    assert attest(db, project, verified, ctx.editor).returncode == 0
    refused(attest(db, project, verified, ctx.owner, check=False), "project_completion_milestones")   # one attestation of a milestone, ever
    assert scalar(db, f"select count(*) from project_events where project_id = '{project}' and event_type = 'completion_milestone_attested'") == "1"


def test_the_milestone_record_is_append_only(db, ctx):
    project, _ = prepared(db, ctx)
    append_only(db, "project_completion_milestones", "update project_completion_milestones set reached_on = '2020-01-01'")
    assert count(db, "project_completion_milestones", f"project_id = '{project}'") == 1


# =============================================================================================== D5: withdrawal tombstones

def two_observations(db):
    c = org_context(db)
    grant(db, c.org)
    (_, a), (_, b) = eligible(db, c, on="2026-06-30"), eligible(db, c, on="2026-06-29")
    return c, a, b


def test_a_withdrawal_leaves_a_tombstone_per_observation_and_the_view_stops_listing_them(db):
    c, a, b = two_observations(db)
    assert exported(db, a) and exported(db, b)
    out = result(withdraw(db, c.org))
    assert out["tombstoned"] == 2 and out["snapshots_superseded"] == 0
    assert not exported(db, a) and not exported(db, b)
    rows = psql(db, "select observation_hash, withdrawal_id from calibration_tombstones order by observation_hash").stdout.split()
    assert {r.split("|")[0] for r in rows} >= {R.observation_hash(a), R.observation_hash(b)}
    assert all(r.split("|")[1] == out["consent"]["id"] for r in rows if r.split("|")[0] in {R.observation_hash(a), R.observation_hash(b)})


def test_a_tombstone_is_a_hash_a_time_and_a_withdrawal_and_nothing_else(db):
    cols = scalar(db, "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'calibration_tombstones'")
    assert cols == "observation_hash,withdrawn_at,withdrawal_id"
    c, a, _ = two_observations(db)
    withdraw(db, c.org)
    text = scalar(db, f"select t::text from calibration_tombstones t where observation_hash = '{R.observation_hash(a)}'")
    assert a not in text and c.org not in text and R.observation_hash(a) in text


def test_a_later_grant_does_not_bring_a_withdrawn_observation_back(db):
    """The resurrection the tombstone exists to stop: withdraw, then consent again. The old observation stays out (the consent condition alone would let it in)."""
    c, a, _ = two_observations(db)
    withdraw(db, c.org)
    grant(db, c.org, document_sha256=DOC("regrant-" + c.org))
    assert scalar(db, f"select count(*) from calibration_consents where organisation_id = '{c.org}' and kind = 'granted' and seq = (select max(seq) from calibration_consents where organisation_id = '{c.org}')") == "1"
    assert not exported(db, a)
    _, fresh_oid = eligible(db, c, on="2026-06-28")
    assert exported(db, fresh_oid)                                                              # an observation recorded AFTER the new grant is covered by it


def test_a_withdrawn_observation_cannot_be_recorded_again(db):
    """A re-import of an observation by its id: the trigger answers before the primary key could."""
    c, a, b = two_observations(db)
    r = psql(db, REINSERT + f"'{a}'", check=False, sqlstate=True)
    assert r.returncode != 0 and "GF017" not in r.stderr, "before the withdrawal the same insert fails only on the primary key"
    withdraw(db, c.org)
    r = psql(db, REINSERT + f"'{a}'", check=False, sqlstate=True)
    assert r.returncode != 0 and "GF017" in r.stderr, r.stderr
    r = as_service_role(db, REINSERT + f"'{b}'")
    assert r.returncode != 0 and "withdrawn with its organisation" in r.stderr, r.stderr


def test_a_withdrawal_touches_only_the_withdrawing_organisation(db):
    c1, a1, _ = two_observations(db)
    c2, a2, _ = two_observations(db)
    withdraw(db, c1.org)
    assert not exported(db, a1) and exported(db, a2)


def test_the_effects_of_a_withdrawal_follow_a_withdrawal_row_however_it_was_inserted(db):
    """The tombstoning is a trigger on the consent row, not a step of gf_withdraw_calibration_consent: a direct insert by an owner does it too."""
    c, a, b = two_observations(db)
    r = as_service_role(db, "insert into calibration_consents (organisation_id, kind, publish_scope, min_aggregate_observations, min_aggregate_organisations,"
                            " consent_text_version, consent_text_sha256, document_sha256, recorded_by) values "
                            f"('{c.org}', 'withdrawn', 'aggregate_residual_statistics', 10, 3, '2026-11', '{TEXT_SHA}', '{DOC('direct-' + c.org)}', '{c.owner}')")
    assert r.returncode == 0, r.stderr
    assert scalar(db, f"select count(*) from calibration_tombstones where observation_hash in ('{R.observation_hash(a)}', '{R.observation_hash(b)}')") == "2"
    assert not exported(db, a)


def snapshot_with(org_hash_members, others=9, at="2026-09-01T00:00:00Z", figures=None):
    """A snapshot whose members are the given (observation hash, organisation hash) pairs plus `others` observations of three other organisations."""
    members = [R.Contribution(o, g) for o, g in org_hash_members]
    members += [R.Contribution.from_ids(f"filler-{uuid.uuid4().hex}", f"filler-org-{k % 3}-{org_hash_members[0][1][:6]}") for k in range(others)]
    return R.Snapshot.make({"total": members}, released_at=datetime.fromisoformat(at.replace("Z", "+00:00")), figures=figures or {"n": len(members)})


def register(db, snapshot, check=False):
    return call(db, "gf_record_release_snapshot", snapshot.to_record(), check=check)


def test_a_withdrawal_marks_the_snapshots_that_contained_the_organisation_superseded_and_never_edits_them(fresh):
    c = org_context(fresh)
    grant(fresh, c.org)
    _, a = eligible(fresh, c)
    org_h = R.organisation_hash(c.org)
    mine = snapshot_with([(R.observation_hash(a), org_h)] + [(R.observation_hash(uuid.uuid4().hex), org_h) for _ in range(3)])
    other = snapshot_with([(R.observation_hash("x"), R.organisation_hash("some-other-org"))] + [(R.observation_hash(f"x{i}"), R.organisation_hash("some-other-org")) for i in range(2)],
                          at="2026-04-01T00:00:00Z")
    assert register(fresh, other).returncode == 0 and register(fresh, mine).returncode == 0
    before = psql(fresh, "select snapshot_id, members::text, cells::text, figures_sha256, released_at from calibration_release_snapshots order by seq").stdout
    out = result(withdraw(fresh, c.org))
    assert out["snapshots_superseded"] == 1
    assert psql(fresh, "select snapshot_id, members::text, cells::text, figures_sha256, released_at from calibration_release_snapshots order by seq").stdout == before
    notes = psql(fresh, "select snapshot_id, withdrawal_id from calibration_snapshot_supersessions").stdout.strip()
    assert notes == f"{mine.snapshot_id}|{out['consent']['id']}"                                  # the one that contained the organisation, and not the other
    assert R.Snapshot.from_record(json.loads(scalar(fresh, f"select to_json(s) from calibration_release_snapshots s where snapshot_id = '{mine.snapshot_id}'"))).snapshot_id == mine.snapshot_id


def test_the_tombstones_supersessions_and_snapshots_are_append_only_and_read_by_the_service_role_only(fresh):
    c = org_context(fresh)
    grant(fresh, c.org)
    _, a = eligible(fresh, c)
    mine = snapshot_with([(R.observation_hash(a), R.organisation_hash(c.org))] + [(R.observation_hash(uuid.uuid4().hex), R.organisation_hash(c.org)) for _ in range(3)])
    assert register(fresh, mine).returncode == 0
    withdraw(fresh, c.org)
    updates = {"calibration_tombstones": "update calibration_tombstones set withdrawn_at = now()",
               "calibration_snapshot_supersessions": "update calibration_snapshot_supersessions set reason = 'edited'",
               "calibration_release_snapshots": "update calibration_release_snapshots set figures_sha256 = figures_sha256"}
    for table, update in updates.items():
        append_only(fresh, table, update)
        assert "permission denied" in as_anon(fresh, f"select count(*) from {table}", check=False).stderr


def test_a_second_withdrawal_supersedes_a_snapshot_again_under_its_own_withdrawal(fresh):
    c = org_context(fresh)
    grant(fresh, c.org)
    _, a = eligible(fresh, c)
    snap = snapshot_with([(R.observation_hash(a), R.organisation_hash(c.org))] + [(R.observation_hash(uuid.uuid4().hex), R.organisation_hash(c.org)) for _ in range(3)])
    assert register(fresh, snap).returncode == 0
    withdraw(fresh, c.org)
    grant(fresh, c.org, document_sha256=DOC("g2-" + c.org))
    withdraw(fresh, c.org)
    assert scalar(fresh, f"select count(*) from calibration_snapshot_supersessions where snapshot_id = '{snap.snapshot_id}'") == "2"


# =============================================================================================== R4: the snapshot registry

def members(start, n, orgs):
    return [R.Contribution.from_ids(f"obs-{start + k}", f"org-{orgs[k % len(orgs)]}") for k in range(n)]


def snap(obs, at, figures=None):
    return R.Snapshot.make({"total": obs}, released_at=datetime.fromisoformat(at), figures=figures or {"n": len(obs)})


def test_the_database_holds_the_numbers_the_pure_policy_holds(db):
    assert json.loads(scalar(db, "select gf_calibration_release_policy()")) == R.policy()


def test_the_first_snapshot_must_be_a_safe_group_by_itself(fresh):
    for obs in (members(0, 9, [1, 2, 3]), members(0, 12, [1, 2]), members(0, 12, [1] * 6 + [2, 3, 4, 5, 6, 7])):
        r = register(fresh, snap(obs, "2026-01-01T00:00:00+00:00"))
        assert r.returncode != 0 and "at least 10 observations from at least 3 organisations" in r.stderr, (len(obs), r.stderr)
    assert count(fresh, "calibration_release_snapshots") == 0
    assert register(fresh, snap(members(0, 12, [1, 2, 3, 4]), "2026-01-01T00:00:00+00:00")).returncode == 0


@pytest.mark.parametrize("added,orgs,days,ok", [
    (1, [9], 40, False), (9, [9, 10, 11], 40, False), (10, [9, 10, 11], 40, True), (10, [9, 10], 40, False), (10, [9, 10, 11], 29, False), (10, [9, 10, 11], 30, True),
])
def test_a_snapshot_must_differ_from_the_last_by_a_safe_group_and_follow_it_by_the_cadence(fresh, added, orgs, days, ok):
    first = members(0, 12, [1, 2, 3, 4])
    assert register(fresh, snap(first, "2026-01-01T00:00:00+00:00")).returncode == 0
    nxt = snap(first + members(100, added, orgs), (datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=days)).isoformat())
    r = register(fresh, nxt)
    assert (r.returncode == 0) is ok, r.stderr
    if not ok:
        assert "GF018" in psql(fresh, f"select gf_record_release_snapshot('{json.dumps(nxt.to_record())}'::jsonb)", check=False, sqlstate=True).stderr


def test_a_snapshot_is_compared_with_every_earlier_one_and_an_identical_membership_is_not_a_new_release(fresh):
    base = members(0, 12, [1, 2, 3, 4])
    twenty = members(100, 20, [5, 6, 7, 8])
    assert register(fresh, snap(base, "2026-01-01T00:00:00+00:00")).returncode == 0
    assert register(fresh, snap(base + twenty, "2026-03-01T00:00:00+00:00")).returncode == 0
    r = register(fresh, snap(base + twenty[:1], "2026-05-01T00:00:00+00:00"))        # nineteen away from the last, ONE away from the first
    assert r.returncode != 0 and "differ from every earlier release" in r.stderr
    again = register(fresh, snap(base + twenty, "2026-07-01T00:00:00+00:00", figures={"n": "again"}))
    assert again.returncode != 0 and "differ from every earlier release" in again.stderr


def test_a_snapshot_with_a_withdrawn_observation_is_refused_before_any_other_check(fresh):
    c = org_context(fresh)
    grant(fresh, c.org)
    _, a = eligible(fresh, c)
    withdraw(fresh, c.org)
    obs = members(0, 11, [1, 2, 3]) + [R.Contribution(R.observation_hash(a), R.organisation_hash(c.org))]
    r = register(fresh, snap(obs, "2026-01-01T00:00:00+00:00"))
    assert r.returncode != 0 and "withdrew its consent" in r.stderr
    assert "GF017" in psql(fresh, f"select gf_record_release_snapshot('{json.dumps(snap(obs, '2026-01-01T00:00:00+00:00').to_record())}'::jsonb)", check=False, sqlstate=True).stderr


@pytest.mark.parametrize("mutate,needle", [
    (lambda r: r["members"].__setitem__("zz", "a" * 64), "64 lowercase hex"),
    (lambda r: r["members"].__setitem__(next(iter(r["members"])), "short"), "64 lowercase hex"),
    (lambda r: r["cells"].__setitem__("total", {"a": 1}), "list of observation hashes"),
    (lambda r: r["cells"]["total"].append("f" * 64), "not among the snapshot"),
    (lambda r: r.__setitem__("released_at", "2999-01-01T00:00:00Z"), "in the future"),
    (lambda r: r.__setitem__("cells", {}), "cells"),
    (lambda r: r.__setitem__("snapshot_id", "xyz"), "snapshot_id"),
    (lambda r: r.__setitem__("figures_sha256", "xyz"), "figures_sha256"),
])
def test_a_malformed_snapshot_record_is_refused(fresh, mutate, needle):
    rec = snap(members(0, 12, [1, 2, 3, 4]), "2026-01-01T00:00:00+00:00").to_record()
    mutate(rec)
    r = call(fresh, "gf_record_release_snapshot", rec)
    assert r.returncode != 0 and needle in r.stderr, r.stderr
    assert count(fresh, "calibration_release_snapshots") == 0


def test_a_snapshot_the_pure_policy_allows_is_one_the_database_registers(fresh):
    """The two halves agree on a run of releases: whatever propose_release releases, the registry accepts."""
    history, now = [], datetime(2026, 1, 1, tzinfo=timezone.utc)
    pool = members(0, 12, [1, 2, 3, 4])
    for month in range(5):
        p = R.propose_release({"total": pool}, history=history, now=now, figures_for=lambda names: {"n": len(pool)})
        assert p.decision.allowed, (month, p.decision)
        assert register(fresh, p.snapshot).returncode == 0, month
        history.append(p.snapshot)
        pool = pool + members(1000 * (month + 1), 10, [5 + month, 6 + month, 7 + month])
        now += timedelta(days=31)
    assert count(fresh, "calibration_release_snapshots") == 5


# =============================================================================================== privileges, existing rows, replay

def test_the_new_functions_and_tables_are_for_the_service_role_alone(db, ctx):
    c = org_context(db)
    for role_runner in (as_anon, lambda d, s, check=False: psql(d, "set role authenticated; " + s, check=check)):
        for sql in (f"select public.gf_record_calibration_consent('{json.dumps(consent_payload(c.org))}'::jsonb)",
                    f"select public.gf_withdraw_calibration_consent('{json.dumps({'organisation_id': c.org})}'::jsonb)",
                    "select public.gf_record_release_snapshot('{}'::jsonb)",
                    "select * from calibration_consents", "select * from calibration_tombstones", "select * from project_completion_milestones",
                    "select * from calibration_release_snapshots", "select * from gf_calibration_publication_inputs()",
                    "insert into calibration_consents (organisation_id) values (gen_random_uuid())"):
            r = role_runner(db, sql, check=False)
            assert r.returncode != 0 and "permission denied" in r.stderr, (sql, r.stderr)


def test_the_new_tables_have_row_level_security_and_no_policies(db):
    for table in ("calibration_consents", "calibration_release_snapshots", "calibration_tombstones", "calibration_snapshot_supersessions", "project_completion_milestones"):
        assert scalar(db, f"select relrowsecurity::text from pg_class where oid = 'public.{table}'::regclass") == "true", table
        assert scalar(db, f"select count(*) from pg_policies where tablename = '{table}'") == "0", table


def test_applying_0056_to_a_database_that_already_has_rows_changes_none_of_them_and_lists_none_of_the_old_ones(monkeypatch):
    monkeypatch.setattr(rig, "UPTO", "0055")
    name = make_database()
    try:
        project, ev, r = submit(name)
        assert r.returncode == 0, r.stderr
        oid = json.loads(r.stdout)["id"]
        assert review(name, oid).returncode == 0
        record_permission(name, project)
        assert exported(name, oid), "under the chain before 0056 this observation reaches the ledger view"
        before = {t: scalar(name, f"select md5(string_agg(x::text, ',' order by x::text)) from {t} x")
                  for t in ("project_observations", "project_observation_reviews", "calibration_permissions", "project_evidence")}
        assert scalar(name, "select to_regclass('public.calibration_consents') is null") == "t"
        psql(name, file=next(MIGRATIONS.glob("0056_*.sql")))
        assert {t: scalar(name, f"select md5(string_agg(x::text, ',' order by x::text)) from {t} x")
                for t in before if t != "project_observations"} == {t: v for t, v in before.items() if t != "project_observations"}
        assert scalar(name, f"select organisation_id is null and consent_id is null from project_observations where id = '{oid}'") == "t"
        assert scalar(name, "select count(*) from project_observations") == "1"
        assert not exported(name, oid), "an observation with no organisation and no consent is not in the ledger view, and nothing was invented for it"
        again = {t: scalar(name, f"select count(*) from {t}") for t in ("project_observations", "calibration_permissions")}
        psql(name, file=next(MIGRATIONS.glob("0056_*.sql")))                                  # idempotent: a second run changes nothing
        assert {t: scalar(name, f"select count(*) from {t}") for t in again} == again
    finally:
        drop_database(name)


def test_nothing_depends_on_the_ledger_view_so_it_can_be_dropped_and_rebuilt(fresh):
    """A view built on calibration_ledger_rows would make `drop view` fail (test_site_origin_gate drops it to replay an older definition)."""
    psql(fresh, "drop view public.calibration_ledger_rows")
    psql(fresh, file=next(MIGRATIONS.glob("0056_*.sql")))
    assert scalar(fresh, "select count(*) from calibration_ledger_rows") == "0"
    assert scalar(fresh, "select count(*) from gf_calibration_publication_inputs()") == "0"


def test_the_migration_is_marked_written_not_applied_and_says_where_the_final_view_lives():
    text = next(MIGRATIONS.glob("0056_*.sql")).read_text()
    assert "WRITTEN, NOT APPLIED" in text[:2500] and "REPLAY ORDER" in text
    for gate in ("D1", "D3", "D5", "R4"):
        assert gate in text
