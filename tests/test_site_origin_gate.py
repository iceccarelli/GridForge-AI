"""0052: an observation of a project sitting in a test or synthetic site is not eligible for the calibration ledger.

Real PostgreSQL, the whole chain (0001..0056). Every case starts from an observation that IS exported (the control: a reviewer who is not the
submitter, a verified file with a decision on record, a frozen forecast made before the outcome, production origin, a standing permission and, from
0056 on, the organisation's consent and the project's attested completion milestone) and changes ONLY where its project sits in the site registry
(0049/0050). Everything is a SYNTHETIC fixture.

  attached to a production site                     -> exported (unchanged)
  attached to a test site                           -> not exported
  attached to a synthetic site                      -> not exported
  attached to a test site, then detached            -> still NOT exported (detaching does not turn a rehearsal into ledger data)
  never attached                                    -> CANNOT BE RECORDED AS PRODUCTION any more (0056: no hall, no organisation, no consent that could
                                                       cover it; GF015). Before 0056 this case was "exported, unchanged". Its premise is gone; its
                                                       intent (0052's condition is not what decides it) is kept by showing the insert is refused
  recorded in a production site, project moved to a test site later -> still gated (the view, not an insert-time check, carries the gate: 0056
                                                       derives the organisation from the project's site WHATEVER the site's origin)

Under 0056 a production observation needs a project that is already in a hall of an organisation when the row is recorded, so each fixture attaches the
project FIRST (the registry's own halls, one per origin) and then submits through the rig, whose `satisfy_publication_gates` finds that organisation and
records its consent and the project's completion milestone.
"""
import re
import uuid

import pytest

from calibration_pg_rig import (
    MIGRATIONS, drop_database, export_rows, make_database, new_project, psql, record_permission, review, scalar, skip_without_db, submit, submitted,
)
from registry_pg import add_member, new_hall, new_org, new_site, ok

pytestmark = skip_without_db


@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


class Registry:
    def __init__(self, db):
        self.db = db
        self.owner = f"owner-{uuid.uuid4().hex[:8]}@a.example"
        self.editor = f"editor-{uuid.uuid4().hex[:8]}@a.example"
        self.org = new_org(db, self.owner)
        add_member(db, self.org, self.owner, self.editor, "editor")
        self.halls = {origin: new_hall(db, self.owner, new_site(db, self.owner, self.org, origin=origin)) for origin in ("production", "test", "synthetic")}

    def exported_observation(self, attach="production"):
        """An observation that clears every gate with its project in a hall of a site of origin `attach`. The project is attached FIRST (0056 derives
        the organisation from the hall the project is in when the row is recorded); the rig then records the organisation's consent and the project's
        completion milestone and submits. Returns (observation id, project id)."""
        project = new_project(self.db)
        self.attach(project, attach)
        _, _, obs = submitted(self.db, project=project)
        # the organisation is the registry's own whatever the origin of the site, so what is left to keep a row out of the view is where the project sits
        assert scalar(self.db, f"select organisation_id from project_observations where id = '{obs['id']}'") == self.org
        assert review(self.db, obs["id"]).returncode == 0
        record_permission(self.db, project)
        return obs["id"], project

    def attach(self, project, origin):
        token = scalar(self.db, f"select project_token from projects where id = '{project}'")
        return ok(self.db, "gf_attach_project_to_hall", p_actor=self.editor, p_hall=self.halls[origin], p_project_token=token)

    def detach(self, project, origin):
        return ok(self.db, "gf_detach_project_from_hall", p_actor=self.owner, p_hall=self.halls[origin], p_project=project)

    def exported(self, oid):
        return [r["id"] for r in export_rows(self.db, f"id = '{oid}'")] == [oid]


@pytest.fixture(scope="module")
def reg(db):
    return Registry(db)


def test_a_project_never_attached_to_a_hall_can_no_longer_have_a_production_observation(reg):
    """Before 0056 this was 'exported as before'. A production observation now needs an organisation, which is the one the project's hall belongs to, so a
    project that was never attached has none: the insert is refused (GF015) and there is nothing to export. 0052's condition is not what stops it (the
    project sits in no site at all), which was always this case's point."""
    project = new_project(reg.db)
    r = submit(reg.db, project=project, gates=False)[2]
    assert r.returncode != 0 and "attached to a hall of an organisation" in r.stderr, r.stderr
    assert scalar(reg.db, f"select count(*) from project_observations where project_id = '{project}'") == "0"
    assert scalar(reg.db, f"select count(*) from hall_project_attachments where project_id = '{project}'") == "0"


def test_a_project_in_a_production_site_is_exported(reg):
    oid, _ = reg.exported_observation(attach="production")
    assert reg.exported(oid)


@pytest.mark.parametrize("origin", ["test", "synthetic"])
def test_a_project_in_a_test_or_synthetic_site_is_not_exported_although_its_observation_says_production(reg, origin):
    oid, project = reg.exported_observation(attach=origin)
    assert scalar(reg.db, f"select data_origin from project_observations where id = '{oid}'") == "production"      # the observation's own claim
    # every file of the project is verified (the observation's own and, since 0056, the one that backs the completion milestone): no file gate is what keeps it out
    assert scalar(reg.db, f"select string_agg(distinct review_status, ',') from project_evidence where project_id = '{project}'") == "verified"
    assert not reg.exported(oid)
    assert export_rows(reg.db, f"id = '{oid}'") == []


@pytest.mark.parametrize("origin", ["test", "synthetic"])
def test_detached_from_a_non_production_site_the_observation_stays_out(reg, origin):
    oid, project = reg.exported_observation(attach=origin)
    assert not reg.exported(oid)
    reg.detach(project, origin)
    assert not reg.exported(oid)
    # the history stays: the attachment and its detachment are both still recorded
    assert scalar(reg.db, f"select count(*) from hall_project_attachments a join hall_project_detachments d on d.attachment_id = a.id where a.project_id = '{project}'") == "1"


def test_an_observation_stored_before_its_project_was_moved_to_a_test_site_is_gated_once_it_is(reg):
    """The row was recorded (and exported) while its project sat in a production hall; moving the project to a test hall afterwards takes it out. The view,
    not an insert-time check, carries this gate: 0056's insert gate derives the organisation from the hall whatever the site's origin, and a row already
    stored is not looked at again at insert."""
    oid, project = reg.exported_observation()
    assert reg.exported(oid)
    reg.detach(project, "production")
    assert reg.exported(oid)                       # detaching from a production site leaves it where it was
    reg.attach(project, "test")
    assert not reg.exported(oid)


def test_a_later_production_attachment_does_not_undo_an_earlier_test_one(reg):
    oid, project = reg.exported_observation(attach="test")
    reg.detach(project, "test")
    assert not reg.exported(oid)
    reg.attach(project, "production")
    assert not reg.exported(oid), "a later production attachment must not undo an earlier test one"
    reg.detach(project, "production")
    reg.attach(project, "synthetic")
    assert not reg.exported(oid)


def test_another_projects_attachment_does_not_gate_this_projects_observation(reg):
    oid, _ = reg.exported_observation(attach="production")
    other, _ = reg.exported_observation(attach="test")
    assert reg.exported(oid) and not reg.exported(other)


def test_every_other_gate_still_applies_to_a_project_in_a_production_site(reg):
    """The added condition narrows the view; it does not replace a gate. A permission revoked after the fact still removes the row."""
    oid, project = reg.exported_observation(attach="production")
    assert reg.exported(oid)
    record_permission(reg.db, project, kind="revoked", doc="1" * 63 + "2")
    assert not reg.exported(oid)


def test_the_view_is_the_0048_view_plus_exactly_one_condition_with_the_same_columns_and_privileges():
    before = make_database()                      # through the whole chain, then rebuilt: the 0048 text is read from a chain that stops at 0051
    try:
        psql(before, "drop view public.calibration_ledger_rows")
        psql(before, file=next(MIGRATIONS.glob("0048_*.sql")))
        old = scalar(before, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
        old_cols = scalar(before, "select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_name = 'calibration_ledger_rows'")
        old_acl = scalar(before, "select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_name = 'calibration_ledger_rows'")
        psql(before, file=next(MIGRATIONS.glob("0052_*.sql")))
        new = scalar(before, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
        new_cols = scalar(before, "select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_name = 'calibration_ledger_rows'")
        new_acl = scalar(before, "select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants where table_name = 'calibration_ledger_rows'")
        assert (new_cols, new_acl) == (old_cols, old_acl) and "service_role:SELECT" in new_acl and "anon" not in new_acl
        # after the old definition's last condition comes the new block, and nothing before it changed
        added = new.replace(old.rstrip(";"), "", 1) if new.startswith(old.rstrip(";")) else None
        assert added is not None, "the 0052 view must begin with 0048's definition, unchanged"
        flat = " ".join(added.split())
        assert re.fullmatch(r"AND \(?NOT \(?EXISTS \(\s*SELECT 1 FROM hall_project_attachments hpa JOIN sites st ON st\.id = hpa\.site_id WHERE hpa\.project_id = o\.project_id AND st\.data_origin <> 'production'::text\)\)?;?", flat), flat
    finally:
        drop_database(before)


def test_replaying_0052_is_harmless(reg):
    """0052 is idempotent: replayed twice it leaves the view exactly as one replay does, and the same rows are in and out. What changed with 0056 is that
    0052 no longer holds the FINAL view: run after the whole chain it puts back a definition without 0056's consent, milestone and tombstone conditions
    (tests/test_calibration_final_gate.py shows that being reported), so the replay is followed by 0056, as the headers of both say, and the final view is
    then what it was before."""
    oid, _ = reg.exported_observation(attach="production")
    blocked, _ = reg.exported_observation(attach="test")
    view = "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)"
    before = scalar(reg.db, view)
    try:
        psql(reg.db, file=next(MIGRATIONS.glob("0052_*.sql")))
        once = scalar(reg.db, view)
        psql(reg.db, file=next(MIGRATIONS.glob("0052_*.sql")))
        assert scalar(reg.db, view) == once
        assert reg.exported(oid) and not reg.exported(blocked)
    finally:
        psql(reg.db, file=next(MIGRATIONS.glob("0056_*.sql")))
    assert scalar(reg.db, view) == before
    assert reg.exported(oid) and not reg.exported(blocked)


def test_0052_passes_the_sanctioned_appliers_destructive_gate_and_says_it_is_not_applied():
    import importlib.util

    from calibration_pg_rig import ROOT
    spec = importlib.util.spec_from_file_location("apply_migration", ROOT / "scripts" / "apply-migration.py")
    applier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(applier)
    f = next(MIGRATIONS.glob("0052_*.sql"))
    assert applier.destructive_statements(f.read_text()) == []
    assert "WRITTEN, NOT APPLIED" in f.read_text()[:2500] and "REPLAY ORDER" in f.read_text()
    assert len(list(MIGRATIONS.glob("0052_*.sql"))) == 1
