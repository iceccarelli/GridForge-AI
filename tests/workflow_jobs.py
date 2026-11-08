"""A small reader for the parts of a GitHub Actions workflow that decide which status checks a pull request gets.

No YAML dependency, on purpose: the `test` job installs pytest and nothing else (the engine has no third-party packages), and a test
that skips when PyYAML is absent would skip in exactly the place it must run. The workflows in this repository use a plain subset of
YAML (block mappings, inline lists, `- item` lists), which is all this reads. Anything outside that subset RAISES instead of being
guessed at, so a future workflow edit that this cannot read fails loudly rather than silently changing what is "always required".

What it answers: which check contexts does GitHub report for a workflow, and which of them are reported on EVERY pull request - the
only ones a branch ruleset may require. A required check that a path filter or an `if:` can prevent from ever starting is a pull
request that waits for ever.
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from pathlib import Path

#: filters that stop a pull_request workflow from starting on some pull requests
PR_FILTER_KEYS = {"paths", "paths-ignore", "branches", "branches-ignore", "types"}


class UnreadableWorkflow(Exception):
    pass


@dataclass
class Job:
    key: str
    name: str | None = None
    condition: str | None = None
    needs: list[str] = field(default_factory=list)
    matrix: dict[str, list[str]] = field(default_factory=dict)

    def contexts(self) -> list[str]:
        """The check names GitHub reports: the job name, plus ' (v1, v2)' for each matrix combination."""
        base = self.name or self.key
        if not self.matrix:
            return [base]
        combos = list(itertools.product(*self.matrix.values()))
        out = []
        for combo in combos:
            if "${{" in base:
                n = base
                for dim, val in zip(self.matrix, combo):
                    n = re.sub(r"\$\{\{\s*matrix\." + re.escape(dim) + r"\s*\}\}", val, n)
                if "${{" in n:
                    raise UnreadableWorkflow(f"job {self.key}: name uses an expression this reader does not evaluate: {base}")
                out.append(n)
            else:
                out.append(f"{base} ({', '.join(combo)})")
        return out


@dataclass
class Workflow:
    path: Path
    #: event name -> {filter key: raw text} (empty dict = no filter)
    triggers: dict[str, dict[str, str]]
    jobs: dict[str, Job]

    def runs_on_every_pull_request(self) -> bool:
        return "pull_request" in self.triggers and not (set(self.triggers["pull_request"]) & PR_FILTER_KEYS)

    def always_reported_jobs(self) -> list[Job]:
        """Jobs that start on every pull request: the workflow has no pull_request filter and the job (and what it needs) has no `if:`."""
        if not self.runs_on_every_pull_request():
            return []
        ok: dict[str, bool] = {}

        def eligible(k: str, seen: tuple[str, ...] = ()) -> bool:
            if k in ok:
                return ok[k]
            if k in seen or k not in self.jobs:
                raise UnreadableWorkflow(f"{self.path.name}: job {k} needs an unknown or circular job")
            j = self.jobs[k]
            ok[k] = j.condition is None and all(eligible(n, (*seen, k)) for n in j.needs)
            return ok[k]

        return [j for k, j in self.jobs.items() if eligible(k)]

    def all_contexts(self) -> list[str]:
        return [c for j in self.jobs.values() for c in j.contexts()]

    def always_reported_contexts(self) -> list[str]:
        return [c for j in self.always_reported_jobs() for c in j.contexts()]


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _meaningful(lines: list[str]) -> list[str]:
    return [ln.rstrip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]


def _inline_list(raw: str) -> list[str]:
    raw = raw.strip()
    if not (raw.startswith("[") and raw.endswith("]")):
        raise UnreadableWorkflow(f"expected an inline list, got: {raw}")
    return [x.strip().strip("'\"") for x in raw[1:-1].split(",") if x.strip()]


def _strip_comment(v: str) -> str:
    # a ` #` outside quotes starts a comment; the values read here never contain a quoted ' #'
    return re.sub(r"\s+#.*$", "", v).strip()


def _top_level_blocks(text: str) -> dict[str, tuple[str, list[str]]]:
    blocks: dict[str, tuple[str, list[str]]] = {}
    cur: str | None = None
    for ln in text.splitlines():
        if not ln.strip() or ln.lstrip().startswith("#"):
            if cur is not None:
                blocks[cur][1].append(ln)
            continue
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", ln) if _indent(ln) == 0 else None
        if m:
            cur = m.group(1)
            blocks[cur] = (_strip_comment(m.group(2)), [])
        elif cur is not None:
            blocks[cur][1].append(ln)
    return blocks


def _parse_triggers(inline: str, body: list[str]) -> dict[str, dict[str, str]]:
    if inline:
        names = _inline_list(inline) if inline.startswith("[") else [inline.strip("'\"")]
        return {n: {} for n in names}
    triggers: dict[str, dict[str, str]] = {}
    cur: str | None = None
    for ln in _meaningful(body):
        ind = _indent(ln)
        m = re.match(r"^\s*([\w-]+):\s*(.*)$", ln)
        if ind == 2 and m:
            cur = m.group(1)
            triggers[cur] = {}
        elif ind == 4 and cur and m:
            triggers[cur][m.group(1)] = _strip_comment(m.group(2))
    return triggers


def _parse_matrix(lines: list[str]) -> dict[str, list[str]]:
    matrix: dict[str, list[str]] = {}
    i = 0
    while i < len(lines):
        m = re.match(r"^\s*([\w-]+):\s*(.*)$", lines[i])
        if not m:
            raise UnreadableWorkflow(f"cannot read matrix line: {lines[i]}")
        key, val = m.group(1), _strip_comment(m.group(2))
        if key in {"include", "exclude"}:
            raise UnreadableWorkflow("matrix include/exclude is not read by this helper; extend it before using one")
        if val:
            matrix[key] = _inline_list(val)
        else:
            items = []
            j = i + 1
            while j < len(lines) and lines[j].lstrip().startswith("- "):
                items.append(lines[j].lstrip()[2:].strip().strip("'\""))
                j += 1
            matrix[key] = items
            i = j - 1
        i += 1
    return matrix


def _parse_job(key: str, body: list[str]) -> Job:
    job = Job(key=key)
    lines = _meaningful(body)
    i = 0
    while i < len(lines):
        ln = lines[i]
        ind = _indent(ln)
        m = re.match(r"^\s*([\w-]+):\s*(.*)$", ln)
        if ind == 4 and m:
            k, v = m.group(1), _strip_comment(m.group(2))
            if k == "name":
                job.name = v.strip("'\"")
            elif k == "if":
                job.condition = v
            elif k == "needs":
                job.needs = _inline_list(v) if v.startswith("[") else [v] if v else []
                j = i + 1
                while not v and j < len(lines) and lines[j].lstrip().startswith("- "):
                    job.needs.append(lines[j].lstrip()[2:].strip())
                    j += 1
            elif k == "strategy":
                j = i + 1
                block = []
                while j < len(lines) and _indent(lines[j]) > 4:
                    block.append(lines[j])
                    j += 1
                mi = next((n for n, b in enumerate(block) if re.match(r"^\s{6}matrix:\s*$", b)), None)
                if mi is not None:
                    mat = []
                    for b in block[mi + 1:]:
                        if _indent(b) <= 6:
                            break
                        mat.append(b)
                    job.matrix = _parse_matrix(mat)
                elif any(re.match(r"^\s{6}matrix:\s*\S", b) for b in block):
                    raise UnreadableWorkflow(f"job {key}: a non-block matrix is not read by this helper")
        i += 1
    return job


def parse_workflow_text(text: str, path: Path = Path("<text>")) -> Workflow:
    blocks = _top_level_blocks(text)
    # YAML 1.1 turns a bare `on` into a boolean, but GitHub reads it as the key; either way the source line is `on:`
    if "on" not in blocks:
        raise UnreadableWorkflow(f"{path}: no `on:` block")
    triggers = _parse_triggers(*blocks["on"])
    jobs: dict[str, Job] = {}
    if "jobs" in blocks:
        cur: str | None = None
        body: list[str] = []
        for ln in blocks["jobs"][1]:
            m = re.match(r"^  ([\w-]+):\s*$", ln)
            if m:
                if cur is not None:
                    jobs[cur] = _parse_job(cur, body)
                cur, body = m.group(1), []
            elif cur is not None:
                body.append(ln)
        if cur is not None:
            jobs[cur] = _parse_job(cur, body)
    return Workflow(path=path, triggers=triggers, jobs=jobs)


def load_workflows(directory: Path) -> list[Workflow]:
    return [parse_workflow_text(p.read_text(), p) for p in sorted(directory.glob("*.yml"))]
