"""scripts/apply-rulesets.sh, run against a FAKE `gh`.

SAFETY FIRST, as in tests/test_deploy_script.py: the script is only ever pointed at a fake GitHub CLI that lives under pytest's tmp_path
(GH_BIN names it explicitly, it is also first on PATH under the name `gh`, and _assert_fake() refuses to run unless the binary the
script will use is the one this test wrote). Nothing here talks to GitHub, and a token in the environment is a dummy that must never
appear in the script's output.

The fake keeps a tiny in-memory GitHub: a JSON file of rulesets. Like the real API it ADDS fields the file never declared (id, source,
timestamps, parameter defaults, an integration id on each check) and returns lists in its own order, so the idempotence tests prove the
comparison is on normalised JSON of what the file declares, not on byte equality.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "apply-rulesets.sh"
RULESET_DIR = ROOT / ".github" / "rulesets"
TOKEN = "ghp_DUMMYTOKENMUSTNEVERBEPRINTED0123456789"

pytestmark = pytest.mark.skipif(shutil.which("jq") is None or shutil.which("bash") is None, reason="jq and bash are required by the script")

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
state_path = os.environ["FAKE_STATE"]
state = json.load(open(state_path))
body = None
log = {"argv": argv}
if "--input" in argv:
    body = json.load(open(argv[argv.index("--input") + 1]))
    log["body"] = body
open(os.environ["FAKE_LOG"], "a").write(json.dumps(log) + "\n")

def save():
    json.dump(state, open(state_path, "w"))

def decorate(rs, rid):
    """What the real API adds: fields nobody declared, defaults, a different ordering."""
    out = json.loads(json.dumps(rs))
    out.update({"id": rid, "source_type": "Repository", "source": "owner/name", "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-02T00:00:00Z", "current_user_can_bypass": "never", "node_id": "RRS_x"})
    for r in out["rules"]:
        p = r.get("parameters")
        if r["type"] == "pull_request":
            p.setdefault("required_reviewers", [])
        if r["type"] == "required_status_checks":
            for c in p["required_status_checks"]:
                c.setdefault("integration_id", 15368)
    out["rules"] = list(reversed(out["rules"]))
    return dict(reversed(list(out.items())))

if argv[:2] == ["auth", "status"]:
    sys.exit(int(os.environ.get("FAKE_AUTH_RC", "0")))
if argv[:2] == ["repo", "view"]:
    print(json.dumps({"nameWithOwner": os.environ.get("FAKE_REPO", "owner/name")}))
    sys.exit(0)
if argv[0] != "api":
    print("fake gh: unexpected command " + " ".join(argv), file=sys.stderr)
    sys.exit(97)
method = argv[argv.index("-X") + 1] if "-X" in argv else ("--method" in argv and argv[argv.index("--method") + 1]) or "GET"
endpoint = next(a for a in argv[1:] if not a.startswith("-") and (a.startswith("repos/")))
path = endpoint.split("?")[0].split("/")
# repos/OWNER/NAME[/rulesets[/ID]]
if len(path) == 3:
    print(json.dumps({"permissions": {"admin": os.environ.get("FAKE_ADMIN", "true") == "true"}}))
elif len(path) == 4 and path[3] == "rulesets" and method == "GET":
    print(json.dumps([{"id": r["id"], "name": r["body"]["name"], "source_type": r.get("source_type", "Repository")} for r in state["rulesets"]]))
elif len(path) == 4 and path[3] == "rulesets" and method == "POST":
    rid = max([r["id"] for r in state["rulesets"]] + [100]) + 1
    state["rulesets"].append({"id": rid, "body": body})
    save()
    print(json.dumps(decorate(body, rid)))
elif len(path) == 5 and path[3] == "rulesets" and method == "GET":
    r = next(r for r in state["rulesets"] if r["id"] == int(path[4]))
    print(json.dumps(decorate(r["body"], r["id"])))
elif len(path) == 5 and path[3] == "rulesets" and method == "PUT":
    r = next(r for r in state["rulesets"] if r["id"] == int(path[4]))
    r["body"] = body
    save()
    print(json.dumps(decorate(body, r["id"])))
else:
    print("fake gh: unexpected request " + method + " " + endpoint, file=sys.stderr)
    sys.exit(98)
'''


class Env:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.bin = tmp / "bin"
        self.bin.mkdir()
        self.gh = self.bin / "gh"
        self.gh.write_text(FAKE_GH)
        self.gh.chmod(self.gh.stat().st_mode | stat.S_IEXEC)
        self.state = tmp / "state.json"
        self.log = tmp / "gh.log"
        self.state.write_text(json.dumps({"rulesets": []}))

    def seed(self, name: str, body: dict, rid: int, source_type: str = "Repository") -> None:
        s = json.loads(self.state.read_text())
        s["rulesets"].append({"id": rid, "body": body, "source_type": source_type})
        self.state.write_text(json.dumps(s))

    def live(self) -> list[dict]:
        return json.loads(self.state.read_text())["rulesets"]

    def calls(self) -> list[dict]:
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def writes(self) -> list[dict]:
        return [c for c in self.calls() if "-X" in c["argv"] or "--method" in c["argv"] or "--input" in c["argv"]]

    def run(self, *args: str, env_extra: dict | None = None, ci: bool = False) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k not in {"CI", "GITHUB_ACTIONS", "GH_TOKEN", "GITHUB_TOKEN", "GH_BIN"}}
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "GH_BIN": str(self.gh),
            "GH_TOKEN": TOKEN,
            "FAKE_STATE": str(self.state),
            "FAKE_LOG": str(self.log),
        })
        if ci:
            env["CI"] = "true"
        env.update(env_extra or {})
        _assert_fake(env, self.gh)
        proc = subprocess.run(["bash", str(SCRIPT), *args], cwd=self.tmp, env=env, capture_output=True, text=True, timeout=60)
        assert TOKEN not in proc.stdout + proc.stderr, "the script printed the token"
        return proc


def _assert_fake(env: dict, fake: Path) -> None:
    """Refuse to run unless the CLI the script will use is the fake this test wrote, under tmp_path."""
    chosen = Path(env.get("GH_BIN", ""))
    assert chosen == fake and chosen.read_text() == FAKE_GH, "GH_BIN is not the fake gh"
    assert "pytest" in str(chosen) or "tmp" in str(chosen), f"the fake gh is not under a temporary directory: {chosen}"
    first = shutil.which("gh", path=env["PATH"])
    assert first == str(fake), f"`gh` on PATH resolves to {first}, not the fake"


@pytest.fixture()
def env(tmp_path):
    return Env(tmp_path)


def _file(name: str) -> dict:
    return json.loads((RULESET_DIR / name).read_text())


def test_default_is_a_dry_run_that_only_reads(env):
    p = env.run()
    assert p.returncode == 0, p.stderr
    assert "WOULD CREATE  protect-main" in p.stdout and "WOULD CREATE  protect-release" in p.stdout
    assert "Nothing was changed" in p.stdout
    assert env.writes() == [], env.writes()
    assert env.live() == []
    for c in env.calls():
        assert c["argv"][0] in {"auth", "repo", "api"}
        assert "POST" not in c["argv"] and "PUT" not in c["argv"] and "PATCH" not in c["argv"] and "DELETE" not in c["argv"]


def test_apply_creates_each_ruleset_with_exactly_the_file_body(env):
    p = env.run("--apply", "--repo", "owner/name")
    assert p.returncode == 0, p.stderr
    w = env.writes()
    assert [c["argv"][1:4] for c in w] == [["-X", "POST", "repos/owner/name/rulesets"]] * 2
    assert sorted(c["body"]["name"] for c in w) == ["protect-main", "protect-release"]
    for c in w:
        assert c["body"] == _file(c["body"]["name"] + ".json")
    assert {r["body"]["name"] for r in env.live()} == {"protect-main", "protect-release"}


def test_running_apply_twice_changes_nothing_the_second_time(env):
    assert env.run("--apply").returncode == 0
    first = len(env.writes())
    assert first == 2
    p = env.run("--apply")
    assert p.returncode == 0, p.stderr
    assert len(env.writes()) == first, "the second --apply wrote again although nothing differs"
    assert p.stdout.count("UNCHANGED") == 2 and "0 created, 0 updated, 2 unchanged" in p.stdout


def test_server_added_fields_and_ordering_do_not_count_as_drift(env):
    env.run("--apply")
    p = env.run("--verify")
    assert p.returncode == 0, p.stdout + p.stderr
    assert "2 match, 0 drifted" in p.stdout


def test_a_drifted_ruleset_is_updated_by_id_with_put_and_only_that_one(env):
    main = _file("protect-main.json")
    env.seed("protect-main", main, 7)
    stale = json.loads(json.dumps(_file("protect-release.json")))
    for r in stale["rules"]:
        if r["type"] == "required_status_checks":
            r["parameters"]["required_status_checks"] = r["parameters"]["required_status_checks"][:3]
    env.seed("protect-release", stale, 8)
    dry = env.run()
    assert "WOULD UPDATE  protect-release (id 8)" in dry.stdout and "UNCHANGED     protect-main (id 7)" in dry.stdout
    assert env.writes() == []
    p = env.run("--apply")
    assert p.returncode == 0, p.stderr
    w = env.writes()
    assert len(w) == 1 and w[0]["argv"][1:4] == ["-X", "PUT", "repos/owner/name/rulesets/8"]
    assert w[0]["body"] == _file("protect-release.json")
    assert env.run("--apply").returncode == 0 and len(env.writes()) == 1


def test_an_extra_required_check_in_the_live_ruleset_is_drift(env):
    drifted = json.loads(json.dumps(_file("protect-main.json")))
    for r in drifted["rules"]:
        if r["type"] == "required_status_checks":
            r["parameters"]["required_status_checks"].append({"context": "stress"})
    env.seed("protect-main", drifted, 3)
    env.seed("protect-release", _file("protect-release.json"), 4)
    v = env.run("--verify")
    assert v.returncode == 1 and "DRIFT         protect-main" in v.stdout
    assert "stress" in v.stdout, "the diff should show the extra context"
    assert env.writes() == []


def test_verify_reports_a_missing_ruleset_and_never_writes(env):
    env.seed("protect-main", _file("protect-main.json"), 3)
    v = env.run("--verify")
    assert v.returncode == 1
    assert "protect-release is missing" in v.stdout
    assert env.writes() == []


def test_rulesets_it_did_not_create_are_left_alone_never_deleted(env):
    other = {"name": "someone-elses", "target": "branch", "enforcement": "active", "rules": [{"type": "deletion"}],
             "conditions": {"ref_name": {"include": ["~ALL"], "exclude": []}}}
    env.seed("someone-elses", other, 55)
    env.seed("inherited", {**other, "name": "protect-main"}, 56, source_type="Organization")  # same name, but not this repository's
    p = env.run("--apply")
    assert p.returncode == 0
    assert "LEFT ALONE    someone-elses" in p.stdout
    assert all("DELETE" not in c["argv"] for c in env.calls())
    assert any(r["id"] == 55 for r in env.live()) and any(r["id"] == 56 for r in env.live())
    created = [c for c in env.writes() if c["argv"][2] == "POST"]
    assert {c["body"]["name"] for c in created} == {"protect-main", "protect-release"}, "an inherited same-named ruleset must not be updated"


def test_malformed_json_is_refused_before_any_request(env, tmp_path):
    d = tmp_path / "rs"
    d.mkdir()
    shutil.copy(RULESET_DIR / "protect-main.json", d)
    (d / "broken.json").write_text('{"name": "x", "rules": [')
    for flag in ([], ["--apply"], ["--verify"]):
        p = env.run(*flag, "--dir", str(d))
        assert p.returncode == 2, (flag, p.stdout, p.stderr)
        assert "broken.json is not valid JSON" in p.stderr
    assert env.calls() == [], "gh was called although a file was invalid"


def test_json_that_is_not_a_ruleset_is_refused(env, tmp_path):
    d = tmp_path / "rs"
    d.mkdir()
    (d / "bad.json").write_text(json.dumps({"name": "x", "target": "branch", "enforcement": "active", "rules": []}))
    p = env.run("--apply", "--dir", str(d))
    assert p.returncode == 2 and "is not a ruleset" in p.stderr
    assert env.calls() == []


def test_two_files_with_one_name_are_refused(env, tmp_path):
    d = tmp_path / "rs"
    d.mkdir()
    shutil.copy(RULESET_DIR / "protect-main.json", d / "a.json")
    shutil.copy(RULESET_DIR / "protect-main.json", d / "b.json")
    p = env.run("--dir", str(d))
    assert p.returncode == 2 and "both define the ruleset named" in p.stderr
    assert env.calls() == []


@pytest.mark.parametrize("args", [[], ["--apply"], ["--verify"], ["--yes-i-am-the-owner"], ["--apply", "--yes-i-am-the-owner", "--verify"]])
def test_under_ci_it_refuses_unless_both_apply_and_the_owner_flag_are_given(env, args):
    p = env.run(*args, ci=True)
    assert p.returncode in (2, 4), (args, p.stdout, p.stderr)
    assert env.calls() == [] and env.live() == []
    if "--verify" not in args:
        assert p.returncode == 4 and "refusing to run under CI" in p.stderr


def test_github_actions_alone_also_counts_as_ci(env):
    p = env.run("--apply", env_extra={"GITHUB_ACTIONS": "true"})
    assert p.returncode == 4 and env.calls() == []


def test_under_ci_with_both_flags_it_applies(env):
    p = env.run("--apply", "--yes-i-am-the-owner", ci=True)
    assert p.returncode == 0, p.stderr
    assert len(env.writes()) == 2


def test_ci_set_to_false_is_not_ci(env):
    assert env.run(env_extra={"CI": "false"}).returncode == 0


def test_apply_and_verify_together_are_refused(env):
    p = env.run("--apply", "--verify")
    assert p.returncode == 2 and env.calls() == []


def test_a_login_without_admin_can_read_but_not_apply(env):
    p = env.run(env_extra={"FAKE_ADMIN": "false"})
    assert p.returncode == 0 and "not an administrator" in p.stderr
    a = env.run("--apply", env_extra={"FAKE_ADMIN": "false"})
    assert a.returncode == 3 and "not an administrator" in a.stderr
    assert env.writes() == []


def test_an_unauthenticated_gh_stops_everything(env):
    p = env.run("--apply", env_extra={"FAKE_AUTH_RC": "1"})
    assert p.returncode == 3 and "not authenticated" in p.stderr
    assert env.writes() == []


def test_the_repository_comes_from_gh_repo_view_or_from_repo(env):
    env.run("--apply", env_extra={"FAKE_REPO": "acme/widgets"})
    assert all(c["argv"][3] == "repos/acme/widgets/rulesets" for c in env.writes())
    (env.tmp / "again").mkdir()
    other = Env(env.tmp / "again")
    other.run("--apply", "--repo", "x/y", env_extra={"FAKE_REPO": "acme/widgets"})
    assert all(c["argv"][3] == "repos/x/y/rulesets" for c in other.writes())
    bad = env.run("--repo", "not-a-repo")
    assert bad.returncode == 2


def test_unknown_arguments_are_refused(env):
    assert env.run("--delete-everything").returncode == 2
    assert env.calls() == []


def test_the_script_never_enables_nor_mentions_deleting_with_gh_and_never_uses_xtrace():
    src = SCRIPT.read_text()
    assert "set -euo pipefail" in src
    assert "DELETE" not in src and "-X DELETE" not in src and "--method DELETE" not in src
    assert "set -x" not in src and "xtrace" not in src, "xtrace would print the environment's token"
    assert "GH_TOKEN" not in src and "GITHUB_TOKEN" not in src


def test_the_header_records_why_the_rulesets_say_what_they_say():
    head = SCRIPT.read_text().split("set -euo pipefail")[0]
    for needle in ("stress", "Vercel", "required_linear_history", "merge commits", "dry run", "--yes-i-am-the-owner", "--verify", "never deletes"):
        assert needle.lower() in head.lower(), f"the script header no longer explains: {needle}"


def test_nothing_in_the_workflows_runs_the_applier():
    for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
        assert "apply-rulesets" not in wf.read_text(), f"{wf.name} would change branch protection from CI"


@pytest.mark.parametrize("args", [["--apply", "--dry-run"], ["--dry-run", "--apply"]])
def test_dry_run_and_apply_together_are_refused_in_either_order_and_write_nothing(env, args):
    p = env.run(*args)
    assert p.returncode == 2, (args, p.stdout, p.stderr)
    assert "mutually exclusive" in p.stderr
    assert env.calls() == [] and env.writes() == [] and env.live() == []


def test_dry_run_flag_alone_and_with_verify_stay_read_only(env):
    assert env.run("--dry-run").returncode == 0
    assert env.run("--dry-run", "--verify").returncode == 1  # nothing applied yet: drift, but still no write
    assert env.writes() == []


def _bad_dir(tmp_path: Path, mutate) -> Path:
    d = tmp_path / "rs"
    d.mkdir()
    rs = json.loads((RULESET_DIR / "protect-main.json").read_text())
    mutate(rs)
    (d / "x.json").write_text(json.dumps(rs))
    return d


@pytest.mark.parametrize("label, mutate, message", [
    ("unknown rule type", lambda rs: rs["rules"].append({"type": "delete_everything"}), "type GitHub does not know"),
    ("typo in a known type", lambda rs: rs["rules"].__setitem__(0, {"type": "non_fastforward"}), "type GitHub does not know"),
    ("pull_request without parameters", lambda rs: [r for r in rs["rules"] if r["type"] == "pull_request"][0].pop("parameters"), "malformed parameters"),
    ("bad merge method", lambda rs: [r for r in rs["rules"] if r["type"] == "pull_request"][0]["parameters"].update(allowed_merge_methods=["fast-forward"]), "malformed parameters"),
    ("review count as text", lambda rs: [r for r in rs["rules"] if r["type"] == "pull_request"][0]["parameters"].update(required_approving_review_count="0"), "malformed parameters"),
    ("empty required checks", lambda rs: [r for r in rs["rules"] if r["type"] == "required_status_checks"][0]["parameters"].update(required_status_checks=[]), "malformed parameters"),
    ("check without context", lambda rs: [r for r in rs["rules"] if r["type"] == "required_status_checks"][0]["parameters"]["required_status_checks"].append({"integration_id": 1}), "malformed parameters"),
])
def test_a_rule_github_would_refuse_is_refused_locally_before_any_request(env, tmp_path, label, mutate, message):
    d = _bad_dir(tmp_path, mutate)
    for flag in ([], ["--apply"]):
        p = env.run(*flag, "--dir", str(d))
        assert p.returncode == 2, (label, p.stdout, p.stderr)
        assert message in p.stderr
    assert env.calls() == []


@pytest.mark.parametrize("repo", ["owner", "owner/", "/name", "a/b/c", "a b/c", "a/b;rm -rf", "a/$(id)", "own er/name", "a/b\nc"])
def test_a_malformed_repo_is_refused_before_any_request(env, repo):
    p = env.run("--repo", repo)
    assert p.returncode == 2 and "must look like OWNER/NAME" in p.stderr
    assert not any(c["argv"][0] == "api" for c in env.calls())


def test_the_target_and_the_plan_are_printed_before_the_first_write(env):
    p = env.run("--apply", "--repo", "owner/name")
    out = p.stdout
    assert out.index("target repository: owner/name") < out.index("plan for owner/name:") < out.index("CREATED")
    assert "create  protect-main  (POST)" in out and "create  protect-release  (POST)" in out
    # every GET that builds the plan happens before the first write
    kinds = ["w" if ("-X" in c["argv"]) else "r" for c in env.calls() if c["argv"][0] == "api"]
    assert kinds.index("w") > max(i for i, k in enumerate(kinds) if k == "r" and i < kinds.index("w")), kinds


def test_bash_older_than_4_is_refused_first_thing():
    src = SCRIPT.read_text()
    body = src.split("set -euo pipefail", 1)[1]
    first_statements = [ln for ln in body.splitlines() if ln.strip() and not ln.lstrip().startswith("#")][:3]
    assert any("BASH_VERSINFO" in ln for ln in first_statements), first_statements


def test_the_header_states_the_limits_honestly():
    head = SCRIPT.read_text().split("set -euo pipefail")[0].lower()
    for needle in ("422", "idempotent", "only after main is green", "first fully green run", "release/1.2/hotfix", "not covered", "do_not_enforce_on_create".lower(), "cannot be deleted"):
        assert needle in head, f"the script header no longer says: {needle}"
