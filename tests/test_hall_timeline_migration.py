"""0051_hall_timeline.sql against a real PostgreSQL: one read-only timeline per hall, over what the registry and its attached projects hold.

Each test is a way the timeline could leak or mislead: another hall's or another organisation's events in it, a project link token or a
storage location in a column, a log payload exposed, a superseded delivery date shown as if current, a supplier's own date presented
without saying it is the supplier's, an unreviewed observation presented as reviewed.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none.
"""
import json
import re
import uuid

import pytest
from registry_pg import add_member, call, drop_database, make_database, needs_db, new_hall, new_org, new_site, ok, psql, refused, scalar

pytestmark = needs_db

SECRET = "SECRET-TOKEN-do-not-leak"


@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


class World:
    def __init__(self, db):
        tag = uuid.uuid4().hex[:8]
        self.db = db
        self.owner, self.viewer, self.other = f"owner-{tag}@a.example", f"viewer-{tag}@a.example", f"other-{tag}@b.example"
        self.org = new_org(db, self.owner)
        add_member(db, self.org, self.owner, self.viewer, "viewer")
        self.site = new_site(db, self.owner, self.org)
        self.hall = new_hall(db, self.owner, self.site)
        self.hall2 = new_hall(db, self.owner, self.site)
        self.org_b = new_org(db, self.other)
        self.hall_b = new_hall(db, self.other, new_site(db, self.other, self.org_b))

    def project(self, hall, actor):
        token = f"{SECRET}-{uuid.uuid4().hex}"
        pid = scalar(self.db, f"insert into projects (project_token, project_name) values ('{token}', 'Hall project') returning id")
        ok(self.db, "gf_attach_project_to_hall", p_actor=actor, p_hall=hall, p_project_token=token)
        return pid

    def event(self, pid, etype, at, actor="engineer@a.example"):
        psql(self.db, "insert into project_events (project_id, event_type, occurred_at, actor, payload) "
                      f"values ('{pid}', '{etype}', '{at}', '{actor}', '{{\"case_token\": \"{SECRET}\"}}')")

    def evidence(self, pid):
        return scalar(self.db, "insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref) "
                               f"values ('{pid}', 'bill.pdf', 'application/pdf', '{uuid.uuid4().hex * 2}', 10, 'project-evidence/{SECRET}') returning id")

    def package(self, pid):
        pkg = scalar(self.db, "insert into procurement_packages (package_token, project_id, case_token, case_revision, architecture, spec_summary, "
                              f"response_template, document_md, document_html) values ('{SECRET}-{uuid.uuid4().hex}', '{pid}', 'c', 1, 'A', '{{}}', '{{}}', 'm', 'h') returning id")
        resp = scalar(self.db, f"insert into procurement_responses (package_id, project_id, supplier, response) values ('{pkg}', '{pid}', 'Acme Power', '{{}}') returning id")
        psql(self.db, f"update procurement_packages set selected_supplier = 'Acme Power', selected_response_id = '{resp}', selected_by = 'x', selected_at = now() where id = '{pkg}'")
        return pkg, resp

    def actual(self, pid, pkg, resp, ev, supersedes=None, **dates):
        cols = ", ".join(dates)
        vals = ", ".join(f"'{v}'" for v in dates.values())
        return scalar(self.db, "insert into supplier_actuals (project_id, package_id, selected_response_id, supplier, case_token, case_revision, architecture, "
                               f"quoted_snapshot, evidence_id, method, submitted_by, supersedes_id, {cols}) values ('{pid}', '{pkg}', '{resp}', 'Acme Power', 'c', 1, 'A', "
                               f"'{{}}', '{ev}', 'delivery note', 'x@a.example', {'null' if not supersedes else repr(str(supersedes))}, {vals}) returning id")

    def observation(self, pid, ev, observed_on="2026-03-01", observed=11.0, review=None):
        oid = scalar(self.db, "insert into project_observations (project_id, prediction_ref, case_token, case_revision, architecture, calibration_key, unit, "
                              "predicted_value, predicted_source, observed_value, observed_on, method, evidence_id, installed_attested, installed_basis, submitted_by) "
                              f"values ('{pid}', 'power_deployment_case:c:r1:A', 'c', 1, 'A', 'btm.firm_MW', 'MW', 12.5, 'engine', {observed}, '{observed_on}', 'meter', "
                              f"'{ev}', true, 'commissioning sheet', 'x@a.example') returning id")
        if review:
            psql(self.db, "insert into project_observation_reviews (observation_id, project_id, decision, evidence_class, reviewer) "
                          f"values ('{oid}', '{pid}', 'verified', '{review}', 'reviewer@desk.example')")
        return oid

    def timeline(self, actor=None, hall=None, **kw):
        return call(self.db, "gf_hall_timeline", p_actor=actor or self.viewer, p_hall=hall or self.hall, **kw)


@pytest.fixture()
def w(db):
    return World(db)


def populated(w):
    """A hall with one of everything: an input, a project log, a supplier's delivery dates and an observation."""
    pid = w.project(w.hall, w.owner)
    w.event(pid, "project_created", "2026-01-10T09:00:00Z")
    w.event(pid, "rfq_generated", "2026-02-01T09:00:00Z")
    ok(w.db, "gf_record_hall_input", p_actor=w.owner, p_hall=w.hall, p_field_path="grid.firm_capacity_MVA", p_value=40, p_unit="MVA",
       p_evidence_class="E1", p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-15")
    ev = w.evidence(pid)
    pkg, resp = w.package(pid)
    w.actual(pid, pkg, resp, ev, po_date="2026-02-10", on_site_date="2026-04-01")
    w.observation(pid, ev)
    return pid, ev, pkg, resp


# ---------------------------------------------------------------------------------------------------------- what is in it

def test_the_timeline_unions_inputs_project_log_supplier_dates_and_observations_in_time_order(w):
    populated(w)
    events = w.timeline()["events"]
    assert {e["kind"] for e in events} == {"input_recorded", "project_event", "supplier_date", "observation"}
    times = [e["occurred_at"] for e in events]
    assert times == sorted(times, reverse=True)                       # newest first
    assert [e["subject"] for e in events if e["kind"] == "supplier_date"] == ["on_site_date", "po_date"]
    assert [e["subject"] for e in events if e["kind"] == "project_event"] == ["rfq_generated", "project_created"]


def test_every_event_says_what_kind_of_thing_it_is_and_what_stands_behind_it(w):
    populated(w)
    by_kind = {}
    for e in w.timeline()["events"]:
        by_kind.setdefault(e["kind"], e)
        assert e["basis"], e                                          # nothing appears without a label of its basis
    inp = by_kind["input_recorded"]
    assert (inp["origin"], inp["evidence_class"]) == ("assumed", "E1") and "40" in inp["summary"] and "MVA" in inp["summary"]
    assert "2026-01-15" in inp["summary"]                             # the figure's own date is stated
    log = by_kind["project_event"]
    assert log["origin"] == "recorded" and log["evidence_class"] is None and "not a measurement" in log["basis"]
    sup = by_kind["supplier_date"]
    assert sup["origin"] == "vendor" and "supplier" in sup["basis"].lower() and "unreviewed" in sup["basis"].lower()
    obs = by_kind["observation"]
    assert obs["origin"] == "observed" and obs["evidence_class"] is None and "unreviewed" in obs["basis"].lower()


def test_a_reviewed_observation_and_a_reviewed_supplier_date_say_so(w):
    pid = w.project(w.hall, w.owner)
    ev = w.evidence(pid)
    w.observation(pid, ev, review="E5")
    pkg, resp = w.package(pid)
    actual = w.actual(pid, pkg, resp, ev, po_date="2026-02-10", dispatch_date="2026-03-01")
    psql(w.db, f"insert into supplier_actual_reviews (actual_id, project_id, decision, verified_fields, reviewer) values ('{actual}', '{pid}', 'verified', array['po_date'], 'r@desk.example')")
    events = w.timeline()["events"]
    obs = next(e for e in events if e["kind"] == "observation")
    assert obs["evidence_class"] == "E5" and "verified" in obs["basis"].lower() and "unreviewed" not in obs["basis"].lower()
    po = next(e for e in events if e["subject"] == "po_date")
    dispatch = next(e for e in events if e["subject"] == "dispatch_date")
    assert "verified" in po["basis"].lower() and "unreviewed" in dispatch["basis"].lower()      # a review vouches only for the fields it lists


def test_only_the_dates_a_supplier_gave_become_events_and_a_replaced_record_does_not_count_twice(w):
    pid = w.project(w.hall, w.owner)
    ev = w.evidence(pid)
    pkg, resp = w.package(pid)
    first = w.actual(pid, pkg, resp, ev, po_date="2026-02-10")
    w.actual(pid, pkg, resp, ev, supersedes=first, po_date="2026-02-12", energised_date="2026-06-01")
    dates = [(e["subject"], e["occurred_at"][:10]) for e in w.timeline()["events"] if e["kind"] == "supplier_date"]
    assert dates == [("energised_date", "2026-06-01"), ("po_date", "2026-02-12")]


def test_a_corrected_input_appears_twice_and_the_old_one_is_marked_superseded(w):
    first = ok(w.db, "gf_record_hall_input", p_actor=w.owner, p_hall=w.hall, p_field_path="grid.contracted_MW", p_value=30, p_unit="MW",
               p_evidence_class="E1", p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")["id"]
    ok(w.db, "gf_record_hall_input", p_actor=w.owner, p_hall=w.hall, p_field_path="grid.contracted_MW", p_value=35, p_unit="MW",
       p_evidence_class="E1", p_origin="assumed", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-02-01", p_supersedes=first)
    rows = [e for e in w.timeline()["events"] if e["kind"] == "input_recorded"]
    assert sorted((e["superseded"], "35" in e["summary"]) for e in rows) == [(False, True), (True, False)]


def test_a_missing_input_is_shown_as_missing(w):
    ok(w.db, "gf_record_hall_input", p_actor=w.owner, p_hall=w.hall, p_field_path="grid.contracted_MW", p_value=None, p_unit="MW",
       p_evidence_class="E0", p_origin="missing", p_project_evidence=None, p_intake_evidence=None, p_as_of="2026-01-01")
    e = next(e for e in w.timeline()["events"] if e["kind"] == "input_recorded")
    assert e["origin"] == "missing" and "missing" in e["summary"].lower()


def test_an_empty_hall_has_an_empty_timeline(w):
    assert w.timeline(hall=w.hall2)["events"] == []


# ---------------------------------------------------------------------------------------------------------- scope and isolation

def test_a_halls_timeline_holds_only_that_halls_projects_and_inputs(w):
    mine = w.project(w.hall, w.owner)
    sibling = w.project(w.hall2, w.owner)
    w.event(mine, "project_created", "2026-01-10T09:00:00Z")
    w.event(sibling, "evidence_attached", "2026-01-11T09:00:00Z")
    w.event(mine, "evidence_attached", "2026-01-12T09:00:00Z")
    subjects = [e["subject"] for e in w.timeline()["events"]]
    assert subjects == ["evidence_attached", "project_created"]
    assert all(e["project_id"] == mine for e in w.timeline()["events"])
    assert len(w.timeline(hall=w.hall2)["events"]) == 1
    loose = scalar(w.db, f"insert into projects (project_token, project_name) values ('{uuid.uuid4().hex}', 'unattached') returning id")
    w.event(loose, "project_created", "2026-01-13T09:00:00Z")
    assert len(w.timeline()["events"]) == 2


def test_a_member_of_one_organisation_cannot_read_the_timeline_of_another(w):
    pid = w.project(w.hall_b, w.other)
    w.event(pid, "project_created", "2026-01-10T09:00:00Z")
    for actor in (w.owner, w.viewer):
        assert w.timeline(actor=actor, hall=w.hall_b) == {"ok": False, "reason": "not_a_member"}
    assert w.timeline(actor=w.other, hall=w.hall_b)["ok"] is True
    assert w.timeline(hall=str(uuid.uuid4())) == {"ok": False, "reason": "not_found"}
    assert w.timeline(actor="nobody") == {"ok": False, "reason": "invalid_actor"}


def test_a_removed_member_reads_nothing(w):
    populated(w)
    m = scalar(w.db, f"select id from organisation_members where org_id = '{w.org}' and email = '{w.viewer}'")
    ok(w.db, "gf_org_remove_member", p_actor=w.owner, p_org=w.org, p_member=m)
    assert w.timeline()["reason"] == "not_a_member"


# ---------------------------------------------------------------------------------------------------------- no secrets

FORBIDDEN_COLUMN = re.compile(r"token|storage|sha256|hash|payload|secret|key|document|email_body", re.I)


def test_no_column_of_the_view_can_carry_a_token_a_storage_location_a_digest_or_a_log_payload(w):
    cols = scalar(w.db, "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'hall_timeline'").split(",")
    assert {"hall_id", "occurred_at", "kind", "subject", "summary", "origin", "evidence_class", "basis", "actor", "project_id", "superseded"} <= set(cols)
    assert not [c for c in cols if FORBIDDEN_COLUMN.search(c)], cols


def test_nothing_secret_in_the_stored_rows_reaches_the_answer(w):
    populated(w)
    out = json.dumps(w.timeline())
    assert SECRET not in out
    assert not re.search(r"storage_ref|project-evidence/|case_token|package_token|project_token|sha256", out)
    rows = scalar(w.db, f"select string_agg(h::text, ' ') from hall_timeline h where h.hall_id = '{w.hall}'")
    assert SECRET not in rows and "project-evidence/" not in rows


# ---------------------------------------------------------------------------------------------------------- limits

def test_the_answer_is_bounded_and_says_when_it_was_cut(w):
    pid = w.project(w.hall, w.owner)
    for i in range(7):
        w.event(pid, "evidence_attached", f"2026-01-{10 + i}T09:00:00Z")
    out = w.timeline(p_limit=3)
    assert len(out["events"]) == 3 and out["truncated"] is True and out["events"][0]["occurred_at"].startswith("2026-01-16")
    out = w.timeline(p_limit=50)
    assert len(out["events"]) == 7 and out["truncated"] is False
    assert len(w.timeline(p_limit=100000)["events"]) == 7                     # an absurd limit is clamped, not obeyed
    assert len(w.timeline(p_limit=0)["events"]) == 1                          # and a silly one raised to the minimum


def test_a_page_before_a_time_continues_where_the_last_one_stopped(w):
    pid = w.project(w.hall, w.owner)
    for i in range(5):
        w.event(pid, "evidence_attached", f"2026-01-{10 + i}T09:00:00Z")
    first = w.timeline(p_limit=2)
    second = w.timeline(p_limit=2, p_before=first["events"][-1]["occurred_at"])
    assert [e["occurred_at"][:10] for e in first["events"] + second["events"]] == ["2026-01-14", "2026-01-13", "2026-01-12", "2026-01-11"]


# ---------------------------------------------------------------------------------------------------------- read-only and privileges

def test_the_view_is_read_only_and_closed_to_the_api_roles(db):
    assert scalar(db, "select relkind from pg_class where oid = 'public.hall_timeline'::regclass") == "v"
    assert "security_invoker=true" in scalar(db, "select reloptions::text from pg_class where oid = 'public.hall_timeline'::regclass")
    for role in ("anon", "authenticated"):
        assert scalar(db, f"select has_table_privilege('{role}', 'public.hall_timeline', 'select')") == "f", role
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_hall_timeline(text, uuid, integer, timestamptz)', 'execute')") == "f", role
    assert scalar(db, "select has_table_privilege('service_role', 'public.hall_timeline', 'select')") == "t"
    assert scalar(db, "select has_table_privilege('service_role', 'public.hall_timeline', 'insert,update,delete')") == "f"
    acl = scalar(db, "select coalesce(proacl::text, '') from pg_proc where oid = 'public.gf_hall_timeline(text, uuid, integer, timestamptz)'::regprocedure")
    assert not re.search(r"(^|[{,])=X", acl), acl
    refused(db, "set role anon; select * from public.hall_timeline", "permission denied")
