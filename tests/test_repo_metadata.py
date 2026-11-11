"""Repository metadata that nothing else exercises: the font licences we are bound by, and the dependency-update configuration.

No YAML dependency (see tests/workflow_jobs.py): dependabot.yml is a small, flat file and is read as one.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---- fonts: SIL Open Font License notices ---------------------------------------------------------------------------------------

#: Every directory that ships font files must ship the licence next to them (OFL 1.1 condition 2: the copyright notice and the licence
#: travel with every copy). app/fonts is what the site's CSS embeds; public/reference/fonts is what the reference pages serve.
FONT_DIRS = [ROOT / "app" / "fonts", ROOT / "public" / "reference" / "fonts"]
#: filename prefix -> (family, a string every notice for that family must carry)
FAMILIES = {
    "inter": ("Inter", "Inter Project Authors (https://github.com/rsms/inter)"),
    "jetbrains-mono": ("JetBrains Mono", "github.com/JetBrains/JetBrainsMono"),
}
FONT_SUFFIXES = {".woff2", ".woff", ".ttf", ".otf", ".eot"}


def _ofl(d: Path) -> bytes:
    return (d / "OFL.txt").read_bytes()


def test_each_font_directory_ships_its_licence():
    for d in FONT_DIRS:
        assert (d / "OFL.txt").is_file(), f"{d.relative_to(ROOT)} ships fonts without OFL.txt"


def test_the_two_licence_copies_are_byte_identical():
    a, b = (_ofl(d) for d in FONT_DIRS)
    assert a == b, "app/fonts/OFL.txt and public/reference/fonts/OFL.txt differ; they are one notice in two places"


#: The copyright statements EXACTLY as the upstream repositories give them (rsms/inter LICENSE.txt, JetBrains/JetBrainsMono OFL.txt,
#: fetched 2026-11-08). Neither upstream declares a Reserved Font Name, so there is no such line to carry.
INTER_COPYRIGHT = "Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)"
JETBRAINS_COPYRIGHT = "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)"


def test_the_notice_opens_by_naming_both_families_and_their_upstream_repositories():
    text = _ofl(FONT_DIRS[0]).decode("utf-8")
    head = "\n".join(text.splitlines()[:12])
    assert text.startswith("Font licences\n")
    for needle in ("Inter", "JetBrains Mono", "SIL Open Font License, Version 1.1",
                   "https://github.com/rsms/inter", "https://github.com/JetBrains/JetBrainsMono"):
        assert needle in head, f"the preface no longer says: {needle}"
    assert text.endswith("\n"), "a trailing newline keeps the file diff-clean"
    assert "\r" not in text, "CRLF line endings"


def test_each_family_carries_its_upstream_copyright_line_and_the_whole_canonical_licence():
    text = _ofl(FONT_DIRS[0]).decode("utf-8")
    lines = text.splitlines()
    assert lines.count(INTER_COPYRIGHT) == 1 and lines.count(JETBRAINS_COPYRIGHT) == 1, "a copyright line differs from upstream"
    sections = re.split(r"^={80}\n(INTER|JETBRAINS MONO)\n={80}\n", text, flags=re.M)
    assert sections[1::2] == ["INTER", "JETBRAINS MONO"], sections[1::2]
    for body, copyright_line in zip(sections[2::2], (INTER_COPYRIGHT, JETBRAINS_COPYRIGHT)):
        assert body.lstrip().startswith(copyright_line), "each section opens with its family's own copyright line"
        assert "This Font Software is licensed under the SIL Open Font License, Version 1.1." in body
        assert "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007" in body
        for section in ("PREAMBLE", "DEFINITIONS", "TERMINATION", "DISCLAIMER"):
            assert section in body, f"{section} missing from a licence body"
        # The canonical OFL 1.1 wording. An MIT-style paragraph ("copy, modify, merge, publish, distribute, and/or sell") and
        # "DEALINGS IN THE SOFTWARE" were what the first hand-written notice carried, and that misstated the licence.
        assert "to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware" in body
        assert "OTHER DEALINGS IN THE FONT SOFTWARE." in body
        assert "publish, distribute, and/or sell" not in body and "DEALINGS IN THE SOFTWARE" not in body.replace("FONT SOFTWARE", "")


def test_only_the_families_the_notice_covers_are_shipped():
    """A new font dropped into either directory without a notice would ship under a licence nobody read."""
    for d in FONT_DIRS:
        fonts = [p for p in d.iterdir() if p.suffix.lower() in FONT_SUFFIXES]
        assert fonts, f"{d.relative_to(ROOT)} has no fonts; delete its OFL.txt or restore them"
        for p in fonts:
            assert any(p.name.startswith(prefix + "-") for prefix in FAMILIES), f"{p.relative_to(ROOT)} is a font the OFL notice does not cover"
        shipped = {pre for pre in FAMILIES if any(p.name.startswith(pre + "-") for p in fonts)}
        assert shipped == set(FAMILIES), f"{d.relative_to(ROOT)} ships {sorted(shipped)}; the notice covers {sorted(FAMILIES)}"


# ---- dependabot ------------------------------------------------------------------------------------------------------------------

DEPENDABOT = ROOT / ".github" / "dependabot.yml"
ECOSYSTEM_MARKER = {  # package-ecosystem -> a file that must exist in the directory it is pointed at
    "npm": ("package.json", "package-lock.json"),
    "pip": ("pyproject.toml",),
    "github-actions": (".github/workflows",),
}
UPDATE_KEYS = {
    "package-ecosystem", "directory", "directories", "schedule", "open-pull-requests-limit", "groups", "ignore", "labels",
    "commit-message", "reviewers", "assignees", "milestone", "target-branch", "versioning-strategy", "rebase-strategy",
    "pull-request-branch-name", "insecure-external-code-execution", "registries", "vendor", "allow", "cooldown",
    "enable-beta-ecosystems", "exclude-paths",
}
INTERVALS = {"daily", "weekly", "monthly", "quarterly", "semiannually", "yearly", "cron"}


def _updates() -> tuple[str, list[dict[str, str]]]:
    """(version, [one flat dict per `- package-ecosystem:` entry; nested keys are recorded as 'schedule.interval'])"""
    version, entries, cur, nest = "", [], None, ""
    for raw in DEPENDABOT.read_text().splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        ind = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if ind == 0:
            m = re.fullmatch(r"version:\s*(\S+)", line)
            if m:
                version = m.group(1)
            nest = ""
            continue
        if ind == 2 and line.startswith("- "):
            cur = {}
            entries.append(cur)
            line = line[2:]
            ind = 4
            nest = ""
        if cur is None:
            continue
        if ind > 4 and line.startswith("- "):
            # A list item inside groups: / ignore: (`- dependency-name: "x"`). Its keys are recorded under the block's name like any
            # other nested key; a bare scalar item carries no key and is skipped.
            line = line[2:]
            if not re.fullmatch(r"([\w-]+):\s*(.*)", line):
                continue
        m = re.fullmatch(r"([\w-]+):\s*(.*)", line)
        assert m, f"cannot read dependabot.yml line: {raw}"
        k, v = m.group(1), m.group(2).strip().strip("\"'")
        if ind == 4:
            nest = k if not v else ""
            cur[k] = v
        else:
            cur[f"{nest}.{k}" if nest else k] = v
    return version, entries


def test_dependabot_is_version_2_with_the_three_ecosystems_this_repository_uses():
    version, entries = _updates()
    assert version == "2"
    assert sorted(e["package-ecosystem"] for e in entries) == ["github-actions", "npm", "pip"]


def test_dependabot_entries_use_only_known_keys_and_intervals():
    _, entries = _updates()
    for e in entries:
        top = {k.split(".")[0] for k in e}
        assert top <= UPDATE_KEYS, f"{e['package-ecosystem']}: unknown dependabot keys {sorted(top - UPDATE_KEYS)}"
        assert "directory" in e or "directories" in e, f"{e['package-ecosystem']}: no directory"
        assert e.get("schedule.interval") in INTERVALS, f"{e['package-ecosystem']}: schedule.interval {e.get('schedule.interval')!r}"
        limit = e.get("open-pull-requests-limit")
        assert limit is None or (limit.isdigit() and int(limit) >= 0), limit


def test_every_directory_dependabot_watches_exists_and_holds_what_the_ecosystem_reads():
    _, entries = _updates()
    for e in entries:
        d = ROOT / e["directory"].lstrip("/")
        assert d.is_dir(), f"{e['package-ecosystem']}: directory {e['directory']!r} does not exist"
        for marker in ECOSYSTEM_MARKER[e["package-ecosystem"]]:
            assert (d / marker).exists(), f"{e['package-ecosystem']}: {e['directory']} has no {marker}"


def test_the_reference_build_copies_the_licence_so_a_fresh_run_does_not_delete_it():
    """public/reference is rebuilt from scratch by scripts/build-reference.sh and CI fails if a fresh run differs from the commit.
    A hand-placed public/reference/fonts/OFL.txt that the script does not write is deleted by that run (main went red this way)."""
    src = (ROOT / "scripts" / "build-reference.sh").read_text()
    assert 'cp app/fonts/OFL.txt "$OUT/fonts/OFL.txt"' in src


def test_dependabot_groups_updates_and_does_not_propose_framework_majors_as_updates():
    """The policy in .github/dependabot.yml: Actions move together, npm minor/patch move together, and a MAJOR of a package that
    must match Next's major, the Node runtime or the rendering/build configuration is a deliberate migration, not an update PR."""
    text = DEPENDABOT.read_text()
    version, entries = _updates()
    by = {e["package-ecosystem"]: e for e in entries}
    assert "groups" in by["github-actions"] and "groups" in by["npm"]
    npm_block = text[text.index('package-ecosystem: "npm"'):text.index('package-ecosystem: "pip"')]
    for name in ("eslint-config-next", "@types/node", "react", "react-dom", "@types/react", "@types/react-dom", "tailwindcss"):
        assert re.search(rf'dependency-name: "{re.escape(name)}"\s+update-types: \["version-update:semver-major"\]', npm_block), name
