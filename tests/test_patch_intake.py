"""scripts/apply-inbox.sh, run against a throwaway repository.

This file exists because the intake script reverted a GOOD patch twice, on live
main, for a failure it did not cause.

What happened: a patch file was uploaded through the GitHub web interface, which
drops it at the repository ROOT. `tests/test_stack_consistency.py` correctly failed
on the stray file. The intake script then applied an unrelated, correct patch, ran
the whole suite, saw red, and rolled the good patch back — twice. The guard was
right and the script's reading of it was wrong: it could not tell "this patch broke
the repository" from "the repository was already broken".

Two fixes, both asserted here:

  1. The script sweeps `*.patch` off the root into inbox/ itself, because that is
     where the web uploader puts them and telling a human to `git mv` every time is
     not a workflow.
  2. The script records which tests were ALREADY failing before it applies anything,
     and rolls back only on NEW failures.

A shell script with no test is how a bug survives the patch that claims to fix it —
the same sentence is at the top of tests/test_deploy_script.py, for the same reason.
"""
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "apply-inbox.sh"


def run(cmd, cwd, **kw):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, **kw)


def git(repo, *args, check=True):
    r = run(["git", *args], repo)
    if check and r.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed:\n{r.stdout}\n{r.stderr}")
    return r


@pytest.fixture
def repo(tmp_path):
    """A minimal repository with the intake script and a tiny test suite of its own."""
    r = tmp_path / "repo"
    (r / "scripts").mkdir(parents=True)
    (r / "tests").mkdir()
    (r / "inbox").mkdir()
    (r / "scripts" / "apply-inbox.sh").write_text(SCRIPT.read_text())
    (r / "inbox" / "README.md").write_text("drop patches here\n")
    (r / "tests" / "test_green.py").write_text("def test_green():\n    assert True\n")
    (r / "src.txt").write_text("original\n")
    git(r, "init", "-q", "-b", "main")
    git(r, "config", "user.email", "t@example.com")
    git(r, "config", "user.name", "t")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "base")
    return r


def make_patch(repo, name, write, subject):
    """Commit `write`, export it as a patch, then rewind. Returns the patch text."""
    base = git(repo, "rev-parse", "HEAD").stdout.strip()
    for rel, text in write.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", subject)
    patch = git(repo, "format-patch", "-1", "--stdout").stdout
    git(repo, "reset", "-q", "--hard", base)
    assert patch.strip(), "format-patch produced nothing"
    return patch


def apply_inbox(repo, **env):
    """The throwaway repository has no environment of its own, so hand the script the
    interpreter running these tests. PYTEST is the script's documented override and
    the subject here is the rollback logic, not interpreter discovery — which
    test_the_script_refuses_to_run_without_a_working_test_runner covers separately."""
    e = {**os.environ, "PYTEST": f"{sys.executable} -m pytest", **env}
    return run(["bash", "scripts/apply-inbox.sh"], repo, env=e)


# --- the sweep -------------------------------------------------------------

def test_a_patch_uploaded_to_the_root_is_swept_into_the_inbox_and_applied(repo):
    """The GitHub web uploader has no folder picker. This is not the founder's
    mistake to correct by hand every time."""
    patch = make_patch(repo, "0001", {"src.txt": "changed\n"}, "change src")
    (repo / "0001-change.patch").write_text(patch)

    r = apply_inbox(repo)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (repo / "src.txt").read_text() == "changed\n"
    assert not list(repo.glob("*.patch")), "a patch survived at the root"
    assert not list((repo / "inbox").glob("*.patch")), "a patch survived in inbox/"


def test_a_patch_committed_at_the_root_is_moved_with_git_and_the_move_is_committed(repo):
    """This is the exact state live main was in: the patch was not merely sitting at
    the root, it was TRACKED there, pulled down from a web upload."""
    patch = make_patch(repo, "0001", {"src.txt": "changed\n"}, "change src")
    (repo / "0002-tracked.patch").write_text(patch)
    git(repo, "add", "0002-tracked.patch")
    git(repo, "commit", "-q", "-m", "uploaded via the web ui")

    r = apply_inbox(repo)
    assert r.returncode == 0, r.stdout + r.stderr
    tracked = git(repo, "ls-files").stdout.split()
    assert not [f for f in tracked if f.endswith(".patch")], (
        f"a patch is still tracked: {tracked}")
    assert (repo / "src.txt").read_text() == "changed\n"


def test_the_sweep_refuses_to_overwrite_an_existing_inbox_entry(repo):
    (repo / "inbox" / "0001-x.patch").write_text("not a real patch\n")
    (repo / "0001-x.patch").write_text("also not\n")
    r = apply_inbox(repo)
    assert r.returncode != 0
    assert "refusing to overwrite" in (r.stdout + r.stderr)


# --- the baseline ----------------------------------------------------------

def test_a_failure_that_predates_the_patch_does_not_roll_the_patch_back(repo):
    """The bug this whole file is about. The repository is already red; the patch is
    innocent; the patch must survive."""
    (repo / "tests" / "test_already_red.py").write_text(
        "def test_already_red():\n    assert False, 'red before anything was applied'\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "a pre-existing failure")

    patch = make_patch(repo, "0001", {"src.txt": "changed\n"}, "an innocent change")
    (repo / "inbox" / "0001-innocent.patch").write_text(patch)

    r = apply_inbox(repo)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    assert (repo / "src.txt").read_text() == "changed\n", "the innocent patch was reverted"
    assert "already failing" in out, "the pre-existing failure must still be reported"
    assert "test_already_red" in out, "and named, or it will not get fixed"


def test_a_patch_that_breaks_something_new_is_still_rolled_back(repo):
    """The baseline must not become a licence to ship red."""
    before = git(repo, "rev-parse", "HEAD").stdout.strip()
    patch = make_patch(repo, "0001", {
        "tests/test_broken.py": "def test_broken():\n    assert False\n",
    }, "a patch that breaks the suite")
    (repo / "inbox" / "0001-breaks.patch").write_text(patch)

    r = apply_inbox(repo)
    out = r.stdout + r.stderr
    assert r.returncode != 0, out
    assert git(repo, "rev-parse", "HEAD").stdout.strip() == before, "not rolled back"
    assert "reverted" in out


def test_a_patch_that_fixes_the_baseline_shrinks_it(repo):
    """If a patch repairs a pre-existing failure, the baseline must shrink — otherwise
    a later patch in the same run could reintroduce it unnoticed."""
    (repo / "tests" / "test_already_red.py").write_text(
        "def test_already_red():\n    assert False\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "a pre-existing failure")

    patch = make_patch(repo, "0001", {
        "tests/test_already_red.py": "def test_already_red():\n    assert True\n",
    }, "fix the pre-existing failure")
    (repo / "inbox" / "0001-fix.patch").write_text(patch)

    r = apply_inbox(repo)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    assert "tests pass" in out, out


# --- the runner itself -----------------------------------------------------

def test_the_script_refuses_to_run_without_a_working_test_runner(repo):
    """The defect this guards: `failures()` swallowed the runner's own error and
    returned an empty failure list, which reads as green. On a machine without
    pytest installed, the script would therefore apply and COMMIT a patch that
    breaks the entire suite — the gate protecting main reporting success because
    it never ran. A runner that cannot produce a verdict must stop the script."""
    patch = make_patch(repo, "0001", {
        "tests/test_broken.py": "def test_broken():\n    assert False\n",
    }, "a patch that breaks the suite")
    (repo / "inbox" / "0001-breaks.patch").write_text(patch)
    before = git(repo, "rev-parse", "HEAD").stdout.strip()

    r = apply_inbox(repo, PYTEST="definitely-not-a-real-pytest-binary")
    out = r.stdout + r.stderr
    assert r.returncode != 0, out
    assert "cannot run" in out, out
    assert git(repo, "rev-parse", "HEAD").stdout.strip() == before, (
        "the script committed a patch it never tested")
    assert (repo / "inbox" / "0001-breaks.patch").exists(), (
        "the patch was consumed by a run that could not test it")


def test_a_runner_that_crashes_stops_the_script_rather_than_reading_as_green(repo):
    """Exit codes above 1 (internal error, usage error, interrupted) are not a
    verdict about the code. Treating them as an empty failure list is the same bug
    wearing different clothes."""
    # Outside the repository on purpose: make_patch() runs `git add -A` followed by
    # `git reset --hard`, which would commit and then delete an untracked stub here.
    crasher = repo.parent / "crash.sh"
    crasher.write_text(textwrap.dedent("""\
        #!/usr/bin/env bash
        if [ "$1" = --version ]; then echo 'pytest 9.0.0'; exit 0; fi
        echo 'INTERNALERROR> boom' >&2
        exit 3
        """))
    crasher.chmod(0o755)
    patch = make_patch(repo, "0001", {"src.txt": "changed\n"}, "innocent")
    (repo / "inbox" / "0001-innocent.patch").write_text(patch)
    before = git(repo, "rev-parse", "HEAD").stdout.strip()

    r = apply_inbox(repo, PYTEST=str(crasher))
    out = r.stdout + r.stderr
    assert r.returncode != 0, out
    assert "exited 3" in out, out
    assert git(repo, "rev-parse", "HEAD").stdout.strip() == before, out


# --- the invariants the old test asserted, kept ----------------------------

def test_the_script_still_removes_the_patch_in_the_commit_that_applies_it(repo):
    patch = make_patch(repo, "0001", {"src.txt": "changed\n"}, "change src")
    (repo / "inbox" / "0001-change.patch").write_text(patch)
    assert apply_inbox(repo).returncode == 0
    # One commit, and no commit anywhere in history that added the patch file.
    log = git(repo, "log", "--name-only", "--pretty=format:").stdout
    assert "0001-change.patch" not in log, (
        "the instruction survived its own execution and is in the history")
