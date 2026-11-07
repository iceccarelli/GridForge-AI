"""0050_hall_inputs.sql against a real PostgreSQL: the append-only record of what is claimed about a hall, and where each claim comes from.

Each test is a way a figure could be dressed up as something it is not: a declared number filed as a measurement with nothing behind
it, a modelled one claiming field validation, a "missing" input with a value, a correction that rewrites history or forks it or lands
on another hall's field, evidence borrowed from a project that is not this hall's, a viewer or a stranger recording a figure, a
project attached to two halls. The checks are the database's own: raw INSERTs are attacked as well as the function.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none.
"""
import json
import re
import uuid

import pytest
from registry_pg import (add_member, call, drop_database, make_database, needs_db, new_hall, new_org, new_site, ok, psql, q,
                         reason, refused, refused_either, review_evidence, scalar, seed_evidence, seed_intake_file, seed_project)

pytestmark = needs_db


@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


class World:
    """Organisation A (owner, editor, viewer; a site with a hall and a second hall) and organisation B (its own owner, site and hall)."""

    def __init__(self, db):
        tag = uuid.uuid4().hex[:8]
        self.db = db
        self.owner, self.editor, self.viewer = (f"{r}-{tag}@a.example" for r in ("owner", "editor", "viewer"))
        self.other = f"other-{tag}@b.example"
        self.org = new_org(db, self.owner)
        add_member(db, self.org, self.owner, self.editor, "editor")
        add_member(db, self.org, self.owner, self.viewer, "viewer")
        self.site = new_site(db, self.owner, self.org)
        self.hall = new_hall(db, self.owner, self.site)
        self.hall2 = new_hall(db, self.owner, self.site)
        self.org_b = new_org(db, self.other)
        self.site_b = new_site(db, self.other, self.org_b)
        self.hall_b = new_hall(db, self.other, self.site_b)

    # --- fixtures other migrations own are built through registry_pg's seed_* functions (one place to change)
    def project(self, attach_to=None, actor=None):
        pid, token = seed_project(self.db)
        if attach_to:
            ok(self.db, "gf_attach_project_to_hall", p_actor=actor or self.editor, p_hall=attach_to, p_project_token=token)
        return pid, token

    def evidence(self, project_id, review="verified"):
        return seed_evidence(self.db, project_id, review)

    def intake_file(self, buyer_email):
        return seed_intake_file(self.db, buyer_email)

    def sourced(self, hall=None, review="verified"):
        """A project evidence file that really belongs to a project attached to `hall` (default: the first hall)."""
        pid, _ = self.project(attach_to=hall or self.hall)
        return self.evidence(pid, review)

    def record(self, *, actor=None, hall=None, path="grid.firm_capacity_mva", value=40, unit="MVA", cls="E1", origin="assumed",
               pe=None, intake=None, as_of="2026-01-15", supersedes=None):
        return call(self.db, "gf_record_hall_input", p_actor=actor or self.editor, p_hall=hall or self.hall, p_field_path=path,
                    p_value=value if value is None or isinstance(value, (dict, list)) else value, p_unit=unit, p_evidence_class=cls,
                    p_origin=origin, p_project_evidence=pe, p_intake_evidence=intake, p_as_of=as_of, p_supersedes=supersedes)


@pytest.fixture()
def w(db):
    return World(db)


def raw_insert(w, *, hall=None, path="grid.firm_capacity_mva", value="'40'::jsonb", unit="'MVA'", cls="E1", origin="assumed", pe="null",
               intake="null", as_of="'2026-01-15'", by=None, supersedes="null"):
    return ("insert into hall_inputs (hall_id, field_path, value, unit, evidence_class, origin, project_evidence_id, intake_evidence_file_id, "
            f"as_of, recorded_by, supersedes_id) values ('{hall or w.hall}', '{path}', {value}, {unit}, '{cls}', '{origin}', {pe}, {intake}, "
            f"{as_of}, '{by or w.editor}', {supersedes})")


# ---------------------------------------------------------------------------------------------------------- the happy path

def test_a_sourced_measurement_is_recorded_exactly_as_given(w):
    ev = w.sourced()
    r = w.record(origin="measured", cls="E5", value=41.5, unit="MVA", pe=ev)
    assert r["ok"] is True
    row = scalar(w.db, f"select origin || '|' || evidence_class || '|' || value::text || '|' || unit || '|' || as_of || '|' || recorded_by || '|' || "
                       f"project_evidence_id from hall_inputs where id = '{r['id']}'")
    assert row == f"measured|E5|41.5|MVA|2026-01-15|{w.editor}|{ev}"


def test_the_recorder_is_stored_lower_cased_and_is_the_acting_address(w):
    r = w.record(actor=f"  {w.owner.upper()} ")
    assert scalar(w.db, f"select recorded_by from hall_inputs where id = '{r['id']}'") == w.owner


# ---------------------------------------------------------------------------------------------------------- origin and source

@pytest.mark.parametrize("origin", ["measured", "observed", "quotation"])
def test_a_measured_observed_or_quoted_figure_needs_a_source(w, origin):
    r = w.record(origin=origin, cls="E5")
    assert r["ok"] is False and r["reason"] == "invalid_input" and r["constraint"] == "hall_inputs_origin_source"
    refused(w.db, raw_insert(w, origin=origin, cls="E5"), "hall_inputs_origin_source")
    ev = w.sourced()
    assert w.record(origin=origin, cls="E5", pe=ev, path="grid.contracted_mw", unit="MW")["ok"] is True


@pytest.mark.parametrize("origin", ["vendor", "assumed", "modelled"])
def test_a_vendor_assumed_or_modelled_figure_may_stand_without_a_file(w, origin):
    assert w.record(origin=origin, cls="E1")["ok"] is True


def test_a_figure_can_cite_a_project_file_or_a_purchased_intake_file_but_never_both(w):
    ev = w.sourced()
    intake = w.intake_file(w.editor)
    assert w.record(origin="quotation", cls="E5", pe=ev, path="grid.contracted_mw", unit="MW")["ok"]
    assert w.record(origin="observed", cls="E3", intake=intake, path="hall.floor_loading_kpa", unit="kPa")["ok"]
    r = w.record(origin="measured", cls="E5", pe=ev, intake=intake, path="hall.clear_height_m", unit="m")
    assert r["ok"] is False and r["constraint"] == "hall_inputs_one_source"
    refused(w.db, raw_insert(w, origin="measured", cls="E5", pe=f"'{ev}'", intake=f"'{intake}'"), "hall_inputs_one_source")


def test_a_source_that_does_not_exist_is_refused(w):
    refused(w.db, raw_insert(w, origin="measured", cls="E5", pe=f"'{uuid.uuid4()}'"), "violates foreign key")
    refused(w.db, raw_insert(w, origin="measured", cls="E5", intake=f"'{uuid.uuid4()}'"), "violates foreign key")


def test_a_project_file_counts_only_if_its_project_belongs_to_this_hall(w):
    other_project, _ = w.project(attach_to=w.hall2)                 # attached to the SECOND hall of the same site
    loose_project, _ = w.project()                                  # attached to nothing
    foreign_project, _ = w.project(attach_to=w.hall_b, actor=w.other)
    for pid in (other_project, loose_project, foreign_project):
        ev = w.evidence(pid)
        r = w.record(origin="measured", cls="E5", pe=ev)
        assert r["ok"] is False and r["reason"] == "invalid_reference" and r["constraint"] == "hall_inputs_source_not_in_hall", r
        refused(w.db, raw_insert(w, origin="measured", cls="E5", pe=f"'{ev}'"), "hall_inputs_source_not_in_hall")


def test_a_rejected_file_is_not_a_source(w):
    pid, _ = w.project(attach_to=w.hall)
    ev = w.evidence(pid, review="rejected")
    r = w.record(origin="measured", cls="E5", pe=ev)
    assert r["ok"] is False and r["reason"] == "source_rejected"
    assert w.record(origin="measured", cls="E5", pe=w.evidence(pid, review="verified"))["ok"] is True


def test_an_intake_file_is_usable_only_by_the_buyer_of_that_engagement(w):
    mine, theirs = w.intake_file(w.editor.upper()), w.intake_file("someone.else@elsewhere.example")
    assert w.record(origin="observed", cls="E3", intake=mine)["ok"] is True
    r = w.record(origin="observed", cls="E3", intake=theirs, path="hall.clear_height_m", unit="m")
    assert r["ok"] is False and r["reason"] == "invalid_reference" and r["constraint"] == "hall_inputs_source_not_yours"


# ---------------------------------------------------------------------------------------------------------- missing

def test_a_missing_input_has_no_value_no_source_and_is_class_e0(w):
    r = w.record(origin="missing", cls="E0", value=None, unit="MVA")
    assert r["ok"] is True
    assert scalar(w.db, f"select (value is null)::text || '|' || evidence_class || '|' || coalesce(unit, '-') from hall_inputs where id = '{r['id']}'") == "true|E0|MVA"


@pytest.mark.parametrize("kw", [dict(value=5), dict(cls="E1"), dict(pe="SOURCE")])
def test_a_missing_input_cannot_carry_a_value_a_higher_class_or_a_source(w, kw):
    args = dict(origin="missing", cls="E0", value=None, unit=None, path="grid.contracted_mw")
    if kw.get("pe") == "SOURCE":
        kw = dict(pe=w.sourced())
    r = w.record(**{**args, **kw})
    assert r["ok"] is False and r["constraint"] == "hall_inputs_missing_shape", r


def test_every_other_origin_needs_a_value(w):
    r = w.record(origin="assumed", cls="E0", value=None)
    assert r["ok"] is False and r["constraint"] == "hall_inputs_missing_shape"
    refused(w.db, raw_insert(w, origin="assumed", cls="E0", value="null"), "hall_inputs_missing_shape")


# ---------------------------------------------------------------------------------------------------------- evidence class

@pytest.mark.parametrize("origin", ["assumed", "modelled"])
@pytest.mark.parametrize("cls", ["E4", "E5", "E6", "E7"])
def test_an_assumption_or_a_model_cannot_claim_more_than_an_engineering_estimate(w, origin, cls):
    r = w.record(origin=origin, cls=cls)
    assert r["ok"] is False and r["constraint"] == "hall_inputs_assumed_class", r
    refused(w.db, raw_insert(w, origin=origin, cls=cls), "hall_inputs_assumed_class")


@pytest.mark.parametrize("origin", ["assumed", "modelled"])
@pytest.mark.parametrize("cls", ["E0", "E1", "E2", "E3"])
def test_an_assumption_or_a_model_may_claim_up_to_e3(w, origin, cls):
    assert w.record(origin=origin, cls=cls)["ok"] is True


@pytest.mark.parametrize("cls", ["E8", "e1", "", "E10", "high"])
def test_the_class_is_one_of_e0_to_e7(w, cls):
    refused(w.db, raw_insert(w, cls=cls, origin="vendor"), "hall_inputs_evidence_class")


def test_the_class_is_required(w):
    refused(w.db, raw_insert(w, origin="vendor").replace("'E1'", "null"), "null value")


@pytest.mark.parametrize("origin", ["guess", "Measured", "", "declared"])
def test_the_origin_is_one_of_the_seven_words(w, origin):
    refused(w.db, raw_insert(w, origin=origin), "origin")


# ---------------------------------------------------------------------------------------------------------- field path, value, unit, date

@pytest.mark.parametrize("path", ["grid.firm_capacity_mva", "transformers[0].unit_rating_mva", "hall.net_white_space_m2",
                                  "thermal.plant.chilled_water_capacity_kw", "btm_options[12].capacity_mw", "site"])
def test_the_intake_shaped_paths_are_accepted(w, path):
    assert w.record(path=path)["ok"] is True


@pytest.mark.parametrize("path", ["", "Grid.firm", "grid..x", "grid.x[", "grid.x[a]", "grid.x[1234]", "grid x", "grid.x;drop", "../etc",
                                  "a" + ".b" * 7, "g" * 121, "1grid", "grid.", ".grid", "grid.x]"])
def test_a_path_that_is_not_an_intake_path_is_refused(w, path):
    refused(w.db, raw_insert(w, path=path), "hall_inputs_field_path")


@pytest.mark.parametrize("value", ["'41.5'::jsonb", "'0'::jsonb", "'-3'::jsonb", "'\"busway\"'::jsonb", "'true'::jsonb"])
def test_a_scalar_value_is_accepted(w, value):
    unit = "null" if value.startswith("'\"") or value.startswith("'true") else "'kW'"
    psql(w.db, raw_insert(w, value=value, unit=unit, path=f"hall.f{uuid.uuid4().hex[:6]}"))


@pytest.mark.parametrize("value", ["'1e16'::jsonb", "'-1e16'::jsonb", "'null'::jsonb", "'[1]'::jsonb", "'{\"a\":1}'::jsonb", "'\"\"'::jsonb",
                                   f"'\"{'x' * 201}\"'::jsonb"])
def test_a_value_that_is_not_a_bounded_scalar_is_refused(w, value):
    refused(w.db, raw_insert(w, value=value, unit="null"), "hall_inputs_value_shape")


def test_a_unit_belongs_only_to_a_number_and_is_bounded(w):
    refused(w.db, raw_insert(w, value="'\"busway\"'::jsonb", unit="'MVA'"), "hall_inputs_unit")
    refused(w.db, raw_insert(w, unit="''"), "hall_inputs_unit")
    refused(w.db, raw_insert(w, unit=f"'{'u' * 25}'"), "hall_inputs_unit")


def test_the_date_is_required_not_in_the_future_and_not_absurdly_old(w):
    refused(w.db, raw_insert(w, as_of="null"), "null value")
    r = w.record(as_of="2999-01-01")
    assert r["ok"] is False and r["constraint"] == "hall_inputs_as_of_future"
    refused(w.db, raw_insert(w, as_of="'1899-01-01'"), "hall_inputs_as_of")
    assert w.record(as_of=scalar(w.db, "select current_date::text"), path="hall.clear_height_m", unit="m")["ok"]


# ---------------------------------------------------------------------------------------------------------- append-only

def test_a_recorded_input_can_never_be_updated_or_deleted_even_by_the_service_role(w):
    r = w.record()
    for sql in (f"update hall_inputs set value = '99'::jsonb where id = '{r['id']}'",
                f"update hall_inputs set origin = 'measured' where id = '{r['id']}'",
                f"update hall_inputs set recorded_by = 'x@y.example' where id = '{r['id']}'",
                f"delete from hall_inputs where id = '{r['id']}'"):
        refused(w.db, sql, "append-only")
        refused_either(w.db, "set role service_role; " + sql, "append-only", "permission denied")
    assert scalar(w.db, f"select value from hall_inputs where id = '{r['id']}'") == "40"


def test_the_table_cannot_be_truncated(w):
    w.record()
    refused(w.db, "truncate hall_inputs", "append-only")
    refused(w.db, "truncate hall_project_attachments, hall_project_detachments", "append-only")
    assert scalar(w.db, "select has_table_privilege('service_role', 'public.hall_inputs', 'truncate')") == "f"


# ---------------------------------------------------------------------------------------------------------- corrections

def test_a_correction_supersedes_the_same_field_of_the_same_hall_and_the_view_shows_only_the_latest(w):
    first = w.record(value=40)["id"]
    second = w.record(value=42, supersedes=first)["id"]
    third = w.record(value=44, supersedes=second)["id"]
    assert [r for r in scalar(w.db, f"select string_agg(value::text, ',' order by seq) from hall_inputs_current where hall_id = '{w.hall}' and field_path = 'grid.firm_capacity_mva'").split(",")] == ["44"]
    assert scalar(w.db, f"select count(*) from hall_inputs where hall_id = '{w.hall}' and field_path = 'grid.firm_capacity_mva'") == "3"
    assert scalar(w.db, f"select supersedes_id from hall_inputs where id = '{third}'") == second
    assert scalar(w.db, f"select count(*) from hall_inputs where id = '{first}'") == "1"        # the old figure is still there


def test_a_correction_must_name_the_same_field_and_the_same_hall(w):
    a = w.record()["id"]
    r = w.record(path="grid.contracted_mw", unit="MW", supersedes=a)
    assert r["ok"] is False and r["constraint"] == "hall_inputs_supersedes_scope" and r["reason"] == "invalid_reference"
    r = w.record(hall=w.hall2, supersedes=a)
    assert r["ok"] is False and r["constraint"] == "hall_inputs_supersedes_scope" and r["reason"] == "invalid_reference"
    refused(w.db, raw_insert(w, hall=w.hall2, supersedes=f"'{a}'"), "hall_inputs_supersedes_scope")
    refused(w.db, raw_insert(w, supersedes=f"'{uuid.uuid4()}'"), "violates foreign key")


def test_a_correction_cannot_reach_into_another_organisations_inputs(w):
    theirs = call(w.db, "gf_record_hall_input", p_actor=w.other, p_hall=w.hall_b, p_field_path="grid.firm_capacity_mva", p_value=7, p_unit="MVA",
                  p_evidence_class="E1", p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")["id"]
    r = w.record(supersedes=theirs)
    assert r["ok"] is False and r["constraint"] == "hall_inputs_supersedes_scope" and r["reason"] == "invalid_reference"


def test_history_is_a_line_not_a_tree_two_corrections_of_one_input_cannot_both_land(w):
    first = w.record()["id"]
    assert w.record(value=41, supersedes=first)["ok"] is True
    late = w.record(value=43, supersedes=first)
    assert late["ok"] is False and late["reason"] == "superseded" and late["current_id"]
    refused(w.db, raw_insert(w, value="'45'::jsonb", supersedes=f"'{first}'"), "hall_inputs_one_successor")


def test_a_field_with_a_value_is_not_recorded_again_without_naming_what_it_replaces(w):
    first = w.record()["id"]
    again = w.record(value=99)
    assert again["ok"] is False and again["reason"] == "field_already_recorded" and again["current_id"] == first
    refused(w.db, raw_insert(w, value="'99'::jsonb"), "hall_inputs_one_root")


def test_the_same_field_may_be_recorded_on_two_halls(w):
    assert w.record(hall=w.hall)["ok"] and w.record(hall=w.hall2)["ok"]


def test_a_missing_input_is_corrected_by_a_later_one_and_the_history_keeps_both(w):
    gap = w.record(origin="missing", cls="E0", value=None, unit="MVA")["id"]
    found = w.record(origin="assumed", cls="E0", value=30, supersedes=gap)
    assert found["ok"] is True
    assert scalar(w.db, f"select origin from hall_inputs_current where hall_id = '{w.hall}' and field_path = 'grid.firm_capacity_mva'") == "assumed"
    assert scalar(w.db, f"select count(*) from hall_inputs where hall_id = '{w.hall}'") == "2"


# ---------------------------------------------------------------------------------------------------------- roles and isolation

def test_only_editors_and_owners_record_inputs(w):
    assert w.record(actor=w.owner)["ok"] is True
    assert w.record(actor=w.editor, path="grid.contracted_mw", unit="MW")["ok"] is True
    assert w.record(actor=w.viewer, path="hall.clear_height_m", unit="m") == {"ok": False, "reason": "forbidden"}
    assert w.record(actor=w.other, path="hall.clear_height_m", unit="m") == {"ok": False, "reason": "not_a_member"}
    assert w.record(actor="nobody", path="hall.clear_height_m", unit="m") == {"ok": False, "reason": "invalid_actor"}
    assert w.record(hall=str(uuid.uuid4()), path="hall.clear_height_m", unit="m") == {"ok": False, "reason": "not_found"}


def test_a_member_of_organisation_a_cannot_record_on_or_read_the_inputs_of_organisation_b(w):
    secret = call(w.db, "gf_record_hall_input", p_actor=w.other, p_hall=w.hall_b, p_field_path="grid.firm_capacity_mva", p_value=123.456,
                  p_unit="MVA", p_evidence_class="E1", p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")
    assert secret["ok"]
    for actor in (w.owner, w.editor, w.viewer):
        assert w.record(actor=actor, hall=w.hall_b, path="hall.clear_height_m", unit="m") == {"ok": False, "reason": "not_a_member"}
        for history in (False, True):
            out = call(w.db, "gf_hall_inputs", p_actor=actor, p_hall=w.hall_b, p_history=history)
            assert out == {"ok": False, "reason": "not_a_member"}
    assert "123.456" not in json.dumps(call(w.db, "gf_hall_inputs", p_actor=w.owner, p_hall=w.hall, p_history=True))
    assert scalar(w.db, f"select count(*) from hall_inputs where hall_id = '{w.hall_b}'") == "1"


def test_a_removed_editor_can_no_longer_record(w):
    m = scalar(w.db, f"select id from organisation_members where org_id = '{w.org}' and email = '{w.editor}'")
    ok(w.db, "gf_org_remove_member", p_actor=w.owner, p_org=w.org, p_member=m)
    assert w.record()["reason"] == "not_a_member"


def test_the_table_itself_refuses_a_recorder_who_is_not_an_editor_of_the_halls_organisation(w):
    for who in (w.viewer, w.other, "ghost@nowhere.example"):
        refused(w.db, raw_insert(w, by=who), "not an editor")
    psql(w.db, raw_insert(w, by=w.editor))


def test_a_viewer_reads_current_and_history(w):
    first = w.record(value=40)["id"]
    w.record(value=42, supersedes=first)
    cur = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall)
    assert [i["value"] for i in cur["inputs"]] == [42]
    hist = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall, p_history=True)
    assert sorted(i["value"] for i in hist["inputs"]) == [40, 42]
    assert {i["id"]: i["superseded"] for i in hist["inputs"]} == {first: True, **{i["id"]: False for i in cur["inputs"]}}
    assert cur["hall"]["data_origin"] == "synthetic"


def test_the_read_carries_the_source_label_but_no_storage_location_or_digest(w):
    ev = w.sourced()
    w.record(origin="quotation", cls="E5", pe=ev)
    out = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall)
    src = out["inputs"][0]["source"]
    assert src == {"kind": "project_evidence", "id": ev, "filename": "agreement.pdf", "review_status": "verified"}
    assert not re.search(r"storage_ref|sha256|project-evidence/", json.dumps(out))


# ---------------------------------------------------------------------------------------------------------- the view

def test_hall_inputs_current_is_one_row_per_hall_and_field(w):
    for p in ("grid.firm_capacity_mva", "grid.contracted_mw"):
        first = w.record(path=p, unit="MVA")["id"]
        w.record(path=p, unit="MVA", value=1, supersedes=first)
    assert scalar(w.db, f"select count(*) from hall_inputs_current where hall_id = '{w.hall}'") == "2"
    assert scalar(w.db, f"select count(*) from (select 1 from hall_inputs_current group by hall_id, field_path having count(*) > 1) x") == "0"


def test_the_view_exposes_no_storage_location_or_digest_and_is_not_open_to_the_api_roles(w):
    cols = scalar(w.db, "select string_agg(column_name, ',') from information_schema.columns where table_name = 'hall_inputs_current'")
    assert "storage_ref" not in cols and "sha256" not in cols
    for role in ("anon", "authenticated"):
        assert scalar(w.db, f"select has_table_privilege('{role}', 'public.hall_inputs_current', 'select')") == "f"
    assert scalar(w.db, "select reloptions::text from pg_class where oid = 'public.hall_inputs_current'::regclass").find("security_invoker=true") > 0


# ---------------------------------------------------------------------------------------------------------- projects and halls

def test_the_two_new_project_columns_are_additive_and_nullable(db):
    rows = scalar(db, "select string_agg(column_name || ':' || is_nullable, ',' order by column_name) from information_schema.columns "
                      "where table_name = 'projects' and column_name in ('site_id', 'hall_id')")
    assert rows == "hall_id:YES,site_id:YES"


def test_an_editor_attaches_a_project_to_a_hall_by_its_link_token_and_the_answer_carries_no_token(w):
    pid, token = w.project()
    r = ok(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=w.hall, p_project_token=token)
    assert r["project_id"] == pid and token not in json.dumps(r)
    assert scalar(w.db, f"select site_id || '/' || hall_id from projects where id = '{pid}'") == f"{w.site}/{w.hall}"
    assert scalar(w.db, f"select attached_by from hall_project_attachments where project_id = '{pid}'") == w.editor


def test_attaching_twice_to_the_same_hall_is_harmless_and_to_another_hall_is_refused(w):
    pid, token = w.project(attach_to=w.hall)
    again = ok(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall, p_project_token=token)
    assert again["already_attached"] is True
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall2, p_project_token=token) == "project_in_other_hall"
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.other, p_hall=w.hall_b, p_project_token=token) == "project_in_other_hall"
    assert scalar(w.db, f"select count(*) from hall_project_attachments where project_id = '{pid}'") == "1"


def test_only_editors_and_owners_of_the_halls_organisation_attach(w):
    _, token = w.project()
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.viewer, p_hall=w.hall, p_project_token=token) == "forbidden"
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.other, p_hall=w.hall, p_project_token=token) == "not_a_member"
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=w.hall_b, p_project_token=token) == "not_a_member"
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=w.hall, p_project_token="nope") == "project_not_found"
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=str(uuid.uuid4()), p_project_token=token) == "not_found"
    assert scalar(w.db, f"select count(*) from projects where project_token = '{token}' and hall_id is not null") == "0"


def test_the_tables_refuse_a_project_pointing_at_a_hall_of_another_site_or_only_half_a_pair(w):
    pid, _ = w.project()
    other_site_hall = new_hall(w.db, w.owner, new_site(w.db, w.owner, w.org))
    refused(w.db, f"insert into hall_project_attachments (project_id, site_id, hall_id, attached_by) values ('{pid}', '{w.site}', '{other_site_hall}', '{w.editor}')",
            "hall_project_attachments_hall_pair")
    assert scalar(w.db, "select count(*) from pg_constraint where conname = 'projects_hall_pair' and contype = 'f'") == "1"
    refused(w.db, f"insert into projects (project_token, project_name, site_id, hall_id) values ('{uuid.uuid4().hex}', 'sneaky', '{w.site}', '{w.hall}')", "without a hall")
    refused(w.db, f"update projects set hall_id = '{w.hall}' where id = '{pid}'", "projects_hall_both_or_neither")
    refused(w.db, f"update projects set site_id = '{w.site}' where id = '{pid}'", "projects_hall_both_or_neither")


def test_a_project_cannot_be_given_a_hall_except_through_a_recorded_attachment_and_never_moves_after(w):
    pid, token = w.project()
    refused(w.db, f"update projects set site_id = '{w.site}', hall_id = '{w.hall}' where id = '{pid}'", "recorded attachment")
    ok(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=w.hall, p_project_token=token)
    refused(w.db, f"update projects set site_id = '{w.site}', hall_id = '{w.hall2}' where id = '{pid}'", "cannot move")
    refused(w.db, f"update projects set site_id = null, hall_id = null where id = '{pid}'", "cannot move")
    psql(w.db, f"update projects set status = 'active' where id = '{pid}'")            # everything else about a project is unaffected


def test_an_attachment_is_never_edited_or_deleted_and_a_project_has_at_most_one_open_one(w):
    pid, token = w.project(attach_to=w.hall)
    refused(w.db, f"update hall_project_attachments set hall_id = '{w.hall2}' where project_id = '{pid}'", "append-only")
    refused(w.db, f"delete from hall_project_attachments where project_id = '{pid}'", "append-only")
    refused(w.db, f"insert into hall_project_attachments (project_id, site_id, hall_id, attached_by) values ('{pid}', '{w.site}', '{w.hall2}', '{w.editor}')",
            "already attached")


# ---------------------------------------------------------------------------------------------------------- privileges

INPUT_RPCS = ["gf_record_hall_input(text, uuid, text, jsonb, text, text, text, uuid, uuid, date, uuid)", "gf_hall_inputs(text, uuid, boolean, text, integer)",
              "gf_attach_project_to_hall(text, uuid, text)", "gf_detach_project_from_hall(text, uuid, uuid)"]


def test_rls_is_on_with_no_policies_and_the_api_roles_hold_nothing(db):
    for t in ("hall_inputs", "hall_project_attachments"):
        assert scalar(db, f"select relrowsecurity from pg_class where oid = 'public.{t}'::regclass") == "t"
        assert scalar(db, f"select count(*) from pg_policies where tablename = '{t}'") == "0"
        for role in ("anon", "authenticated"):
            assert scalar(db, f"select has_table_privilege('{role}', 'public.{t}', 'select,insert,update,delete')") == "f", (role, t)
    for role in ("anon", "authenticated"):
        for f in INPUT_RPCS:
            assert scalar(db, f"select has_function_privilege('{role}', 'public.{f}', 'execute')") == "f", (role, f)
    for f in INPUT_RPCS:
        assert scalar(db, f"select has_function_privilege('service_role', 'public.{f}', 'execute')") == "t", f
        acl = scalar(db, f"select coalesce(proacl::text, '') from pg_proc where oid = 'public.{f}'::regprocedure")
        assert not re.search(r"(^|[{,])=X", acl), (f, acl)


# ====================================================================================================================
# Rework: declared class caps, a lower-case path, a conservative unit, caps per hall, normalisation, folded references
# ====================================================================================================================

def test_a_vendor_figure_without_a_file_cannot_claim_above_e3_with_a_reviewed_file_it_can(w):
    for cls in ("E4", "E5", "E7"):
        r = w.record(origin="vendor", cls=cls, path=f"hall.v_{cls.lower()}")
        assert r["ok"] is False and r["constraint"] == "hall_inputs_vendor_class", (cls, r)
        refused(w.db, raw_insert(w, origin="vendor", cls=cls, path=f"hall.v_{cls.lower()}"), "hall_inputs_vendor_class")
    assert w.record(origin="vendor", cls="E3", path="hall.v_e3")["ok"] is True
    assert w.record(origin="vendor", cls="E5", path="hall.v_e5_file", pe=w.sourced())["ok"] is True


@pytest.mark.parametrize("origin", ["measured", "observed", "quotation", "vendor"])
def test_a_class_above_e3_needs_a_project_file_that_has_been_reviewed_and_verified(w, origin):
    unreviewed = w.sourced(review="unverified")
    r = w.record(origin=origin, cls="E4", pe=unreviewed, path="hall.u1")
    assert r["ok"] is False and r["constraint"] == "hall_inputs_unreviewed_source", r
    refused(w.db, raw_insert(w, origin=origin, cls="E5", pe=f"'{unreviewed}'", path="hall.u2"), "hall_inputs_unreviewed_source")
    assert w.record(origin=origin, cls="E3", pe=unreviewed, path="hall.u3")["ok"] is True          # the same file supports a declared E3
    assert w.record(origin=origin, cls="E7", pe=w.sourced(review="verified"), path="hall.u4")["ok"] is True


def test_a_purchased_engagement_file_is_not_reviewable_so_it_supports_at_most_e3(w):
    f = w.intake_file(w.editor)
    r = w.record(origin="observed", cls="E4", intake=f, path="hall.i1")
    assert r["ok"] is False and r["constraint"] == "hall_inputs_unreviewed_source", r
    assert w.record(origin="observed", cls="E3", intake=f, path="hall.i2")["ok"] is True


def test_the_view_shows_the_files_live_review_status_even_after_it_changes(w):
    pid, _ = w.project(attach_to=w.hall)
    ev = w.evidence(pid, "unverified")
    w.record(origin="measured", cls="E3", pe=ev, path="hall.live")
    review_evidence(w.db, ev, "verified")
    out = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall)
    assert out["inputs"][0]["source"]["review_status"] == "verified" and out["inputs"][0]["evidence_class"] == "E3"


def test_a_field_path_is_stored_lower_case_so_two_spellings_are_one_field(w):
    first = w.record(path="Grid.Firm_Capacity_MVA")
    assert first["ok"] is True
    assert scalar(w.db, f"select field_path from hall_inputs where id = '{first['id']}'") == "grid.firm_capacity_mva"
    again = w.record(path="grid.FIRM_capacity_mva", value=41)
    assert again["ok"] is False and again["reason"] == "field_already_recorded"
    refused(w.db, raw_insert(w, path="Grid.firm_capacity_mva"), "hall_inputs_field_path")          # the table itself holds lower case only


@pytest.mark.parametrize("unit", ["MVA;drop", "M\u202eVA", "<b>", "a\nb", "MVA\u00a0", "k\u200bW"])
def test_a_unit_outside_a_conservative_alphabet_is_refused(w, unit):
    refused(w.db, raw_insert(w, unit=q(unit)), "hall_inputs_unit")


@pytest.mark.parametrize("unit", ["MVA", "kW/rack", "m2", "m\u00b2", "%", "\u00b0C", "\u00b5s", "kPa", "MWh/yr", "kg.m^-2"])
def test_ordinary_units_are_accepted(w, unit):
    assert w.record(unit=unit, path=f"hall.un{uuid.uuid4().hex[:6]}")["ok"] is True


def test_an_absurdly_large_number_is_an_invalid_input_not_an_error(w):
    r = call(w.db, "gf_record_hall_input", p_actor=w.editor, p_hall=w.hall, p_field_path="hall.big", p_value=1e308, p_unit=None, p_evidence_class="E1",
             p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")
    assert r["ok"] is False and r["reason"] == "invalid_input" and r["constraint"] == "hall_inputs_value_shape"


def test_the_overflow_of_the_check_expression_itself_is_caught(w):
    # jsonb accepts a number far beyond double range; casting it to numeric inside a CHECK must not leak a raw error
    out = psql(w.db, "set role service_role; select public.gf_record_hall_input(p_actor => %s, p_hall => '%s', p_field_path => 'hall.huge', p_value => '1e100000'::jsonb, "
                     "p_unit => null, p_evidence_class => 'E1', p_origin => 'assumed', p_project_evidence => null, p_intake_evidence => null, p_as_of => '2026-01-01')" % (q(w.editor), w.hall), check=False)
    if out.returncode == 0:
        assert json.loads(out.stdout.strip().splitlines()[-1])["reason"] == "invalid_input"
    else:                                                             # the number is refused before the function runs: still no partial write
        assert "out of range" in out.stderr or "invalid input" in out.stderr
    assert scalar(w.db, f"select count(*) from hall_inputs where field_path = 'hall.huge'") == "0"


def test_a_hall_holds_at_most_500_fields_and_each_at_most_50_corrections(w):
    psql(w.db, "insert into hall_inputs (hall_id, field_path, value, unit, evidence_class, origin, as_of, recorded_by) "
               f"select '{w.hall}', 'bulk.f' || g, to_jsonb(g), null, 'E1', 'assumed', '2026-01-01', '{w.editor}' from generate_series(1, 499) g")
    assert w.record(path="bulk.last")["ok"] is True                                    # the 500th field
    r = w.record(path="bulk.one_too_many")
    assert r["ok"] is False and r["reason"] == "field_limit", r
    refused(w.db, raw_insert(w, path="bulk.one_too_many"), "hall_inputs_field_limit")
    # corrections: a chain of 50 rows (the first claim and 49 corrections) is the most a field can hold
    psql(w.db, f"""do $$ declare prev uuid; cur uuid; begin
      insert into hall_inputs (hall_id, field_path, value, evidence_class, origin, as_of, recorded_by) values ('{w.hall2}', 'chain.f', '0'::jsonb, 'E1', 'assumed', '2026-01-01', '{w.editor}') returning id into prev;
      for i in 1..49 loop
        insert into hall_inputs (hall_id, field_path, value, evidence_class, origin, as_of, recorded_by, supersedes_id) values ('{w.hall2}', 'chain.f', to_jsonb(i), 'E1', 'assumed', '2026-01-01', '{w.editor}', prev) returning id into cur;
        prev := cur;
      end loop; end $$""")
    head = scalar(w.db, f"select id from hall_inputs_current where hall_id = '{w.hall2}' and field_path = 'chain.f'")
    r = w.record(hall=w.hall2, path="chain.f", value=99, supersedes=head)
    assert r["ok"] is False and r["reason"] == "correction_limit", r


def test_the_read_is_bounded_and_history_can_be_asked_for_one_field(w):
    first = w.record(path="grid.a")["id"]
    second = w.record(path="grid.a", value=2, supersedes=first)["id"]
    w.record(path="grid.a", value=3, supersedes=second)
    w.record(path="grid.b")
    hist = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall, p_history=True, p_field="Grid.A")
    assert [i["value"] for i in hist["inputs"]] == [3, 2, 40]            # newest first
    assert {i["field_path"] for i in hist["inputs"]} == {"grid.a"} and hist["truncated"] is False
    cut = call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall, p_history=True, p_limit=2)
    assert len(cut["inputs"]) == 2 and cut["truncated"] is True
    assert len(call(w.db, "gf_hall_inputs", p_actor=w.viewer, p_hall=w.hall, p_history=True, p_limit=100000)["inputs"]) == 4


def test_a_reference_that_cannot_be_used_has_one_answer_whatever_the_reason(w):
    """A file or an earlier figure that does not exist, that is not this hall's, or belongs to someone else: the same reason, so the answer is no oracle."""
    other_project, _ = w.project(attach_to=w.hall2)
    elsewhere = w.evidence(other_project)
    theirs = call(w.db, "gf_record_hall_input", p_actor=w.other, p_hall=w.hall_b, p_field_path="grid.x", p_value=1, p_unit=None, p_evidence_class="E1",
                  p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")["id"]
    mine = w.record(path="grid.mine")["id"]
    answers = [
        w.record(origin="measured", cls="E3", pe=str(uuid.uuid4()), path="hall.r1"),
        w.record(origin="measured", cls="E3", pe=elsewhere, path="hall.r2"),
        w.record(origin="observed", cls="E3", intake=w.intake_file("x@elsewhere.example"), path="hall.r3"),
        w.record(origin="observed", cls="E3", intake=str(uuid.uuid4()), path="hall.r4"),
        w.record(path="grid.mine", value=2, supersedes=str(uuid.uuid4())),
        w.record(path="grid.mine", value=2, supersedes=theirs),
        w.record(path="grid.other_field", value=2, supersedes=mine),
    ]
    assert {a["reason"] for a in answers} == {"invalid_reference"}, answers


# ---- attach, detach, and the event the project's owner can see ------------------------------------------------------

def test_attaching_tells_the_project_owner_through_the_projects_own_log_without_naming_anyone(w):
    pid, token = w.project()
    ok(w.db, "gf_attach_project_to_hall", p_actor=w.editor, p_hall=w.hall, p_project_token=token)
    rows = psql(w.db, f"select event_type || '|' || actor || '|' || payload::text from project_events where project_id = '{pid}' and event_type = 'project_attached_to_hall'").stdout.strip().splitlines()
    assert len(rows) == 1
    assert "@" not in rows[0] and w.editor not in rows[0] and token not in rows[0]
    assert json.loads(rows[0].split("|", 2)[2])["hall_id"] == w.hall


def test_attaching_twice_to_the_same_hall_does_not_log_twice(w):
    pid, token = w.project(attach_to=w.hall)
    ok(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall, p_project_token=token)
    assert scalar(w.db, f"select count(*) from project_events where project_id = '{pid}' and event_type = 'project_attached_to_hall'") == "1"


def test_the_event_types_are_a_union_nothing_that_was_allowed_is_lost(w):
    for t in ("project_created", "evidence_attached", "share_revoked", "supplier_actual_submitted", "comparison_saved", "project_attached_to_hall", "project_detached_from_hall"):
        pid, _ = w.project()
        psql(w.db, f"insert into project_events (project_id, event_type, actor) values ('{pid}', '{t}', 'x')")
    refused(w.db, f"insert into project_events (project_id, event_type, actor) select id, 'made_up', 'x' from projects limit 1", "project_events_event_type_check")


def test_an_owner_detaches_a_project_an_editor_cannot_and_the_history_stays(w):
    pid, token = w.project(attach_to=w.hall)
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=w.editor, p_hall=w.hall, p_project=pid) == "forbidden"
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=w.viewer, p_hall=w.hall, p_project=pid) == "forbidden"
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=w.other, p_hall=w.hall, p_project=pid) == "not_a_member"
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall2, p_project=pid) == "not_attached"
    ok(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid)
    assert scalar(w.db, f"select coalesce(hall_id::text, 'none') from projects where id = '{pid}'") == "none"
    assert scalar(w.db, f"select count(*) from hall_project_attachments where project_id = '{pid}'") == "1"
    assert scalar(w.db, f"select detached_by from hall_project_detachments where project_id = '{pid}'") == w.owner
    assert scalar(w.db, f"select count(*) from project_events where project_id = '{pid}' and event_type = 'project_detached_from_hall'") == "1"
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid) == "not_attached"


def test_after_detaching_the_project_can_be_attached_elsewhere_and_not_before(w):
    pid, token = w.project(attach_to=w.hall)
    assert reason(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall2, p_project_token=token) == "project_in_other_hall"
    ok(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid)
    ok(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall2, p_project_token=token)
    assert scalar(w.db, f"select hall_id from projects where id = '{pid}'") == w.hall2
    assert scalar(w.db, f"select count(*) from hall_project_attachments where project_id = '{pid}'") == "2"
    assert scalar(w.db, f"select count(*) from hall_project_detachments where project_id = '{pid}'") == "1"


def test_a_project_cannot_hold_two_open_attachments_even_by_direct_insert(w):
    pid, _ = w.project(attach_to=w.hall)
    refused(w.db, f"insert into hall_project_attachments (project_id, site_id, hall_id, attached_by) values ('{pid}', '{w.site}', '{w.hall2}', '{w.editor}')", "already attached")


def test_a_project_cannot_leave_a_hall_except_through_a_recorded_detachment(w):
    pid, _ = w.project(attach_to=w.hall)
    refused(w.db, f"update projects set site_id = null, hall_id = null where id = '{pid}'", "cannot move")
    psql(w.db, f"update projects set status = 'active' where id = '{pid}'")


def test_detachments_are_append_only_and_cannot_be_truncated(w):
    pid, _ = w.project(attach_to=w.hall)
    ok(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid)
    refused(w.db, f"update hall_project_detachments set detached_by = 'x@y.example' where project_id = '{pid}'", "append-only")
    refused(w.db, f"delete from hall_project_detachments where project_id = '{pid}'", "append-only")
    refused(w.db, "truncate hall_project_detachments", "append-only")
    refused(w.db, f"insert into hall_project_detachments (attachment_id, project_id, site_id, hall_id, detached_by) select id, project_id, site_id, hall_id, '{w.owner}' from hall_project_attachments where project_id = '{pid}'", "duplicate key")


def test_a_removed_owner_cannot_detach(w):
    pid, _ = w.project(attach_to=w.hall)
    second = add_member(w.db, w.org, w.owner, f"second-{uuid.uuid4().hex[:6]}@a.example", "owner")
    m = scalar(w.db, f"select email from organisation_members where id = '{second['member_id']}'")
    ok(w.db, "gf_org_remove_member", p_actor=w.owner, p_org=w.org, p_member=second["member_id"])
    assert reason(w.db, "gf_detach_project_from_hall", p_actor=m, p_hall=w.hall, p_project=pid) == "not_a_member"
