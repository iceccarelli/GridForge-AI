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
from calibration_pg_rig import publication_gates_off
from registry_pg import (add_member, call, drop_database, make_database, needs_db, new_hall, new_org, new_site, ok, psql, refused, scalar, seed_actual_review,
                         seed_evidence, seed_observation, seed_package, seed_project, seed_project_event, seed_supplier_actual)

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
        pid, token = seed_project(self.db, "Hall project")
        psql(self.db, f"update projects set project_token = '{SECRET}-{uuid.uuid4().hex}' where id = '{pid}'")
        token = scalar(self.db, f"select project_token from projects where id = '{pid}'")
        ok(self.db, "gf_attach_project_to_hall", p_actor=actor, p_hall=hall, p_project_token=token)
        return pid

    def event(self, pid, etype, at, actor="engineer@a.example"):
        seed_project_event(self.db, pid, etype, at, actor, {"case_token": SECRET})

    def evidence(self, pid):
        return seed_evidence(self.db, pid, "verified", "bill.pdf", f"project-evidence/{SECRET}")

    def package(self, pid):
        return seed_package(self.db, pid)

    def actual(self, pid, pkg, resp, ev, supersedes=None, **dates):
        return seed_supplier_actual(self.db, pid, pkg, resp, ev, supersedes, **dates)

    def observation(self, pid, ev, observed_on="2026-03-01", observed=11.0, review=None):
        # The timeline is a read model of what the hall's projects HOLD; whether an observation could be published is not its business. Since 0056 a production
        # observation needs the organisation's consent and the project's completion milestone to be RECORDED, and a hall has observations that were recorded
        # before 0056 (no organisation, no consent) which its timeline must show as well. So the row is stored as such a database would hold it: only 0056's
        # insert gate is off, for this call. A consent and a milestone would add three project events of their own (evidence attached, evidence reviewed,
        # milestone attested) to a log whose exact content these tests assert.
        with publication_gates_off(self.db):
            return seed_observation(self.db, pid, ev, observed_on, observed, review)

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
    assert {e["kind"] for e in events} == {"input_recorded", "project_event", "supplier_date", "observation", "project_attached"}
    times = [e["occurred_at"] for e in events]
    assert times == sorted(times, reverse=True)                       # newest first
    assert [e["subject"] for e in events if e["kind"] == "supplier_date"] == ["on_site_date", "po_date"]
    # The two newest are the real events the fixtures' own steps append (the file's review, the observation's submission, both stamped now);
    # then the two the test wrote with fixed dates.
    assert [e["subject"] for e in events if e["kind"] == "project_event"] == ["observation_submitted", "evidence_reviewed", "rfq_generated", "project_created"]


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
    assert obs["origin"] == "submitted" and obs["evidence_class"] is None and "unreviewed" in obs["basis"].lower()    # not "observed": that word needs a file on an input


def test_a_reviewed_observation_and_a_reviewed_supplier_date_say_so(w):
    pid = w.project(w.hall, w.owner)
    ev = w.evidence(pid)
    w.observation(pid, ev, review="E5")
    pkg, resp = w.package(pid)
    actual = w.actual(pid, pkg, resp, ev, po_date="2026-02-10", dispatch_date="2026-03-01")
    seed_actual_review(w.db, actual, pid, ["po_date"])
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
    subjects = [e["subject"] for e in w.timeline()["events"] if e["kind"] == "project_event"]
    assert subjects == ["evidence_attached", "project_created"]
    assert all(e["project_id"] == mine for e in w.timeline()["events"])
    assert len([e for e in w.timeline(hall=w.hall2)["events"] if e["kind"] == "project_event"]) == 1
    loose = scalar(w.db, f"insert into projects (project_token, project_name) values ('{uuid.uuid4().hex}', 'unattached') returning id")
    w.event(loose, "project_created", "2026-01-13T09:00:00Z")
    assert len([e for e in w.timeline()["events"] if e["kind"] == "project_event"]) == 2


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
    assert len(out["events"]) == 3 and out["truncated"] is True and out["events"][1]["occurred_at"].startswith("2026-01-16") and out["next_cursor"]   # [0] is the attachment, made now
    out = w.timeline(p_limit=50)
    assert len(out["events"]) == 8 and out["truncated"] is False             # seven log lines and the attachment
    assert len(w.timeline(p_limit=100000)["events"]) == 8                     # an absurd limit is clamped, not obeyed
    assert len(w.timeline(p_limit=0)["events"]) == 1                          # and a silly one raised to the minimum
    assert out["next_cursor"] is None


# ---------------------------------------------------------------------------------------------------------- read-only and privileges

def test_the_view_is_read_only_and_closed_to_the_api_roles(db):
    assert scalar(db, "select relkind from pg_class where oid = 'public.hall_timeline'::regclass") == "v"
    assert "security_invoker=true" in scalar(db, "select reloptions::text from pg_class where oid = 'public.hall_timeline'::regclass")
    for role in ("anon", "authenticated"):
        assert scalar(db, f"select has_table_privilege('{role}', 'public.hall_timeline', 'select')") == "f", role
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_hall_timeline(text, uuid, integer, text)', 'execute')") == "f", role
    assert scalar(db, "select has_table_privilege('service_role', 'public.hall_timeline', 'select')") == "t"
    assert scalar(db, "select has_table_privilege('service_role', 'public.hall_timeline', 'insert,update,delete')") == "f"
    acl = scalar(db, "select coalesce(proacl::text, '') from pg_proc where oid = 'public.gf_hall_timeline(text, uuid, integer, text)'::regprocedure")
    assert not re.search(r"(^|[{,])=X", acl), acl
    refused(db, "set role anon; select * from public.hall_timeline", "permission denied")


# ====================================================================================================================
# Rework: attachments and detachments on the timeline, and paging that cannot skip an event
# ====================================================================================================================

def test_attaching_and_detaching_are_events_of_the_hall_and_detaching_stops_the_projects_log(w):
    pid = w.project(w.hall, w.owner)
    w.event(pid, "project_created", "2026-01-10T09:00:00Z")
    ev = w.timeline()["events"]
    kinds = [e["kind"] for e in ev]
    assert "project_attached" in kinds and kinds.count("project_event") == 1
    assert not [e for e in ev if e["subject"] == "project_attached_to_hall"]        # the project's own log line is not shown twice
    ok(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid)
    ev = w.timeline()["events"]
    assert sorted(e["kind"] for e in ev) == ["project_attached", "project_detached"]    # the log is gone; the fact of both stays
    assert all(e["origin"] == "recorded" and e["basis"] for e in ev)
    assert SECRET not in json.dumps(ev)
    w.event(pid, "evidence_attached", "2026-05-01T09:00:00Z")                          # later activity of the detached project never reappears here
    assert len(w.timeline()["events"]) == 2


def test_a_project_attached_to_another_hall_after_detaching_shows_there_not_here(w):
    pid = w.project(w.hall, w.owner)
    w.event(pid, "project_created", "2026-01-10T09:00:00Z")
    token = scalar(w.db, f"select project_token from projects where id = '{pid}'")
    ok(w.db, "gf_detach_project_from_hall", p_actor=w.owner, p_hall=w.hall, p_project=pid)
    ok(w.db, "gf_attach_project_to_hall", p_actor=w.owner, p_hall=w.hall2, p_project_token=token)
    assert "project_event" in [e["kind"] for e in w.timeline(hall=w.hall2)["events"]]
    assert "project_event" not in [e["kind"] for e in w.timeline()["events"]]


def _walk(w, limit, hall=None):
    seen, cursor, pages = [], None, 0
    while True:
        kw = dict(p_limit=limit) if cursor is None else dict(p_limit=limit, p_cursor=cursor)
        page = w.timeline(hall=hall, **kw)
        seen += [(e["occurred_at"], e["source_table"], e["source_id"], e["subject"]) for e in page["events"]]
        pages += 1
        assert pages < 500
        if not page["truncated"]:
            assert page["next_cursor"] is None
            return seen, pages
        assert isinstance(page["next_cursor"], str) and page["next_cursor"]
        cursor = page["next_cursor"]


@pytest.mark.parametrize("limit", [1, 2, 3, 7])
def test_walking_the_whole_timeline_by_cursor_yields_every_event_exactly_once_even_with_equal_timestamps(w, limit):
    pid = w.project(w.hall, w.owner)
    # twelve log rows with THE SAME timestamp, written in one transaction, and four a microsecond apart
    psql(w.db, "; ".join(f"insert into project_events (project_id, event_type, occurred_at, actor) values ('{pid}', 'evidence_attached', '2026-02-01T09:00:00.000000Z', 'x')" for _ in range(12)))
    for i in range(4):
        psql(w.db, f"insert into project_events (project_id, event_type, occurred_at, actor) values ('{pid}', 'evidence_attached', '2026-02-02T09:00:00.00000{i}Z', 'x')")
    psql(w.db, f"insert into project_events (project_id, event_type, actor) select '{pid}', 'evidence_attached', 'x' from generate_series(1, 5)")    # now(): one transaction, one clock
    ev = w.evidence(pid)
    pkg, resp = w.package(pid)
    w.actual(pid, pkg, resp, ev, po_date="2026-02-01", dispatch_date="2026-02-01", on_site_date="2026-02-01")   # three rows, same instant, same source id
    total = scalar(w.db, f"select count(*) from hall_timeline where hall_id = '{w.hall}'")
    seen, pages = _walk(w, limit)
    assert len(seen) == int(total) and len(set(seen)) == len(seen), (len(seen), total)
    assert pages == -(-int(total) // limit)
    assert {r[1:] for r in seen} == {r[1:] for r in scalar_rows(w, w.hall)}


def scalar_rows(w, hall):
    out = psql(w.db, "select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') || '+00:00', source_table, source_id, subject "
                     f"from hall_timeline where hall_id = '{hall}'").stdout.strip().splitlines()
    return [tuple(r.split("|")) for r in out]


def test_the_order_is_total_and_stable_the_same_walk_twice_gives_the_same_sequence(w):
    pid = w.project(w.hall, w.owner)
    psql(w.db, "; ".join(f"insert into project_events (project_id, event_type, occurred_at, actor) values ('{pid}', 'evidence_attached', '2026-02-01T09:00:00Z', 'x')" for _ in range(9)))
    assert _walk(w, 2)[0] == _walk(w, 2)[0] == _walk(w, 4)[0]


def test_the_cursor_is_built_by_the_database_keeps_microseconds_and_is_passed_back_verbatim(w):
    pid = w.project(w.hall, w.owner)
    for i in range(3):
        psql(w.db, f"insert into project_events (project_id, event_type, occurred_at, actor) values ('{pid}', 'evidence_attached', '2026-02-02T09:00:00.12345{i}Z', 'x')")
    page = w.timeline(p_limit=2)                                     # the attachment (made now) and the newest log line
    cur = json.loads(page["next_cursor"])
    assert cur["occurred_at"].endswith(".123452Z") or ".123452" in cur["occurred_at"]       # microsecond precision, not a millisecond Date round-trip
    assert set(cur) == {"occurred_at", "source_table", "source_id", "subject"}
    nxt = w.timeline(p_limit=1, p_cursor=page["next_cursor"])
    assert nxt["events"][0]["occurred_at"].startswith("2026-02-02T09:00:00.123451")


@pytest.mark.parametrize("cursor", ["", "not json", "[]", "{}", '{"occurred_at": "nope", "source_table": "x", "source_id": "y", "subject": "z"}',
                                    '{"occurred_at": "2026-01-01T00:00:00Z", "source_table": "x", "source_id": "not-a-uuid", "subject": "z"}'])
def test_a_cursor_that_is_not_one_of_ours_is_refused_not_a_crash(w, cursor):
    assert w.timeline(p_cursor=cursor) == {"ok": False, "reason": "invalid_cursor"}
