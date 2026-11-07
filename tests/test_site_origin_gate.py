"""0052: an observation of a project sitting in a test or synthetic site is not eligible for the calibration ledger.

Real PostgreSQL, the whole chain (0001..0052). Every case starts from an observation that IS exported (the control: a reviewer who is not the
submitter, a verified file with a decision on record, a frozen forecast made before the outcome, production origin, a standing permission) and
changes ONLY where its project sits in the site registry (0049/0050). Everything is a SYNTHETIC fixture.

  attached to a production site                     -> exported (unchanged)
  attached to a test site                           -> not exported
  attached to a synthetic site                      -> not exported
  attached to a test site, then detached            -> exported again (the gate follows the registry's current state)
  never attached                                    -> exported (unchanged: every project that exists today)
  observation stored before the project was attached -> still gated (the view, not an insert-time check, carries the gate)
"""
import re
import uuid

import pytest

from calibration_pg_rig import MIGRATIONS, drop_database, export_rows, make_database, psql, record_permission, review, scalar, skip_without_db, submitted
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

    def exported_observation(self, attach=None):
        """An observation that is exported; with `attach` (an origin) its project is first put in a hall of a site of that origin. Returns
        (observation id, project id)."""
        project, _, obs = submitted(self.db)
        if attach:
            self.attach(project, attach)
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


def test_a_project_never_attached_to_a_hall_is_exported_as_before(reg):
    oid, project = reg.exported_observation()
    assert reg.exported(oid)
    assert scalar(reg.db, f"select count(*) from hall_project_attachments where project_id = '{project}'") == "0"


def test_a_project_in_a_production_site_is_exported(reg):
    oid, _ = reg.exported_observation(attach="production")
    assert reg.exported(oid)


@pytest.mark.parametrize("origin", ["test", "synthetic"])
def test_a_project_in_a_test_or_synthetic_site_is_not_exported_although_its_observation_says_production(reg, origin):
    oid, project = reg.exported_observation(attach=origin)
    assert scalar(reg.db, f"select data_origin from project_observations where id = '{oid}'") == "production"      # the observation's own claim
    assert scalar(reg.db, f"select review_status from project_evidence where project_id = '{project}'") == "verified"
    assert not reg.exported(oid)
    assert export_rows(reg.db, f"id = '{oid}'") == []


@pytest.mark.parametrize("origin", ["test", "synthetic"])
def test_detached_from_a_non_production_site_the_observation_is_exported_again(reg, origin):
    oid, project = reg.exported_observation(attach=origin)
    assert not reg.exported(oid)
    reg.detach(project, origin)
    assert reg.exported(oid)
    # the history stays: the attachment and its detachment are both still recorded
    assert scalar(reg.db, f"select count(*) from hall_project_attachments a join hall_project_detachments d on d.attachment_id = a.id where a.project_id = '{project}'") == "1"


def test_an_observation_stored_before_its_project_was_attached_is_gated_once_it_is(reg):
    oid, project = reg.exported_observation()
    assert reg.exported(oid)
    reg.attach(project, "test")
    assert not reg.exported(oid)


def test_the_gate_follows_the_project_through_a_second_attachment(reg):
    oid, project = reg.exported_observation(attach="test")
    reg.detach(project, "test")
    assert reg.exported(oid)
    reg.attach(project, "production")
    assert reg.exported(oid)
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
        assert re.fullmatch(r"AND \(?NOT \(?EXISTS \(\s*SELECT 1 FROM hall_project_attachments hpa JOIN sites st ON st\.id = hpa\.site_id WHERE hpa\.project_id = o\.project_id AND st\.data_origin <> 'production'::text AND \(?NOT \(?EXISTS \(\s*SELECT 1 FROM hall_project_detachments hpd WHERE hpd\.attachment_id = hpa\.id\)\)?\)?\)\)?;?", flat), flat
    finally:
        drop_database(before)


def test_replaying_0052_is_harmless(reg):
    oid, _ = reg.exported_observation(attach="production")
    blocked, _ = reg.exported_observation(attach="test")
    before = scalar(reg.db, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
    psql(reg.db, file=next(MIGRATIONS.glob("0052_*.sql")))
    psql(reg.db, file=next(MIGRATIONS.glob("0052_*.sql")))
    assert scalar(reg.db, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)") == before
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
