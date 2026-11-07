"""0049_site_registry.sql against a real PostgreSQL: organisations, their members, sites and halls.

Each test is a way the registry could lie or leak: a viewer who writes, a member of one organisation who reads or writes another's
sites, the last owner removed, a membership restored after removal, a site silently relabelled from `test` to `production`, a
history table emptied. The role checks are asserted INSIDE the functions (the application checks first; the database does not
trust it), and the API roles are shown to reach nothing.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none.
"""
import re
import uuid

import pytest
from registry_pg import (add_member, call, drop_database, make_database, needs_db, new_hall, new_org, new_site, ok, psql, q,
                         reason, refused, scalar)

pytestmark = needs_db

OWNER = "owner@hall-a.example"
EDITOR = "editor@hall-a.example"
VIEWER = "viewer@hall-a.example"
OTHER = "someone@hall-b.example"


@pytest.fixture(autouse=True)
def _fresh_people(monkeypatch):
    """New addresses for every test: the database is shared by the module (applying fifty migrations per test would take minutes), and an
    address may only create twenty organisations, so a fixed one would eventually be refused for a reason unrelated to the test."""
    tag = uuid.uuid4().hex[:8]
    for name, local in (("OWNER", "owner"), ("EDITOR", "editor"), ("VIEWER", "viewer"), ("OTHER", "someone")):
        monkeypatch.setitem(globals(), name, f"{local}-{tag}@hall-{'b' if name == 'OTHER' else 'a'}.example")


@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


@pytest.fixture()
def team(db):
    """A fresh organisation A with an owner, an editor and a viewer; and an unrelated organisation B with its own owner."""
    a = new_org(db, OWNER)
    add_member(db, a, OWNER, EDITOR, "editor")
    add_member(db, a, OWNER, VIEWER, "viewer")
    b = new_org(db, OTHER)
    return a, b


# ---------------------------------------------------------------------------------------------------------- creation

def test_the_creator_becomes_the_owner_and_the_email_is_stored_lower_cased(db):
    r = ok(db, "gf_create_org", p_actor="  Boss@Hall-A.Example ", p_name="Acme Compute")
    rows = scalar(db, f"select email || '/' || role from organisation_members where org_id = '{r['org_id']}' and removed_at is null")
    assert rows == "boss@hall-a.example/owner"
    assert scalar(db, f"select created_by from organisations where id = '{r['org_id']}'") == "boss@hall-a.example"


@pytest.mark.parametrize("actor", ["", "no-at-sign", "a b@x.example", "@x.example", None])
def test_an_actor_that_is_not_an_email_is_refused(db, actor):
    assert reason(db, "gf_create_org", p_actor=actor, p_name="X") == "invalid_actor"


@pytest.mark.parametrize("name", ["", "   ", "x" * 121, "bad\u0007name"])
def test_an_organisation_name_is_bounded(db, name):
    assert reason(db, "gf_create_org", p_actor=OWNER, p_name=name) == "invalid_name"


def test_one_creator_cannot_make_two_organisations_of_the_same_name_case_insensitively(db):
    actor = f"dupe-{uuid.uuid4().hex[:6]}@hall-a.example"
    ok(db, "gf_create_org", p_actor=actor, p_name="Northern Compute")
    assert reason(db, "gf_create_org", p_actor=actor, p_name="northern COMPUTE") == "name_taken"
    ok(db, "gf_create_org", p_actor=f"other-{uuid.uuid4().hex[:6]}@x.example", p_name="Northern Compute")


def test_an_actor_cannot_create_organisations_without_bound(db):
    actor = f"busy-{uuid.uuid4().hex[:6]}@hall-a.example"
    for i in range(20):
        ok(db, "gf_create_org", p_actor=actor, p_name=f"Org {i}")
    assert reason(db, "gf_create_org", p_actor=actor, p_name="Org 21") == "limit"


# ---------------------------------------------------------------------------------------------------------- roles

def test_a_viewer_can_read_but_never_write(db, team):
    a, _ = team
    site = new_site(db, EDITOR, a)
    hall = new_hall(db, EDITOR, site)
    assert reason(db, "gf_create_site", p_actor=VIEWER, p_org=a, p_name="V", p_country="DE", p_data_origin="test") == "forbidden"
    assert reason(db, "gf_create_hall", p_actor=VIEWER, p_site=site, p_label="V") == "forbidden"
    assert reason(db, "gf_org_add_member", p_actor=VIEWER, p_org=a, p_email="x@y.example", p_role="viewer") == "forbidden"
    assert [s["id"] for s in ok(db, "gf_list_sites", p_actor=VIEWER, p_org=a)["sites"]] == [site]
    assert [h["id"] for h in ok(db, "gf_list_halls", p_actor=VIEWER, p_site=site)["halls"]] == [hall]
    assert {m["email"] for m in ok(db, "gf_org_members", p_actor=VIEWER, p_org=a)["members"]} == {OWNER, EDITOR, VIEWER}


def test_an_editor_builds_the_registry_but_does_not_manage_members(db, team):
    a, _ = team
    site = new_site(db, EDITOR, a)
    new_hall(db, EDITOR, site)
    assert reason(db, "gf_org_add_member", p_actor=EDITOR, p_org=a, p_email="x@y.example", p_role="viewer") == "forbidden"
    member = scalar(db, f"select id from organisation_members where org_id = '{a}' and email = '{VIEWER}'")
    assert reason(db, "gf_org_remove_member", p_actor=EDITOR, p_org=a, p_member=member) == "forbidden"


def test_an_owner_adds_and_removes_members_and_a_removed_member_loses_access_at_once(db, team):
    a, _ = team
    site = new_site(db, OWNER, a)
    m = add_member(db, a, OWNER, "New.Hire@Hall-A.Example", "editor")
    assert scalar(db, f"select email from organisation_members where id = '{m['member_id']}'") == "new.hire@hall-a.example"
    new_hall(db, "new.hire@hall-a.example", site)
    ok(db, "gf_org_remove_member", p_actor=OWNER, p_org=a, p_member=m["member_id"])
    assert reason(db, "gf_create_hall", p_actor="new.hire@hall-a.example", p_site=site, p_label="late") == "not_a_member"
    assert reason(db, "gf_list_sites", p_actor="new.hire@hall-a.example", p_org=a) == "not_a_member"


def test_adding_the_same_active_member_twice_is_refused_and_an_unknown_role_is_refused(db, team):
    a, _ = team
    assert reason(db, "gf_org_add_member", p_actor=OWNER, p_org=a, p_email=EDITOR, p_role="viewer") == "already_member"
    assert reason(db, "gf_org_add_member", p_actor=OWNER, p_org=a, p_email="x@y.example", p_role="admin") == "invalid_role"
    assert reason(db, "gf_org_add_member", p_actor=OWNER, p_org=a, p_email="not-an-email", p_role="viewer") == "invalid_email"


def test_a_removed_member_can_be_added_again_as_a_new_row_never_by_reviving_the_old_one(db, team):
    a, _ = team
    old = scalar(db, f"select id from organisation_members where org_id = '{a}' and email = '{VIEWER}'")
    ok(db, "gf_org_remove_member", p_actor=OWNER, p_org=a, p_member=old)
    new = add_member(db, a, OWNER, VIEWER, "viewer")["member_id"]
    assert new != old
    assert scalar(db, f"select count(*) from organisation_members where org_id = '{a}' and email = '{VIEWER}'") == "2"
    refused(db, f"update organisation_members set removed_at = null where id = '{old}'", "cannot be restored")


# ---------------------------------------------------------------------------------------------------------- last owner

def test_the_last_owner_cannot_be_removed_by_anyone(db):
    org = new_org(db, OWNER)
    owner_row = scalar(db, f"select id from organisation_members where org_id = '{org}' and email = '{OWNER}'")
    assert reason(db, "gf_org_remove_member", p_actor=OWNER, p_org=org, p_member=owner_row) == "last_owner"
    # ...and the table itself refuses it too, so a caller that skips the function cannot orphan the organisation.
    refused(db, f"update organisation_members set removed_at = now() where id = '{owner_row}'", "last owner")
    assert scalar(db, f"select count(*) from organisation_members where org_id = '{org}' and removed_at is null") == "1"


def test_with_two_owners_one_may_leave_and_then_the_other_is_the_last(db):
    org = new_org(db, OWNER)
    second = add_member(db, org, OWNER, "second@hall-a.example", "owner")["member_id"]
    ok(db, "gf_org_remove_member", p_actor="second@hall-a.example", p_org=org, p_member=second)   # leaving is always allowed
    first = scalar(db, f"select id from organisation_members where org_id = '{org}' and email = '{OWNER}'")
    assert reason(db, "gf_org_remove_member", p_actor=OWNER, p_org=org, p_member=first) == "last_owner"


def test_a_member_can_leave_an_organisation_themselves_but_cannot_remove_others(db, team):
    a, _ = team
    mine = scalar(db, f"select id from organisation_members where org_id = '{a}' and email = '{VIEWER}' and removed_at is null")
    editor_row = scalar(db, f"select id from organisation_members where org_id = '{a}' and email = '{EDITOR}' and removed_at is null")
    assert reason(db, "gf_org_remove_member", p_actor=VIEWER, p_org=a, p_member=editor_row) == "forbidden"
    ok(db, "gf_org_remove_member", p_actor=VIEWER, p_org=a, p_member=mine)


# ---------------------------------------------------------------------------------------------------------- isolation

def test_a_member_of_organisation_a_can_neither_read_nor_write_organisation_b(db, team):
    a, b = team
    site_b = new_site(db, OTHER, b, name="Secret Campus")
    hall_b = new_hall(db, OTHER, site_b, "Hall B1")
    for actor in (OWNER, EDITOR, VIEWER):                        # even A's OWNER
        assert reason(db, "gf_list_sites", p_actor=actor, p_org=b) == "not_a_member"
        assert reason(db, "gf_list_halls", p_actor=actor, p_site=site_b) == "not_a_member"
        assert reason(db, "gf_org_members", p_actor=actor, p_org=b) == "not_a_member"
        assert reason(db, "gf_create_site", p_actor=actor, p_org=b, p_name="Intruder", p_country="DE", p_data_origin="test") == "not_a_member"
        assert reason(db, "gf_create_hall", p_actor=actor, p_site=site_b, p_label="Intruder") == "not_a_member"
        assert reason(db, "gf_org_add_member", p_actor=actor, p_org=b, p_email=actor, p_role="owner") == "not_a_member"
    member_b = scalar(db, f"select id from organisation_members where org_id = '{b}' and email = '{OTHER}'")
    assert reason(db, "gf_org_remove_member", p_actor=OWNER, p_org=b, p_member=member_b) == "not_a_member"
    # the unscoped listings carry only the caller's own organisations, never B's
    mine = ok(db, "gf_list_sites", p_actor=OWNER)["sites"]
    assert site_b not in [s["id"] for s in mine]
    assert hall_b not in str(mine)
    assert b not in [o["id"] for o in ok(db, "gf_my_orgs", p_actor=OWNER)["orgs"]]
    assert scalar(db, f"select count(*) from sites where org_id = '{b}'") == "1"
    assert scalar(db, f"select count(*) from organisation_members where org_id = '{b}' and removed_at is null") == "1"


def test_a_membership_in_b_does_not_follow_a_removed_member_of_a(db, team):
    a, b = team
    add_member(db, b, OTHER, EDITOR, "viewer")                  # EDITOR is an editor in A and only a viewer in B
    site_b = new_site(db, OTHER, b)
    assert reason(db, "gf_create_hall", p_actor=EDITOR, p_site=site_b, p_label="nope") == "forbidden"
    assert ok(db, "gf_list_halls", p_actor=EDITOR, p_site=site_b)["halls"] == []


def test_an_unknown_id_is_not_found_not_a_crash(db):
    ghost = str(uuid.uuid4())
    assert reason(db, "gf_list_sites", p_actor=OWNER, p_org=ghost) == "not_found"
    assert reason(db, "gf_list_halls", p_actor=OWNER, p_site=ghost) == "not_found"
    assert reason(db, "gf_create_hall", p_actor=OWNER, p_site=ghost, p_label="x") == "not_found"
    assert reason(db, "gf_org_members", p_actor=OWNER, p_org=ghost) == "not_found"


# ---------------------------------------------------------------------------------------------------------- sites and halls

def test_a_site_declares_what_kind_of_data_it_holds_and_that_is_required_and_closed(db, team):
    a, _ = team
    for bad in (None, "", "prod", "PRODUCTION", "demo"):
        assert reason(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="S" + uuid.uuid4().hex[:4], p_country="DE", p_data_origin=bad) == "invalid_data_origin"
    for good in ("production", "test", "synthetic"):
        ok(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="S" + uuid.uuid4().hex[:4], p_country="DE", p_data_origin=good)
    refused(db, f"insert into sites (org_id, name, data_origin, created_by) values ('{a}', 'raw', null, '{OWNER}')", "null value")
    refused(db, f"insert into sites (org_id, name, data_origin, created_by) values ('{a}', 'raw', 'demo', '{OWNER}')", "violates check")


@pytest.mark.parametrize("country", ["Germany", "d", "D1", "DEU", "d-"])
def test_a_country_is_an_iso_alpha_2_code_or_absent(db, team, country):
    a, _ = team
    assert reason(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="C" + uuid.uuid4().hex[:4], p_country=country, p_data_origin="test") == "invalid_country"


def test_a_lower_case_country_code_is_normalised_and_none_is_allowed(db, team):
    a, _ = team
    s = ok(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="C" + uuid.uuid4().hex[:4], p_country="ie", p_data_origin="test")["site_id"]
    assert scalar(db, f"select country from sites where id = '{s}'") == "IE"
    s2 = ok(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="C" + uuid.uuid4().hex[:4], p_country=None, p_data_origin="test")["site_id"]
    assert scalar(db, f"select coalesce(country, 'none') from sites where id = '{s2}'") == "none"


def test_a_site_name_is_unique_per_organisation_case_insensitively_but_free_across_organisations(db, team):
    a, b = team
    ok(db, "gf_create_site", p_actor=OWNER, p_org=a, p_name="Dublin Campus", p_country="IE", p_data_origin="test")
    assert reason(db, "gf_create_site", p_actor=EDITOR, p_org=a, p_name="dublin CAMPUS", p_country="IE", p_data_origin="test") == "name_taken"
    ok(db, "gf_create_site", p_actor=OTHER, p_org=b, p_name="Dublin Campus", p_country="IE", p_data_origin="test")


def test_a_hall_label_is_unique_per_site_case_insensitively_but_free_across_sites(db, team):
    a, _ = team
    s1, s2 = new_site(db, OWNER, a), new_site(db, OWNER, a)
    ok(db, "gf_create_hall", p_actor=OWNER, p_site=s1, p_label="Hall 1")
    assert reason(db, "gf_create_hall", p_actor=OWNER, p_site=s1, p_label="hall 1") == "label_taken"
    ok(db, "gf_create_hall", p_actor=OWNER, p_site=s2, p_label="Hall 1")


def test_a_hall_label_is_bounded(db, team):
    a, _ = team
    s = new_site(db, OWNER, a)
    for bad in ("", "  ", "h" * 121):
        assert reason(db, "gf_create_hall", p_actor=OWNER, p_site=s, p_label=bad) == "invalid_label"


def test_the_listing_of_halls_carries_the_site_and_its_data_origin(db, team):
    a, _ = team
    s = new_site(db, OWNER, a, origin="production")
    h = new_hall(db, OWNER, s)
    out = ok(db, "gf_list_halls", p_actor=VIEWER, p_site=s)
    assert out["site"]["data_origin"] == "production" and out["halls"][0]["id"] == h


# ---------------------------------------------------------------------------------------------------------- what cannot change

def test_a_membership_row_is_never_deleted_and_its_identity_never_changes(db, team):
    a, _ = team
    row = scalar(db, f"select id from organisation_members where org_id = '{a}' and email = '{EDITOR}'")
    refused(db, f"delete from organisation_members where id = '{row}'", "never deleted")
    refused(db, f"update organisation_members set role = 'owner' where id = '{row}'", "identity cannot change")
    refused(db, f"update organisation_members set email = 'x@y.example' where id = '{row}'", "identity cannot change")


def test_a_sites_origin_and_owner_cannot_be_rewritten_and_nothing_is_deleted(db, team):
    a, b = team
    s = new_site(db, OWNER, a, origin="test")
    h = new_hall(db, OWNER, s)
    refused(db, f"update sites set data_origin = 'production' where id = '{s}'", "cannot change")
    refused(db, f"update sites set org_id = '{b}' where id = '{s}'", "cannot change")
    refused(db, f"update halls set site_id = (select id from sites where org_id = '{b}' limit 1) where id = '{h}'", "cannot change")
    refused(db, f"delete from halls where id = '{h}'", "never deleted")
    refused(db, f"delete from sites where id = '{s}'", "never deleted")
    refused(db, f"delete from organisations where id = '{a}'", "never deleted")


@pytest.mark.parametrize("table", ["organisations", "organisation_members", "sites", "halls"])
def test_no_registry_table_can_be_truncated_even_by_the_owner_role(db, table):
    refused(db, f"truncate {table} cascade", "append-only")


# ---------------------------------------------------------------------------------------------------------- privileges

REGISTRY_TABLES = ["organisations", "organisation_members", "sites", "halls"]
REGISTRY_RPCS = [
    "gf_create_org(text, text)", "gf_my_orgs(text)", "gf_org_members(text, uuid)", "gf_org_add_member(text, uuid, text, text)",
    "gf_org_remove_member(text, uuid, uuid)", "gf_create_site(text, uuid, text, text, text)", "gf_list_sites(text, uuid)",
    "gf_create_hall(text, uuid, text)", "gf_list_halls(text, uuid)",
]


def test_row_level_security_is_on_with_no_policies_so_only_the_service_role_reaches_the_tables(db):
    for t in REGISTRY_TABLES:
        assert scalar(db, f"select relrowsecurity from pg_class where oid = 'public.{t}'::regclass") == "t", t
        assert scalar(db, f"select count(*) from pg_policies where schemaname = 'public' and tablename = '{t}'") == "0", t


@pytest.mark.parametrize("role", ["anon", "authenticated"])
def test_the_api_roles_hold_no_privilege_on_the_tables_or_the_functions(db, role):
    for t in REGISTRY_TABLES:
        assert scalar(db, f"select has_table_privilege('{role}', 'public.{t}', 'select,insert,update,delete')") == "f", (role, t)
    for f in REGISTRY_RPCS:
        assert scalar(db, f"select has_function_privilege('{role}', 'public.{f}', 'execute')") == "f", (role, f)
    refused(db, f"set role {role}; select public.gf_create_org(p_actor => 'x@y.example', p_name => 'N')", "permission denied")


def test_the_service_role_can_execute_every_function_and_cannot_truncate(db):
    for f in REGISTRY_RPCS:
        assert scalar(db, f"select has_function_privilege('service_role', 'public.{f}', 'execute')") == "t", f
    for t in REGISTRY_TABLES:
        assert scalar(db, f"select has_table_privilege('service_role', 'public.{t}', 'truncate')") == "f", t


def test_the_functions_are_not_executable_by_public(db):
    for f in REGISTRY_RPCS:
        acl = scalar(db, f"select coalesce(proacl::text, '') from pg_proc where oid = 'public.{f}'::regprocedure")
        assert not re.search(r"(^|[{,])=X", acl), (f, acl)       # an entry with an empty grantee is PUBLIC
